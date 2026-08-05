/**
 * Corvere War Room — servidor.
 *
 * Descubre la flota de sesiones de Claude Code leyendo los transcripts JSONL,
 * decide si cada una está trabajando / esperándote / cerrada, y emite el estado
 * por SSE. Solo lectura: no escribe nada en ~/.claude.
 *
 * Escucha SIEMPRE en 127.0.0.1. Los transcripts contienen todo el trabajo de
 * cada proyecto, así que este panel no se asoma a la red local.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
// eslint-disable-next-line no-unused-vars -- lo usa claveIngest()
const PROJECTS = path.join(HOME, '.claude', 'projects');
const TASKS = path.join(HOME, '.claude', 'tasks');
const TEAMS = path.join(HOME, '.claude', 'teams');
const PUBLIC = path.join(import.meta.dirname, 'public');

/*
 * IMPACT-OK: añadido aditivo. Mapeado antes de tocar: el enrutado son comparaciones de
 * `url.pathname` en createServer (líneas ~1117-1162) y el resto cae al servidor de
 * ficheros estáticos; esto añade una rama más y no toca ninguna existente. Nada en
 * `public/` depende todavía de ella. No hay producción implicada: es un panel local.
 *
 * El grafo del código (APPs/CORVERE_GRAPH) es OPCIONAL. Vive en un fichero JSON que
 * exporta él mismo, no en su SQLite: el README de este panel promete "Node 20 o más
 * nuevo y nada más", y `node:sqlite` no existe en Node 20. Si el fichero no está (por
 * ejemplo en el Windows de referencia, donde no hay grafo), esto devuelve null, la vista no
 * aparece y el War Room funciona exactamente igual que antes.
 */
const GRAFO_JSON = process.env.WARROOM_GRAFO_JSON ||
  path.join(import.meta.dirname, '..', 'CORVERE_GRAPH', 'data', 'warroom.json');

async function leerGrafo() {
  try {
    return JSON.parse(await fsp.readFile(GRAFO_JSON, 'utf8'));
  } catch {
    return null;
  }
}

const PORT = Number(process.env.WARROOM_PORT || 7777);
const HOST = '127.0.0.1';

/**
 * Ajustes que no viven en el repo. Se buscan por orden: variable de entorno,
 * `~/.config/warroom/env` y `~/.config/corvere/env` (el nombre antiguo, que se
 * mantiene para no dejar sin alertas a una instalación ya en marcha). El
 * formato del fichero es `CLAVE=valor`, una por línea, y conviene dejarlo en
 * 600: aquí es donde vive la clave del pipeline de avisos.
 */
const CONFIG = [path.join(HOME, '.config', 'warroom', 'env'),
                path.join(HOME, '.config', 'corvere', 'env')];

function ajuste(...nombres) {
  for (const n of nombres) if (process.env[n]) return process.env[n].trim();
  for (const f of CONFIG) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const n of nombres) {
      const m = txt.match(new RegExp(`^${n}=(.+)$`, 'm'));
      if (m) return m[1].trim();
    }
  }
  return null;
}
const SCAN_MS = 3000;          // barrido de la flota
const PUSH_MS = 1000;          // envío a los clientes
// Al descubrir un transcript arrancamos por la cola, no por el principio: hay
// ficheros de 6 MB y son 1,4 GB en total. Del líder leemos más porque ahí están
// los spawns que dan nombre a los agentes anónimos.
const TAIL_LEAD = 4 * 1024 * 1024;
const TAIL_SUB = 512 * 1024;
const MAX_AGE_H = 36;          // transcripts más viejos ni se miran
const WORKING_S = 45;          // sin escribir más de esto ya no está "trabajando"
const MSG_KEEP = 40;
const ACT_KEEP = 18;

const PAL = ['#9810FA', '#E60076', '#00E68C', '#FFB547', '#6fb1ff',
             '#c084fc', '#ff9ec9', '#00c2b8', '#f97362', '#8b8ef7'];

/* Modo demostración: sirve una flota inventada en lugar de tus transcripts, para
   que quien clone esto vea el panel lleno sin tener sesiones abiertas, y para
   sacar las capturas del README sin enseñar nombres reales. El módulo solo se
   carga si se pide, así que en uso normal ni existe. */
const DEMO = ajuste('WARROOM_DEMO') === '1';
const demo = DEMO ? await import('./demo.mjs') : null;

/** sessionId -> estado acumulado */
const sessions = new Map();
/** ruta -> offset de lectura */
const cursors = new Map();
/** ruta -> cabecera cacheada */
const heads = new Map();
/** ruta de subagente -> misión deducida de su prompt inicial */
const missions = new Map();
let fleetError = null;
/** Lo que el panel NO puede saber ahora mismo, dicho en la barra. */
let avisoFuentes = null;

const now = () => Date.now() / 1000;
const AGENT_FILE = /^agent-a([A-Za-z][\w-]*?)-[0-9a-f]{12,}$/;

/* ─────────────────────────── utilidades ─────────────────────────── */

function tsOf(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t / 1000;
}

/** Resumen legible de la llamada a una herramienta. */
function detail(name, input) {
  if (!input || typeof input !== 'object') return '';
  const base = (p) => String(p || '').split('/').pop();
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return base(input.file_path);
    case 'Bash':
      return String(input.command || '').replace(/\s+/g, ' ').slice(0, 70);
    case 'Grep':
      return String(input.pattern || '').slice(0, 50);
    case 'Glob':
      return String(input.pattern || '').slice(0, 50);
    case 'ToolSearch':
      return String(input.query || '').slice(0, 50);
    case 'TodoWrite': case 'TaskUpdate':
      return 'actualiza el plan';
    case 'Agent':
      return String(input.description || input.subagent_type || '').slice(0, 50);
    case 'WebFetch': case 'WebSearch':
      return String(input.url || input.query || '').slice(0, 50);
    default: {
      const v = Object.values(input)[0];
      return v == null ? '' : String(v).replace(/\s+/g, ' ').slice(0, 50);
    }
  }
}

/** Primeras líneas de un transcript: de ahí sale el cwd real de la sesión. */
async function readHead(file) {
  const cached = heads.get(file);
  if (cached) return cached;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.cwd) {
          const head = { cwd: o.cwd, gitBranch: o.gitBranch || '' };
          heads.set(file, head);
          return head;
        }
      } catch { /* línea parcial, seguimos */ }
    }
  } catch { /* ilegible */ } finally { await fh?.close(); }
  return null;
}

/**
 * Un subagente sin nombre propio se identifica por su misión: la primera línea
 * con sustancia del prompt que le pasó el líder.
 */
async function readMission(file) {
  if (missions.has(file)) return missions.get(file);
  let title = '';
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(8 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user') continue;
      const c = o.message?.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : '';
      // La primera línea suele ser la cabecera del framework y es idéntica para
      // todos ("COUNCIL CORVERE — MODO RESOLVER"). Buscamos la que distingue.
      const GENERIC = /^(council|eres |estás|tu (rol|misión|trabajo)|contexto|instrucciones|\*\*)/i;
      const cands = text.split('\n')
        .map((l) => l.replace(/^[#*\s>-]+/, '').replace(/\*\*/g, '').trim())
        .filter((l) => l.length > 10 && l.length < 120)
        .slice(0, 14);
      title = cands.find((l) => !GENERIC.test(l) && /[:·]|\d/.test(l))
           || cands.find((l) => !GENERIC.test(l))
           || cands[0] || '';
      title = title.replace(/\s+/g, ' ').slice(0, 56);
      break;
    }
  } catch { /* sin misión legible */ } finally { await fh?.close(); }
  missions.set(file, title);
  return title;
}

/**
 * Lee lo nuevo de un fichero desde el último offset. La primera vez arranca
 * por la cola: hay transcripts de 6 MB y no vamos a parsear 1,4 GB al arrancar.
 */
async function readNew(file, size, onLine, tail = TAIL_SUB) {
  let from = cursors.get(file);
  if (from === undefined) from = Math.max(0, size - tail);
  if (size < from) from = 0;           // el fichero se truncó o rotó
  if (size === from) return;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const tail = lines.pop();          // posible línea a medio escribir
    const partial = cursors.has(file) ? 0 : 1;  // primer arranque: descartar la 1ª
    for (const line of lines.slice(partial)) {
      if (!line.trim()) continue;
      try { onLine(JSON.parse(line)); } catch { /* ignoramos basura */ }
    }
    cursors.set(file, size - Buffer.byteLength(tail, 'utf8'));
  } catch { /* se lo lleva el siguiente barrido */ } finally { await fh?.close(); }
}

/* ─────────────────────────── estado de git ─────────────────────────── */

const gitCache = new Map();   // cwd -> { t, datos }
const GIT_TTL = 20;           // segundos

function git(cwd, args) {
  return new Promise((resolve) => {
    /* `windowsHide` no es cosmética: sin ella, en Windows cada `git` abre una
       ventana de consola que parpadea en pantalla. Son cuatro por repo cada
       GIT_TTL segundos, así que el panel acaba siendo un intermitente aunque
       nadie lo esté mirando. La misma precaución que en `ejecutar()`. */
    execFile('git', ['-C', cwd, ...args], { timeout: 4000, windowsHide: true, maxBuffer: 4 << 20 },
      (err, out) => resolve(err ? null : String(out)));
  });
}

/**
 * Trabajo sin guardar en el repo de esa sesión. Es la otra mitad del "dónde lo
 * dejaste": no solo qué estabas haciendo, sino qué te dejaste a medias. Un repo
 * con 79 ficheros sin commitear desde hace dos días no lo dice nadie más.
 */
async function estadoGit(cwd) {
  const ya = gitCache.get(cwd);
  if (ya && now() - ya.t < GIT_TTL) return ya.datos;
  gitCache.set(cwd, { t: now(), datos: ya?.datos || null });   // evita la estampida

  let datos = null;
  try {
    const dentro = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (dentro && dentro.trim() === 'true') {
      const [porcelain, ahead, ultimo] = await Promise.all([
        git(cwd, ['status', '--porcelain']),
        git(cwd, ['rev-list', '--count', '@{u}..HEAD']),
        git(cwd, ['log', '-1', '--format=%ct']),
      ]);
      const lineas = (porcelain || '').split('\n').filter((l) => l.trim());
      datos = {
        sucios: lineas.length,
        sinSeguir: lineas.filter((l) => l.startsWith('??')).length,
        sinSubir: ahead ? parseInt(ahead.trim(), 10) || 0 : 0,
        ultimoCommit: ultimo ? parseInt(ultimo.trim(), 10) || 0 : 0,
      };
    }
  } catch { /* no es un repo o git no responde */ }
  gitCache.set(cwd, { t: now(), datos });
  return datos;
}

/* ─────────────────── qué dice la bitácora del proyecto ─────────────────── */

const docCache = new Map();   // cwd -> { t, datos }
const DOC_TTL = 60;

/**
 * El `_state.md` de cada proyecto lleva en su frontmatter el estado declarado
 * (🟢 producción, 🟡 activo, 🟠 stand-by...). Sin esto el panel trata igual a
 * PULSE, que está en producción con code freeze, que a un proyecto personal.
 */
async function leerState(cwd) {
  const ya = docCache.get(cwd);
  if (ya && now() - ya.t < DOC_TTL) return ya.datos;
  let datos = null;
  try {
    const txt = await fsp.readFile(path.join(cwd, '_state.md'), 'utf8');
    const fin = txt.indexOf('\n---', 4);
    const front = txt.slice(0, fin > 0 ? fin : 4000);
    const m = front.match(/^estado:\s*(.+)$/m);
    if (m) {
      const linea = m[1].trim();
      // la marca `u` es obligatoria: sin ella la clase parte el emoji por la
      // mitad y sale medio surrogate (\ud83d) que ni siquiera es UTF-8 válido
      const sem = (linea.match(/^([🟢🟡🟠🔴⚫⚪])/u) || [])[1] || '';
      datos = {
        semaforo: sem,
        texto: linea.replace(/^[🟢🟡🟠🔴⚫⚪]\s*/u, '').replace(/\*\*/g, '').slice(0, 90),
      };
    }
  } catch { /* sin bitácora */ }
  docCache.set(cwd, { t: now(), datos });
  return datos;
}

/* ─────────────────────────── procesos vivos ─────────────────────────── */

/**
 * ¿Qué sesiones siguen abiertas?
 *
 * El transcript no lo dice: el de una sesión cerrada y el de una que lleva dos
 * horas esperándote son idénticos, en los dos casos el último apunte es viejo.
 * Hay que mirar fuera, y ninguna fuente sirve para todos los casos:
 *
 *  1. `claude agents --json` es la mejor cuando existe. Da el sessionId exacto,
 *     el nombre legible de la sesión y su estado, y funciona en las tres
 *     plataformas. Pero SOLO ve sesiones del CLI: medido contra la app de
 *     escritorio en Windows, con la app abierta y seis sesiones vivas, devuelve
 *     una lista vacía.
 *  2. La app de escritorio no abre un proceso por sesión, sino una sola
 *     aplicación con una docena de procesos y ningún directorio de trabajo por
 *     sesión, y no deja en disco ningún registro de lo que está activo
 *     (`sessions/` y `session-env/<uuid>/` están vacíos). Así que de ella solo
 *     se puede saber una cosa, que además es la que importa: si está corriendo.
 *     Mientras lo esté, ninguna de sus sesiones puede darse por cerrada.
 *  3. `/proc` en Linux, que es lo que había antes y sigue siendo el respaldo
 *     cuando el CLI es viejo y no tiene el subcomando `agents`.
 */
const HAY_PROC = process.platform === 'linux';

const ejecutar = (cmd, args, ms = 5000) => new Promise((listo) => {
  /* Dos cuidados, los dos aprendidos en un Windows de verdad:
     - un `.cmd` solo se puede lanzar a través del shell. Desde la corrección de
       CVE-2024-27980 Node se niega, y el `spawn EINVAL` que suelta NO llega por
       el callback sino como excepción, así que sin el try/catch se lleva por
       delante el barrido entero y el panel se queda en cero sesiones.
     - los argumentos aquí son constantes del propio código, nunca entrada
       ajena, que es lo que hace inofensivo el `shell`. */
  const porShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  try {
    execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 2 << 20, shell: porShell },
      (err, salida) => listo(err ? null : salida));
  } catch { listo(null); }
});

/* El CLI se consulta cada pocos segundos, no en cada barrido: es lanzar un
   proceso. Si no está instalado se deja de intentar durante un rato, por si
   aparece luego. */
let cacheCli = { t: 0, datos: null, falloHasta: 0 };

async function sesionesDelCli() {
  if (now() - cacheCli.t < 5) return cacheCli.datos;
  if (now() < cacheCli.falloHasta) return null;
  const binarios = process.platform === 'win32' ? ['claude.cmd', 'claude'] : ['claude'];
  for (const bin of binarios) {
    const salida = await ejecutar(bin, ['agents', '--json'], 8000);
    if (salida == null) continue;
    try {
      const lista = JSON.parse(salida);
      if (!Array.isArray(lista)) continue;
      const porId = new Map();
      for (const a of lista) if (a?.sessionId) porId.set(a.sessionId, a);
      cacheCli = { t: now(), datos: porId, falloHasta: 0 };
      return porId;
    } catch { /* salida que no era JSON */ }
  }
  cacheCli = { t: now(), datos: null, falloHasta: now() + 120 };
  return null;
}

/** ¿Corre la app de escritorio? Lo único observable de ella, y basta. */
let cacheApp = { t: 0, v: false };
async function appEscritorio() {
  if (now() - cacheApp.t < 10) return cacheApp.v;
  let viva = false;
  if (process.platform === 'win32') {
    const s = await ejecutar('tasklist', ['/fi', 'imagename eq Claude.exe', '/nh']);
    viva = !!s && /Claude\.exe/i.test(s);
  } else if (process.platform === 'darwin') {
    viva = !!(await ejecutar('pgrep', ['-x', 'Claude']));
  } else {
    // en Linux la app va aparte del CLI, que también se llama claude
    viva = !!(await ejecutar('pgrep', ['-f', 'claude-desktop']));
  }
  cacheApp = { t: now(), v: viva };
  return viva;
}

/** Sesiones abiertas = procesos `claude` vivos. Su cwd dice a qué proyecto van. */
async function liveCwds() {
  const out = new Map();   // cwd -> nº de procesos
  if (!HAY_PROC) return out;
  let pids;
  try { pids = await fsp.readdir('/proc'); } catch { return out; }
  await Promise.all(pids.map(async (pid) => {
    if (!/^\d+$/.test(pid)) return;
    try {
      const comm = (await fsp.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      if (comm !== 'claude') return;
      const cwd = await fsp.readlink(`/proc/${pid}/cwd`);
      out.set(cwd, (out.get(cwd) || 0) + 1);
    } catch { /* murió mientras mirábamos */ }
  }));
  return out;
}

/* ─────────────────────────── ingesta ─────────────────────────── */

function blankSession(id, cwd, branch) {
  return {
    id, cwd, branch,
    project: path.basename(cwd || '') || 'sin proyecto',
    agents: new Map(), messages: [], tasks: [], spawns: [],
    // ficheros ESCRITOS por esta sesión: es lo que permite ver si dos sesiones
    // del mismo repo se están pisando
    escritos: new Map(),
    acts: 0, up: 0, lat: 0, toks: 0,
    lastActivity: 0, startedAt: 0, status: 'closed',
    // el hilo principal es un trabajador más: la mayoría de las sesiones no
    // lanzan un solo agente y aun así hacen cientos de acciones
    lead: { last: '', lastAt: 0, tool: '', acts: 0, toks: 0, recent: [] },
  };
}

function agentOf(s, name) {
  let a = s.agents.get(name);
  if (!a) {
    a = { name, born: 0, last: 0, acts: 0, toks: 0, msgs: 0,
          action: '', tool: '', recent: [],
          color: PAL[s.agents.size % PAL.length], retired: false };
    s.agents.set(name, a);
  }
  return a;
}

/**
 * Un subagente anónimo se empareja con el spawn del líder más cercano en el
 * tiempo que siga sin dueño. De ahí salen su tipo y su descripción, que es lo
 * que de verdad distingue a diez miembros de un mismo council.
 */
function claimSpawn(s, a) {
  if (a.title || !a.born) return;
  let best = null, bestDist = Infinity;
  for (const sp of s.spawns) {
    if (sp.taken) continue;
    const dist = Math.abs(sp.t - a.born);
    if (dist < bestDist) { bestDist = dist; best = sp; }
  }
  if (best && bestDist < 180) {
    best.taken = true;
    a.title = best.desc || best.type;
    a.type = best.type;
  }
}

/** Procesa una línea de transcript. `who` es null para el líder. */
function ingest(s, who, o) {
  const t = tsOf(o.timestamp);
  if (!t) return;
  if (t > s.lastActivity) s.lastActivity = t;
  if (!s.startedAt || t < s.startedAt) s.startedAt = t;

  const msg = o.message;
  const outTok = msg?.usage?.output_tokens || 0;
  if (outTok) {
    s.toks += outTok;
    if (who) agentOf(s, who).toks += outTok;
    else s.lead.toks += outTok;
  }
  const content = msg?.content;
  if (!Array.isArray(content)) return;

  for (const b of content) {
    // Lo que el agente ESCRIBE mientras trabaja. El `thinking` se guarda vacío
    // (solo queda la firma), así que esto es lo más cerca del razonamiento que
    // hay: sin ello el stream es una lista de comandos sin hilo.
    if (b && b.type === 'text' && typeof b.text === 'string') {
      const dice = b.text.replace(/\s+/g, ' ').trim();
      if (dice.length > 25 && who) {
        const a = agentOf(s, who);
        a.last = t; a.dice = dice.slice(0, 300);
        a.recent.unshift({ t, tool: '✎', d: dice.slice(0, 160), dice: true });
        a.recent.length = Math.min(a.recent.length, ACT_KEEP);
      } else if (dice.length > 25) {
        s.lead.recent.unshift({ t, tool: '✎', d: dice.slice(0, 160), dice: true });
        s.lead.recent.length = Math.min(s.lead.recent.length, ACT_KEEP);
      }
      continue;
    }
    if (!b || b.type !== 'tool_use') continue;

    // el líder lanzando un agente: ahí nace
    if (!who && b.name === 'Agent') {
      const nm = b.input?.name;
      const type = b.input?.subagent_type || '';
      const desc = b.input?.description || '';
      if (nm) {
        const a = agentOf(s, nm);
        if (!a.born) a.born = t;
        a.last = t; a.type = type;
        a.action = desc || 'arrancando';
        a.tool = 'nace';
      } else {
        // sin nombre propio: lo emparejaremos con su transcript por cercanía
        s.spawns.push({ t, type, desc, taken: false });
        if (s.spawns.length > 60) s.spawns.shift();
      }
      continue;
    }

    if (b.name === 'SendMessage') {
      const from = who || 'team-lead';
      const to = String(b.input?.to || '');
      const lateral = from !== 'team-lead' && to !== 'team-lead' && to !== 'main';
      lateral ? s.lat++ : s.up++;
      s.messages.push({ t, from, to, lateral,
                        summary: String(b.input?.summary || '').slice(0, 110) });
      if (s.messages.length > MSG_KEEP) s.messages.shift();
      if (who) {
        const a = agentOf(s, who);
        a.msgs++; a.last = t; a.tool = 'envía';
        a.action = `→ ${to}`;
        a.recent.unshift({ t, tool: '✉', d: `${to} · ${b.input?.summary || ''}`.slice(0, 70), msg: true, lateral });
        a.recent.length = Math.min(a.recent.length, ACT_KEEP);
      }
      continue;
    }

    if (/^(Write|Edit|NotebookEdit)$/.test(b.name)) {
      const fp = b.input?.file_path;
      if (typeof fp === 'string' && fp) {
        s.escritos.set(fp, { t, quien: who || 'hilo principal' });
        if (s.escritos.size > 400) s.escritos.delete(s.escritos.keys().next().value);
      }
    }

    const d = detail(b.name, b.input);
    if (who) {
      const a = agentOf(s, who);
      if (!a.born) a.born = t;
      a.acts++; a.last = t; a.tool = b.name; a.action = d;
      a.recent.unshift({ t, tool: b.name, d });
      a.recent.length = Math.min(a.recent.length, ACT_KEEP);
    } else {
      s.lead.last = `${b.name} ${d}`.trim();
      s.lead.lastAt = t;
      s.lead.tool = b.name;
      s.lead.acts++;
      s.lead.recent.unshift({ t, tool: b.name, d });
      s.lead.recent.length = Math.min(s.lead.recent.length, ACT_KEEP);
    }
    s.acts++;
  }
}

/* ─────────────────────────── barrido ─────────────────────────── */

async function loadTasks(id) {
  const dir = path.join(TASKS, `session-${id.slice(0, 8)}`);
  try {
    const files = (await fsp.readdir(dir)).filter((f) => /^\d+\.json$/.test(f));
    files.sort((a, b) => parseInt(a) - parseInt(b));
    const out = [];
    for (const f of files) {
      try {
        const t = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
        out.push({ id: t.id, subject: String(t.subject || '').slice(0, 90),
                   status: t.status, owner: t.owner || '', blockedBy: t.blockedBy || [] });
      } catch { /* tarea ilegible */ }
    }
    return out;
  } catch { return []; }
}

async function hasTeam(id) {
  try { await fsp.access(path.join(TEAMS, `session-${id.slice(0, 8)}`)); return true; }
  catch { return false; }
}

async function scan() {
  const cutoff = now() - MAX_AGE_H * 3600;
  const best = new Map();   // sessionId -> {file, dir, size, mtime}

  let projDirs;
  try { projDirs = await fsp.readdir(PROJECTS); }
  catch (e) { fleetError = `No encuentro ${PROJECTS}`; return; }
  fleetError = null;

  await Promise.all(projDirs.map(async (pd) => {
    const dir = path.join(PROJECTS, pd);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs / 1000 < cutoff) continue;
      const id = e.name.slice(0, -6);
      const prev = best.get(id);
      // el mismo transcript aparece replicado en varios directorios: nos
      // quedamos con la copia mayor, que es la real
      if (!prev || st.size > prev.size) {
        best.set(id, { file, dir: path.join(dir, id), size: st.size, mtime: st.mtimeMs / 1000 });
      }
    }
  }));

  const live = await liveCwds();
  // ninguna de estas dos puede tumbar el barrido: si fallan, se sigue sin ellas
  const cli = await sesionesDelCli().catch(() => null);   // Map sessionId -> info
  const appViva = await appEscritorio().catch(() => false);
  const claimed = new Map();  // cwd -> cuántas sesiones ya marcamos abiertas

  /* Con la app de escritorio viva SIEMPRE hay algo que advertir, haya o no otra
     fuente: el CLI no ve sus sesiones y devuelve una lista vacía, así que fiarse
     de esa lista para darlas por muertas es justo el error a evitar. */
  const otraFuente = HAY_PROC || !!cli;
  avisoFuentes =
    appViva
      ? otraFuente
        ? { corto: 'sesiones de la app',
            largo: 'La app de escritorio está abierta: de sus sesiones no se sabe cuáles '
              + 'siguen vivas, así que las que lleven horas calladas pueden aparecer como '
              + 'cerradas. Las de terminal sí son exactas.' }
        : { corto: 'nada se da por cerrado',
            largo: 'La app de escritorio está abierta y no publica cuáles de sus sesiones '
              + 'siguen activas, y aquí no hay otra fuente: mientras corra, ninguna se '
              + 'marca como cerrada.' }
      : otraFuente ? null
      : { corto: 'sin detección de sesiones',
          largo: `Sin forma de saber qué sesiones siguen abiertas en ${process.platform}: `
            + 'instala el CLI de Claude Code, o ejecuta el panel dentro de WSL.' };

  const ordered = [...best.entries()].sort((a, b) => b[1].mtime - a[1].mtime);
  const seen = new Set();

  for (const [id, info] of ordered) {
    const head = await readHead(info.file);
    if (!head) continue;
    seen.add(id);
    let s = sessions.get(id);
    if (!s) { s = blankSession(id, head.cwd, head.gitBranch); sessions.set(id, s); }

    await readNew(info.file, info.size, (o) => ingest(s, null, o), TAIL_LEAD);

    // subagentes
    let mtimeAgentes = 0;
    try {
      const subDir = path.join(info.dir, 'subagents');
      for (const f of await fsp.readdir(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const stem = f.slice(0, -6);
        const m = AGENT_FILE.exec(stem);
        const name = m ? m[1] : stem.replace(/^agent-/, '').slice(0, 10);
        const sf = path.join(subDir, f);
        let st;
        try { st = fs.statSync(sf); } catch { continue; }
        mtimeAgentes = Math.max(mtimeAgentes, st.mtimeMs / 1000);
        await readNew(sf, st.size, (o) => ingest(s, name, o));
        if (!m) {
          const a = s.agents.get(name);
          if (a) {
            claimSpawn(s, a);
            if (!a.title) a.title = await readMission(sf);
          }
        }
      }
    } catch { /* sesión sin subagentes */ }

    /* Estado. Mirar solo el transcript del líder mentía: cuando despliega
       agentes se queda bloqueado esperándolos y no escribe (medido: hasta 22
       minutos con 12 agentes currando), así que la sesión salía como "te
       espera" estando a pleno rendimiento. Ahora cuenta la actividad de todos,
       y se distingue quién está parado. */
    const ahora = now();
    const actLider = Math.max(info.mtime, s.lead.lastAt || 0);
    const actAgentes = Math.max(mtimeAgentes,
      ...[...s.agents.values()].map((a) => a.last || 0), 0);
    const idleLider = ahora - actLider;
    const idleAgentes = ahora - actAgentes;
    const idle = Math.min(idleLider, actAgentes ? idleAgentes : Infinity);

    /* Abierta si alguna fuente fiable la ve. El CLI da certeza por sessionId;
       /proc solo sabe de cwd, así que reparte: dos sesiones en el mismo
       directorio y un único proceso significa que una de las dos ya no está. */
    const delCli = cli?.get(s.id) || null;
    if (delCli?.name) s.nombre = delCli.name;

    const procsHere = live.get(s.cwd) || 0;
    const used = claimed.get(s.cwd) || 0;
    const porProceso = used < procsHere;
    if (porProceso) claimed.set(s.cwd, used + 1);
    const abierta = !!delCli || porProceso;

    /* Y "cerrada" solo se puede AFIRMAR si teníamos forma de verlo.
       Donde hay /proc se afirma siempre: da certeza sobre las sesiones de
       terminal, que son la mayoría, y renunciar a ella porque la app de
       escritorio esté abierta en otra ventana resucita sesiones muertas de hace
       días. Fuera de Linux no hay esa certeza y manda la app: mientras corra, no
       se descarta ninguna de sus sesiones.

       Sin plazo de gracia, y es deliberado: una sesión del sidebar NO se cierra
       por llevar horas callada, sigue ahí para volver a ella. Poner un límite de
       tres horas dejaba el panel vacío en una máquina con seis sesiones abiertas
       de entre 6 y 31 h, que es justo el caso normal de quien trabaja a ratos.
       Lo que sí acota es `MAX_AGE_H`, la ventana general. */
    const podemosDescartar = HAY_PROC || (!!cli && !appViva);

    if (!abierta && podemosDescartar) s.status = 'closed';
    else if (idleLider < WORKING_S) s.status = 'working';
    // el líder callado pero los agentes vivos: tú estás libre, no te reclama
    else if (actAgentes && idleAgentes < WORKING_S) s.status = 'agents';
    else s.status = 'waiting';
    s.idle = idle;
    s.idleLider = idleLider;
    s.tasks = await loadTasks(id);
    s.hasTeam = await hasTeam(id);
    s.git = await estadoGit(s.cwd);
    s.doc = await leerState(s.cwd);

    for (const a of s.agents.values()) a.retired = now() - a.last > 240;
  }

  // sesiones que se salieron de la ventana: fuera de memoria
  for (const id of [...sessions.keys()]) if (!seen.has(id)) sessions.delete(id);
}

/* ─────────────────── avisos a un pipeline externo (opcional) ─────────────────── */

/**
 * Apagado salvo que se configure. El destino y la clave viven fuera del repo
 * (ver `ajuste()`): la clave porque es un secreto, y la URL porque apunta a la
 * infraestructura de quien lo use, no a la de nadie más.
 *
 *   WARROOM_ALERTAS=1
 *   WARROOM_ALERT_URL=https://…/mi-endpoint
 *   WARROOM_ALERT_KEY=…            (se envía en la cabecera x-admin-key)
 *
 * El cuerpo que se manda es `{ source, notify, severity, event_type, title,
 * message, metadata }`.
 */
const urlIngest = () => ajuste('WARROOM_ALERT_URL');
const claveIngest = () => ajuste('WARROOM_ALERT_KEY', 'OPS_ADMIN_KEY');

const yaAvisado = new Map();     // clave -> cuándo se avisó
const REPETIR = 6 * 3600;        // no repetir el mismo aviso antes de 6 h

/** Manda un aviso al endpoint configurado. Sin URL o sin clave, no hace nada. */
async function emitir(evento) {
  const url = urlIngest();
  const key = claveIngest();
  if (!url || !key || !ALERTAS_ON) return false;
  const clave = `${evento.event_type}|${evento.metadata?.sesion || ''}`;
  if (now() - (yaAvisado.get(clave) || 0) < REPETIR) return false;
  yaAvisado.set(clave, now());
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ source: 'war-room', notify: true, ...evento }),
      signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch { return false; }
}

/** Umbrales de los cuatro avisos aprobados. */
const UMBRAL = { olvidada: 3 * 3600, sinGuardar: 24 * 3600, atascado: 20 * 60 };
let ALERTAS_ON = ajuste('WARROOM_ALERTAS') === '1';

async function revisarAvisos() {
  if (!ALERTAS_ON) return;
  for (const s of sessions.values()) {
    if (s.status === 'waiting' && s.idle > UMBRAL.olvidada) {
      await emitir({
        severity: 'warning', event_type: 'warroom_sesion_olvidada',
        title: `Sesión olvidada en ${s.project}`,
        message: `Lleva ${Math.round(s.idle / 3600)} h esperándote. Última acción: ${s.lead.last || '—'}`,
        metadata: { sesion: s.id, proyecto: s.project, idle_s: Math.round(s.idle) },
      });
    }
    const g = s.git;
    if (g?.sucios && g.ultimoCommit && now() - g.ultimoCommit > UMBRAL.sinGuardar) {
      await emitir({
        severity: 'warning', event_type: 'warroom_trabajo_sin_guardar',
        title: `Trabajo sin commitear en ${s.project}`,
        message: `${g.sucios} ficheros sueltos y el último commit es de hace ${Math.round((now() - g.ultimoCommit) / 3600)} h`,
        metadata: { sesion: s.id, proyecto: s.project, sucios: g.sucios },
      });
    }
    for (const a of s.agents.values()) {
      if (!a.retired && a.last && now() - a.last > UMBRAL.atascado) {
        await emitir({
          severity: 'info', event_type: 'warroom_agente_atascado',
          title: `Agente parado en ${s.project}`,
          message: `${a.title || a.name} lleva ${Math.round((now() - a.last) / 60)} min sin dar señales`,
          metadata: { sesion: s.id, agente: a.name, proyecto: s.project },
        });
      }
    }
  }
}

/* ─────────────────── replay: la autopsia de una sesión ─────────────────── */

/**
 * Reconstruye una sesión entera desde su transcript: cuándo nació y murió cada
 * agente, qué hizo y qué mensajes cruzaron. Los transcripts no se borran, así
 * que una sesión cerrada hace semanas se puede volver a ver minuto a minuto.
 */
async function construirReplay(id, tope = 1200) {
  let mejor = null;
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS); } catch { return null; }
  for (const pd of dirs) {
    const f = path.join(PROJECTS, pd, `${id}.jsonl`);
    try {
      const st = fs.statSync(f);
      if (!mejor || st.size > mejor.size) mejor = { file: f, dir: path.join(PROJECTS, pd, id), size: st.size };
    } catch { /* aquí no está */ }
  }
  if (!mejor) return null;

  const head = await readHead(mejor.file);
  const eventos = [];
  const agentes = new Map();
  const spawnsSinNombre = [];

  const procesa = (linea, quien) => {
    let o;
    try { o = JSON.parse(linea); } catch { return; }
    const t = tsOf(o.timestamp);
    const c = o.message?.content;
    if (!t || !Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      if (!quien && b.name === 'Agent') {
        const nm = b.input?.name;
        if (nm) eventos.push({ t, k: 'nace', a: nm, d: b.input?.description || '', tipo: b.input?.subagent_type || '' });
        else spawnsSinNombre.push({ t, tipo: b.input?.subagent_type || '', desc: b.input?.description || '' });
        continue;
      }
      if (b.name === 'SendMessage') {
        eventos.push({ t, k: 'msg', a: quien || 'team-lead', to: String(b.input?.to || ''),
                       s: String(b.input?.summary || '').slice(0, 90) });
        continue;
      }
      eventos.push({ t, k: 'tool', a: quien || 'team-lead', n: b.name, d: detail(b.name, b.input) });
      if (quien) {
        const A = agentes.get(quien) || { n: quien, born: t, died: t, acts: 0 };
        A.died = t; A.acts++; A.born = Math.min(A.born, t);
        agentes.set(quien, A);
      }
    }
  };

  try {
    const texto = await fsp.readFile(mejor.file, 'utf8');
    for (const l of texto.split('\n')) if (l.trim()) procesa(l, null);
  } catch { return null; }

  try {
    for (const f of await fsp.readdir(path.join(mejor.dir, 'subagents'))) {
      if (!f.endsWith('.jsonl')) continue;
      const stem = f.slice(0, -6);
      const m = AGENT_FILE.exec(stem);
      const nombre = m ? m[1] : stem.replace(/^agent-/, '').slice(0, 10);
      const texto = await fsp.readFile(path.join(mejor.dir, 'subagents', f), 'utf8');
      for (const l of texto.split('\n')) if (l.trim()) procesa(l, nombre);
      // los anónimos heredan el título del spawn más cercano en el tiempo
      if (!m) {
        const A = agentes.get(nombre);
        if (A) {
          let cerca = null, dist = Infinity;
          for (const sp of spawnsSinNombre) {
            if (sp.tomado) continue;
            const dd = Math.abs(sp.t - A.born);
            if (dd < dist) { dist = dd; cerca = sp; }
          }
          if (cerca && dist < 180) { cerca.tomado = true; A.titulo = cerca.desc || cerca.tipo; A.tipo = cerca.tipo; }
        }
      }
    }
  } catch { /* sesión sin agentes */ }

  eventos.sort((a, b) => a.t - b.t);
  if (!eventos.length) return null;
  const t0 = eventos[0].t;
  const paso = Math.max(1, Math.ceil(eventos.filter((e) => e.k === 'tool').length / tope));
  let i = 0;
  const podados = eventos.filter((e) => e.k !== 'tool' || (i++ % paso === 0));

  return {
    id, cwd: head?.cwd || '', project: path.basename(head?.cwd || '') || '?',
    inicio: t0, duracion: eventos[eventos.length - 1].t - t0,
    agentes: [...agentes.values()].map((a) => ({
      ...a, born: Math.round(a.born - t0), died: Math.round(a.died - t0),
    })).sort((a, b) => a.born - b.born),
    eventos: podados.map((e) => ({ ...e, t: Math.round((e.t - t0) * 10) / 10 })),
  };
}

/* ─────────────────── el mapa del día: dónde se fue el tiempo ─────────────────── */

let diaCache = { t: 0, clave: '', datos: null };
const FRANJA = 15 * 60;          // resolución: cuarto de hora

/**
 * Actividad por franja de 15 minutos y por proyecto. Con dos a seis sesiones
 * saltando, el día entero en una tira dice más del coste de cambiar de contexto
 * que cualquier total.
 *
 * No parsea JSON: los transcripts pesan 1,4 GB y solo hacen falta las marcas de
 * tiempo, así que se sacan con una expresión regular sobre el texto.
 */
async function mapaDelDia(dias = 1) {
  const clave = `d${dias}`;
  if (now() - diaCache.t < 120 && diaCache.clave === clave) return diaCache.datos;

  const desde = Math.floor((now() - dias * 86400) / FRANJA) * FRANJA;
  const nFranjas = Math.ceil((now() - desde) / FRANJA) + 1;
  const porProyecto = new Map();
  const vistos = new Set();

  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS); } catch { return null; }

  for (const pd of dirs) {
    let entradas = [];
    try { entradas = await fsp.readdir(path.join(PROJECTS, pd)); } catch { continue; }
    for (const e of entradas) {
      if (!e.endsWith('.jsonl')) continue;
      const id = e.slice(0, -6);
      if (vistos.has(id)) continue;
      const file = path.join(PROJECTS, pd, e);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs / 1000 < desde) continue;
      vistos.add(id);

      const head = await readHead(file);
      const proyecto = path.basename(head?.cwd || pd) || '?';
      let barras = porProyecto.get(proyecto);
      if (!barras) { barras = new Array(nFranjas).fill(0); porProyecto.set(proyecto, barras); }

      try {
        const texto = await fsp.readFile(file, 'utf8');
        for (const m of texto.matchAll(/"timestamp":"([^"]+)"/g)) {
          const t = Date.parse(m[1]) / 1000;
          if (!t || t < desde) continue;
          const i = Math.floor((t - desde) / FRANJA);
          if (i >= 0 && i < nFranjas) barras[i]++;
        }
      } catch { /* ilegible */ }
    }
  }

  const datos = {
    desde, franja_s: FRANJA, franjas: nFranjas,
    proyectos: [...porProyecto.entries()]
      .map(([nombre, barras]) => ({
        nombre, barras,
        total: barras.reduce((a, b) => a + b, 0),
        activas: barras.filter((n) => n > 0).length,   // cuartos de hora con actividad
      }))
      .filter((p) => p.total > 5)
      .sort((a, b) => b.total - a.total),
  };
  diaCache = { t: now(), clave, datos };
  return datos;
}

/* ────────────────── espejo de reglas: ¿se cumple lo escrito? ────────────────── */

let reglasCache = { t: 0, datos: null };
const REGLAS_TTL = 15 * 60;
const DIAS_REGLAS = 30;

/**
 * Mide contra los transcripts si se trabaja como está decidido. No juzga
 * intenciones: cuenta llamadas. Una regla que se incumple una de cada cinco
 * veces no es una regla, es una sugerencia, y eso solo se ve con el número
 * delante.
 */
async function medirReglas() {
  if (now() - reglasCache.t < REGLAS_TTL && reglasCache.datos) return reglasCache.datos;

  const corte = now() - DIAS_REGLAS * 86400;
  const vistos = new Set();
  const agentes = new Map();
  let deployWrapper = 0, deployPat = 0, deployDirecto = 0;
  const councils = [];
  let sesiones = 0;

  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS); } catch { return null; }

  for (const pd of dirs) {
    let entradas = [];
    try { entradas = await fsp.readdir(path.join(PROJECTS, pd)); } catch { continue; }
    for (const e of entradas) {
      if (!e.endsWith('.jsonl')) continue;
      const id = e.slice(0, -6);
      if (vistos.has(id)) continue;
      const file = path.join(PROJECTS, pd, e);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs / 1000 < corte || st.size < 3000) continue;
      vistos.add(id);
      sesiones++;

      let texto = '';
      try { texto = await fsp.readFile(file, 'utf8'); } catch { continue; }
      const asientos = new Set();
      for (const linea of texto.split('\n')) {
        // filtro barato antes de parsear: el JSON.parse es lo caro
        const hayAgente = linea.includes('"Agent"');
        const hayDeploy = linea.includes('deploy-ef.sh') || linea.includes('functions deploy');
        if (!hayAgente && !hayDeploy) continue;
        let o;
        try { o = JSON.parse(linea); } catch { continue; }
        const c = o.message?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (!b || b.type !== 'tool_use') continue;
          if (b.name === 'Agent') {
            const t = b.input?.subagent_type || '(sin tipo)';
            agentes.set(t, (agentes.get(t) || 0) + 1);
            if (t.startsWith('council:')) asientos.add(t.replace('council:', ''));
          }
          if (b.name === 'Bash') {
            const cmd = String(b.input?.command || '');
            if (cmd.includes('deploy-ef.sh')) deployWrapper++;
            else if (/(npx\s+)?supabase\s+functions\s+deploy/.test(cmd)) {
              // §11 documenta el PAT canónico como vía legítima cuando el CLI
              // por defecto no tiene scope. Contarlo como incumplimiento era
              // acusar en falso: 135 de 136 eran esto.
              if (cmd.includes('SUPABASE_ACCESS_TOKEN')) deployPat++;
              else if (!/^\s*(echo|cat|grep|#)/.test(cmd)) deployDirecto++;
            }
          }
        }
      }
      if (asientos.size) councils.push({ id: id.slice(0, 8), asientos: [...asientos] });
    }
  }

  const total = [...agentes.values()].reduce((a, b) => a + b, 0);
  const generico = (agentes.get('general-purpose') || 0) + (agentes.get('(sin tipo)') || 0);
  const especialistas = [...agentes.entries()]
    .filter(([t]) => t.includes(':')).reduce((a, [, n]) => a + n, 0);

  const datos = {
    dias: DIAS_REGLAS, sesiones,
    agentes: {
      total, generico, especialistas,
      exploradores: (agentes.get('Explore') || 0) + (agentes.get('Plan') || 0),
      top: [...agentes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => ({ t, n })),
    },
    deploys: { wrapper: deployWrapper, pat: deployPat, directo: deployDirecto },
    councils: {
      total: councils.length,
      // §2.16: sin devil ni historian, y con menos de 4 asientos, no es un council
      bien: councils.filter((c) => c.asientos.includes('council-devil')
        && c.asientos.includes('council-historian') && c.asientos.length >= 4).length,
      detalle: councils.map((c) => ({ id: c.id, n: c.asientos.length })),
    },
  };
  reglasCache = { t: now(), datos };
  return datos;
}

/* ─────────────────────────── snapshot ─────────────────────────── */

function snapshot() {
  if (demo) return demo.flota(now());
  const list = [...sessions.values()]
    .filter((s) => s.status !== 'closed' || s.idle < 6 * 3600)
    .sort((a, b) => {
      // primero lo que se mueve, luego lo que te reclama, al final lo cerrado
      const rank = { working: 0, agents: 1, waiting: 2, closed: 3 };
      return (rank[a.status] - rank[b.status]) || (b.lastActivity - a.lastActivity);
    })
    .map((s) => ({
      id: s.id, nombre: s.nombre || '', project: s.project, cwd: s.cwd, branch: s.branch,
      status: s.status, idle: Math.round(s.idle || 0),
      idleLider: Math.round(s.idleLider || 0),
      acts: s.acts, up: s.up, lat: s.lat, toks: s.toks,
      startedAt: s.startedAt, lastActivity: s.lastActivity,
      hasTeam: s.hasTeam, git: s.git || null, doc: s.doc || null,
      // tareas que se quedaron a medias: lo que se pierde al saltar de proyecto
      colgando: s.tasks.filter((t) => t.status !== 'completed').length,
      // solo lo escrito hace poco: lo de hace horas ya no es una colisión
      escritos: [...s.escritos.entries()]
        .filter(([, v]) => now() - v.t < 45 * 60)
        .map(([ruta, v]) => ({ ruta, t: Math.round(v.t), quien: v.quien })),
      lead: { ...s.lead, recent: s.lead.recent.slice(0, ACT_KEEP) },
      tasks: s.tasks,
      messages: s.messages.slice(-MSG_KEEP),
      agents: [...s.agents.values()].map((a) => ({
        name: a.name, title: a.title || '', type: a.type || '',
        born: a.born, last: a.last, acts: a.acts, toks: a.toks,
        msgs: a.msgs, action: a.action, tool: a.tool, color: a.color, dice: a.dice || '',
        retired: a.retired, recent: a.recent.slice(0, ACT_KEEP),
      })),
    }));
  return { now: now(), error: fleetError,
           aviso: avisoFuentes?.largo || null, avisoCorto: avisoFuentes?.corto || null,
           sessions: list };
}

/* ─────────────────────────── http ─────────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const clients = new Set();

const server = http.createServer(async (req, res) => {
  /* Escuchar en 127.0.0.1 no basta por sí solo. Con *DNS rebinding* una web
     cualquiera hace que su dominio resuelva aquí, y entonces el navegador
     considera que el origen es suyo y puede LEER las respuestas: /api/state
     lleva tus proyectos, tus ramas y lo que escriben los agentes. Lo que corta
     eso es mirar la cabecera Host, no la interfaz de escucha. */
  const nombre = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(nombre)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('el war room solo atiende a este equipo');
  }

  const url = new URL(req.url, `http://${HOST}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
                         'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/alertas') {
    // consultar, con GET; cambiar, solo con POST. Un GET que muta lo dispara
    // cualquier web con un <img src> sin que te enteres.
    if (url.searchParams.has('on')) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
        return res.end('para cambiar el estado de los avisos, POST');
      }
      ALERTAS_ON = url.searchParams.get('on') === '1';
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      activas: ALERTAS_ON,
      hayClave: !!claveIngest(),
      hayDestino: !!urlIngest(),
      umbrales: { olvidada_h: UMBRAL.olvidada / 3600, sinGuardar_h: UMBRAL.sinGuardar / 3600, atascado_min: UMBRAL.atascado / 60 },
    }));
  }
  if (url.pathname === '/api/replay') {
    const id = url.searchParams.get('id') || '';
    const datos = /^[0-9a-f-]{8,}$/i.test(id) ? await construirReplay(id) : null;
    res.writeHead(datos ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos || { error: 'no encuentro esa sesión' }));
  }
  if (url.pathname === '/api/dia') {
    const datos = await mapaDelDia(Math.min(7, Number(url.searchParams.get('dias')) || 1));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos));
  }
  if (url.pathname === '/api/reglas') {
    const datos = await medirReglas();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos));
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(snapshot(), null, 2));
  }
  if (url.pathname === '/api/grafo') {
    const datos = await leerGrafo();
    res.writeHead(datos ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos || { ausente: true }));
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('no está');
  }
});

let scanning = false;
async function tick() {
  if (demo) return;      // en demostración no se lee ni un transcript
  if (scanning) return;
  scanning = true;
  try { await scan(); await revisarAvisos(); }
  catch (e) { fleetError = String(e.message || e); }
  finally { scanning = false; }
}

setInterval(tick, SCAN_MS);
setInterval(() => {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}, PUSH_MS);

await tick();
server.listen(PORT, HOST, () => {
  const n = sessions.size;
  console.log(`Corvere War Room  ·  http://${HOST}:${PORT}`);
  console.log(`${n} sesion${n === 1 ? '' : 'es'} en la ventana de ${MAX_AGE_H} h`);
});
