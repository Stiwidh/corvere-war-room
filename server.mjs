/**
 * Corvere War Room, servidor.
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
import { execFile, execFileSync, spawn } from 'node:child_process';
/* El historial de sesiones y sus nombres; escribe solo en ~/.local/state/warroom/.
 *
 * IMPACT-OK: cambio aditivo, mapeado a mano (el grafo no indexa este repo). `server.mjs` no
 * lo importa nadie: lo arrancan `package.json`, `warroom.service.in`, `windows/arrancar.cmd`
 * y `capturas.mjs` (en modo demo). Hacia fuera, `/api/state` y `/api/stream` ganan dos campos
 * por sesión (`alias`, `reanudar`) y no pierden ni renombran ninguno: quien ya lo lea desde
 * fuera sigue encontrando `nombre`, `project`, `status` y compañía igual. Las
 * rutas `/api/historial` y `/api/nombre` son nuevas. Sin producción implicada: panel local. */
import * as historial from './historial.mjs';
// consumo de tokens por día y por sesión; escribe solo ~/.local/state/warroom/tokens.json
import * as consumo from './consumo.mjs';

/*
 * Node 20.11 como mínimo, y el número importa: `import.meta.dirname` (que usa la línea de
 * abajo para encontrar `public/`) se añadió en 20.11.0 y 21.2.0, no en 20.0. Verificado
 * contra la documentación oficial, no de memoria.
 *
 * Sin esta comprobación, un Node 20.0 a 20.10 arranca y revienta con
 * `TypeError [ERR_INVALID_ARG_TYPE]: The "paths[0]" argument must be of type string`,
 * que no dice absolutamente nada del problema real. Decir "hace falta 20.11" cuesta seis
 * líneas y ahorra media hora de buscar por qué no encuentra los ficheros estáticos.
 */
const [MAYOR, MENOR] = process.versions.node.split('.').map(Number);
if (MAYOR < 20 || (MAYOR === 20 && MENOR < 11) || (MAYOR === 21 && MENOR < 2)) {
  console.error(
    `War Room necesita Node 20.11 o más nuevo, y este es el ${process.versions.node}.\n` +
    'El motivo concreto: `import.meta.dirname`, que llegó en 20.11.0 y 21.2.0.\n' +
    'Con nvm:  nvm install 22 && nvm use 22');
  process.exit(1);
}

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
 * nuevo y nada más", y `node:sqlite` no existe en Node 20. Si el fichero no está (que es
 * el caso en cualquier máquina donde no se haya generado), esto devuelve null, la vista
 * no aparece y el War Room funciona exactamente igual que antes.
 */
const GRAFO_JSON = process.env.WARROOM_GRAFO_JSON ||
  path.join(import.meta.dirname, '..', 'CORVERE_GRAPH', 'data', 'warroom.json');

/* Cada cuánto se vuelve a preguntar por las alertas del sistema que las emite.
 *
 * IMPACT-OK: dos constantes y una función nuevas dentro de `leerGrafo`, que es el
 * único punto por el que el panel obtiene el grafo (grep: lo llama `/api/grafo`).
 * No cambia su contrato: sigue devolviendo el JSON o null. Lo único que añade es un
 * disparo en segundo plano, calcado de `graph.py cmd_refrescar_si_toca`.
 *
 * POR QUÉ 10 MINUTOS Y NO LAS 6 HORAS DEL RESTO: la foto de producción se rehace
 * entera muy de tarde en tarde, y con razón, porque son 7 instancias y ~10 s para
 * refrescar tamaños, crons y Edge Functions que cambian una vez al día. Pero las
 * alertas cambian cada pocos minutos, y compartían esa cadencia. Resultado, el
 * 2026-08-10: se purgaron las alertas en el sistema de origen y este panel siguió
 * enseñando 39 abiertas cuando en la base quedaba 1. No era un fallo de la purga:
 * el número grande de la izquierda parece un dato en vivo y era una foto de hacía
 * casi cuatro horas.
 *
 * Refrescar solo las alertas es UNA consulta contra UNA instancia: 2,3 s medidos.
 * Por eso puede ir a esta cadencia sin arrastrar al resto del snapshot. */
const ALERTAS_TTL_MIN = 10;

/* De dónde sale la foto de producción. Es OPCIONAL y va por variable de entorno, igual
 * que `WARROOM_GRAFO_JSON`: la referencia de la instancia es de quien monta el panel, no
 * de este código, y sin ella el panel de producción sencillamente no aparece.
 *
 * IMPACT-OK: la constante tiene un único consumidor (`refrescarAlertasSiTocan`, que la lee
 * unas líneas más abajo) y nadie importa este fichero, es el servidor del panel. El
 * contrato no cambia: si el fichero no está, la lectura falla como ya fallaba en cualquier
 * máquina sin snapshot y la vista queda oculta. Sin producción implicada: es un panel local.
 *
 *   WARROOM_PROD_ESTADO=/ruta/al/<ref>.estado.json
 */
const ALERTAS_ESTADO = process.env.WARROOM_PROD_ESTADO || null;
let refrescandoAlertas = false;

/* Cómo acabó el refresco de alertas: la última vez que fue bien y la última que falló.
 *
 * IMPACT-OK: estado nuevo y aditivo. Lo escriben los handlers `exit` y `error` del hijo de
 * `refrescarAlertasSiTocan` (único llamador: `leerGrafo`, que no cambia de contrato) y lo
 * lee `/api/alertas`, que gana dos campos (`refresco_ok`, `refresco_fallo`, segundos epoch
 * o null) sin renombrar ni quitar ninguno; en `public/` nadie consume esa ruta todavía.
 * Fuera del repo y de ~/.claude, como `tokens.json` y `nombres.json`: temporal + rename y
 * permisos 600. Se carga al arrancar para que un reinicio no olvide el último fallo.
 * Sin producción implicada: panel local de solo lectura; la consulta que hace el hijo es
 * la misma de antes, esto solo apunta cómo acaba.
 *
 * El fallo: el hijo iba con stdio ignore y nadie miraba su código de salida. Si fallaba,
 * las alertas envejecían en silencio para siempre, que es justo el bug que motivó el TTL
 * de 10 minutos, pero ahora sin forma de verlo. */
const F_REFRESCO = path.join(HOME, '.local', 'state', 'warroom', 'refresco-alertas.json');
const refresco = (() => {
  try {
    const g = JSON.parse(fs.readFileSync(F_REFRESCO, 'utf8'));
    return { ok: Number(g.ok) || null, fallo: Number(g.fallo) || null, motivo: String(g.motivo || '') };
  } catch {
    return { ok: null, fallo: null, motivo: '' };
  }
})();

function anotarRefresco(bien, motivo) {
  const t = Math.round(Date.now() / 1000);
  if (bien) refresco.ok = t;
  else { refresco.fallo = t; refresco.motivo = motivo; }
  try {
    fs.mkdirSync(path.dirname(F_REFRESCO), { recursive: true });
    const tmp = `${F_REFRESCO}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(refresco), { mode: 0o600 });
    fs.renameSync(tmp, F_REFRESCO);
  } catch { /* sin disco: el dato sigue en memoria y en /api/alertas */ }
}

async function refrescarAlertasSiTocan() {
  // Un refresco a la vez: el panel recarga cada pocos segundos y sin esto lanzaría
  // un proceso por recarga mientras el anterior sigue vivo.
  if (refrescandoAlertas || !ALERTAS_ESTADO) return;
  let marca;
  try {
    const snap = JSON.parse(await fsp.readFile(ALERTAS_ESTADO, 'utf8'));
    marca = Date.parse(snap.alertas_actualizadas || '');
  } catch {
    return;                       // sin foto de producción (p. ej. fuera de esta máquina)
  }
  // Una marca ausente NO se trata como vieja: es una foto anterior a este cambio, y
  // dispararía un refresco en cada arranque sin que nadie lo haya pedido.
  if (!marca || Date.now() - marca < ALERTAS_TTL_MIN * 60_000) return;
  refrescandoAlertas = true;
  const hijo = spawn('python3', [GRAFO_CLI, 'alertas', '--refrescar'],
    { stdio: 'ignore', detached: true });
  /* Si el hijo no llega a arrancar (python3 no está), Node emite `error` y después puede
     emitir también `exit`: se apunta solo el primero, que es el que dice el motivo real.
     IMPACT-OK: ver F_REFRESCO arriba. Sin producción implicada: panel local de solo lectura. */
  let anotado = false;
  const acabar = (bien, motivo) => {
    refrescandoAlertas = false;
    if (anotado) return;
    anotado = true;
    anotarRefresco(bien, motivo);
  };
  hijo.on('exit', (codigo, senal) => acabar(codigo === 0, senal ? `señal ${senal}` : `código ${codigo}`));
  hijo.on('error', (e) => acabar(false, String(e?.code || e?.message || e)));
  hijo.unref();
}

async function leerGrafo() {
  try {
    const datos = JSON.parse(await fsp.readFile(GRAFO_JSON, 'utf8'));
    // Después de leer, nunca antes: el panel no se queda esperando a la consulta.
    // Lo que se enseña ahora puede ser de hace diez minutos; lo que no puede es ser
    // de hace cuatro horas sin que nadie vuelva a preguntar.
    void refrescarAlertasSiTocan();
    return datos;
  } catch {
    return null;
  }
}

/* IMPACT-OK: rama nueva en el router y dos constantes. No toca ninguna existente ni el
 * contrato de `/api/grafo`. Consumidor: un boton nuevo en `public/app.js`. Sin produccion
 * implicada: panel local que lee ficheros del grafo.
 *
 * El explorador (el grafo navegable, tipo vecindario) EXISTE en CORVERE_GRAPH desde el
 * 2026-08-05 y nunca se cableo aqui. El motivo no se llego a escribir y conviene que
 * quede: son 2,3 MB de HTML autocontenido, y las demas vistas viajan DENTRO del JSON que
 * el panel recarga cada pocos segundos. Meterlo ahi habria multiplicado por treinta el
 * peso de cada refresco para una vista que se abre de vez en cuando.
 *
 * Asi que se sirve aparte y bajo demanda: no lastra el panel y se regenera solo cuando el
 * indice es mas nuevo que el dibujo. */
const GRAFO_DIR = path.dirname(GRAFO_JSON);
const EXPLORADOR_HTML = path.join(GRAFO_DIR, 'explorador.html');
const GRAFO_CLI = path.join(GRAFO_DIR, '..', 'graph.py');

/* La regeneración del explorador que está en marcha, o null. Hace de candado, igual que
 * `refrescandoAlertas`, y además se puede esperar.
 *
 * IMPACT-OK: guarda nueva dentro de `explorador()`, cuyo único llamador es la rama
 * `/api/explorador` del router (consumidor: el botón de `public/app.js`). El contrato no
 * cambia: sigue devolviendo el HTML o null. Por qué es seguro: la primera petición lanza
 * el python como antes; las que llegan mientras corre esperan a ESA misma promesa en vez
 * de lanzar otro. Devolverles null enseñaría "sin grafo" sin serlo, que es peor que
 * esperar. El candado se suelta al acabar el hijo, vaya bien, mal o por timeout.
 * Sin producción implicada: panel local de solo lectura.
 *
 * El fallo: sin guarda, un doble clic lanzaba dos `graph.py explorador` a la vez, y el
 * segundo podía pisar el HTML que el primero estaba escribiendo. */
let explorandoEnVuelo = null;

async function explorador() {
  const mtime = async (p) => { try { return (await fsp.stat(p)).mtimeMs; } catch { return 0; } };
  const [dibujo, indice] = await Promise.all([
    mtime(EXPLORADOR_HTML), mtime(path.join(GRAFO_DIR, 'graph.db')),
  ]);
  if (!indice) return null;                      // no hay grafo en esta maquina
  if (!dibujo || dibujo < indice) {
    // Regenerar es del orden de segundos. Se hace sincrono a proposito: quien pulsa el
    // boton prefiere esperar a que salga bien antes que ver un dibujo de anteayer.
    if (!explorandoEnVuelo) {
      explorandoEnVuelo = new Promise((ok) => {
        execFile('python3', [GRAFO_CLI, 'explorador'], { timeout: 60000 }, () => ok());
      }).finally(() => { explorandoEnVuelo = null; });
    }
    await explorandoEnVuelo;
  }
  try {
    return await fsp.readFile(EXPLORADOR_HTML);
  } catch {
    return null;
  }
}

/* Las vistas del grafo acotadas a un proyecto. El cruce proyecto -> módulos lo hace el
   grafo, no este panel: aquí solo se pide y se sirve. Cachecito en memoria porque abrir y
   cerrar el detalle de la misma sesión no debería relanzar Python cada vez. */
const CACHE_PIEZAS = new Map();
const PIEZAS_TTL = 60000;
/* proyecto -> promesa del python que ya está calculando sus piezas.
 *
 * IMPACT-OK: deduplicación nueva dentro de `piezasDe()`, cuyo único llamador es la rama
 * `/api/piezas` (consumidor: el detalle de sesión en `public/app.js`). El contrato no
 * cambia: devuelve el texto de `graph.py piezas` o null, y la caché con TTL sigue igual.
 * Por qué es seguro: las peticiones del mismo proyecto que fallan caché mientras hay un
 * python en marcha esperan a ese y reciben su misma salida; la entrada se borra al acabar,
 * así que el Map nunca guarda más que lo que está corriendo.
 * Sin producción implicada: panel local de solo lectura.
 *
 * El fallo: la caché solo servía DESPUÉS de la primera respuesta. Abrir el detalle varias
 * veces seguidas antes de que contestara lanzaba un python por petición. */
const PIEZAS_EN_VUELO = new Map();

async function piezasDe(proyecto) {
  if (!proyecto) return null;
  const hit = CACHE_PIEZAS.get(proyecto);
  if (hit && Date.now() - hit.t < PIEZAS_TTL) return hit.v;
  const enVuelo = PIEZAS_EN_VUELO.get(proyecto);
  if (enVuelo) return enVuelo;
  const p = new Promise((ok) => {
    execFile('python3', [GRAFO_CLI, 'piezas', '--proyecto', proyecto, '--origen', 'warroom'],
      { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => ok(err ? null : stdout));
  }).then((salida) => {
    if (salida) CACHE_PIEZAS.set(proyecto, { t: Date.now(), v: salida });
    return salida;
  }).finally(() => { PIEZAS_EN_VUELO.delete(proyecto); });
  PIEZAS_EN_VUELO.set(proyecto, p);
  return p;
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

/*
 * PROCESOS EN SEGUNDO PLANO: un Bash con `run_in_background`, el que pasa de 120 s y se va
 * solo al fondo, y un Monitor. No son agentes (no tienen transcript propio), así que el
 * panel no los veía, y mientras corrían la sesión salía como "te espera" aunque fuera a
 * volver sola en cuanto acabaran.
 *
 * IMPACT-OK: estado nuevo y aditivo. Mapeado a mano (el grafo no indexa este repo): el
 * snapshot gana un campo `bg` por sesión y no cambia ni renombra ninguno. `status` sigue
 * teniendo los cuatro valores de siempre: un proceso pendiente pone la sesión en `agents`
 * (el líder callado y alguien suyo trabajando), que es lo que ya leen como "activa" los
 * hooks `warroom_pulso` y `warroom_briefing`; `warroom_bitacora` y
 * `warroom_collision_guardian` no miran el estado. En `public/` lo pintan `pulpos.js` y
 * `app.js`. Sin producción implicada: panel local de solo lectura.
 *
 * Los plazos están medidos el 2026-10-15 sobre todos los transcripts de la máquina: de
 * 876 Bash en segundo plano con aviso de cierre, la mediana tardó 3 min, el p90 26 min y
 * 54 pasaron de una hora, con una cola que llega a 3,8 días. Un Monitor dice él mismo
 * cuándo caduca, y se usa eso. Sin aviso de cierre (la sesión se reinició, o es un
 * servidor que no termina) un proceso deja de contar como trabajo pasada `BG_TOPE`, pero
 * se sigue pintando apagado hasta `BG_OLVIDO`.
 */
const BG_TOPE = 60 * 60;
const BG_RECUERDO = 10 * 60;   // lo que ya terminó se sigue viendo un rato
const BG_OLVIDO = 6 * 3600;
const BG_KEEP = 12;

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

/*
 * DIRECTORIO DE SESIONES POR PID: lo que permite ver hablar a dos sesiones.
 *
 * IMPACT-OK: bloque nuevo y aditivo. Mapeo transitivo hecho a mano sobre el repo entero
 * (17 ficheros, sin bundler): `server.mjs` no lo importa nadie, es el entrypoint del
 * servicio (consumidores: el script de `package.json`, `warroom.service.in`,
 * `windows/arrancar.cmd` y `capturas.mjs`, que lo arranca como subproceso en modo demo).
 * Su contrato hacia fuera es HTTP: `/api/stream`, `/api/replay`, `/api/dia`, `/api/grafo`
 * y `/api/piezas`, consumidos solo por `public/app.js` vía <script src> desde
 * `public/index.html`. Los campos que añado al snapshot son nuevos, ninguno se renombra
 * ni se quita, así que un `app.js` viejo sigue funcionando igual. Sin producción
 * implicada: panel local de solo lectura que no escribe nada en ~/.claude.
 *
 * Una sesión se direcciona por su socket, `uds:$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`, y
 * el nombre del fichero ES el pid del proceso. Eso da la otra punta de la conversación,
 * pero un pid no se puede enseñar: hay que traducirlo a sesión, nombre y proyecto. Tres
 * fuentes, y ninguna imprescindible:
 *
 *   1. `claude agents --json`: pid -> sessionId + nombre + cwd. La buena, cuando está.
 *   2. /proc: pid -> cwd. Sin sessionId, pero dice al menos a qué proyecto le hablas.
 *   3. El propio mensaje recibido, que trae `from-name="proyectos-d9"`. Es la única
 *      que sigue funcionando cuando la sesión de enfrente ya se cerró, y por eso el
 *      directorio NO se limpia: un mensaje de hace tres horas se tiene que poder
 *      atribuir aunque su emisor lleve dos horas muerto.
 */
const porPid = new Map();      // pid -> { sessionId, nombre, cwd, vivo, visto }
const porNombre = new Map();   // 'proyectos-d9' -> pid

function apuntarPid(pid, datos) {
  if (!pid) return null;
  const prev = porPid.get(pid) || { pid };
  const v = Object.assign(prev, datos, { visto: now() });
  porPid.set(pid, v);
  if (v.nombre) porNombre.set(v.nombre, pid);
  return v;
}

/** El pid que hay dentro de `uds:/run/user/1000/cc-socks/21890.sock`. */
const pidDeSocket = (addr) => {
  const m = /(?:^|\/)(\d+)\.sock$/.exec(String(addr || ''));
  return m ? Number(m[1]) : 0;
};

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
      // todos (del estilo "CONSEJO: MODO RESOLVER"). Buscamos la que distingue.
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
 * (🟢 producción, 🟡 activo, 🟠 stand-by...). Sin esto el panel trata igual a un
 * proyecto en producción y congelado que a uno personal recién empezado.
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

/*
 * Dónde buscar el binario, y por qué no basta con el PATH.
 *
 * Este panel se arranca como servicio de usuario, y systemd no hereda tu shell: el
 * servicio corre con `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:...`, donde
 * `claude` NO está, porque el instalador oficial lo pone en `~/.local/bin`. Resultado
 * medido el 2026-08-22 contra el proceso vivo: esta función devolvía null en cada
 * barrido, el panel llevaba semanas corriendo con una sola de sus dos fuentes, y por eso
 * ninguna sesión tenía nombre. No daba error: simplemente faltaba la mitad del dato.
 *
 * Con el CLI caído el panel funciona, pero pierde tres cosas: el nombre de cada sesión
 * (que es su dirección para escribirle), la certeza por sessionId, y la traducción
 * pid -> sesión que necesita todo lo de "entre sesiones". Así que se busca también en las
 * rutas donde el instalador lo deja de verdad.
 */
const BINARIOS_CLI = process.platform === 'win32'
  ? ['claude.cmd', 'claude']
  : ['claude',
     path.join(HOME, '.local', 'bin', 'claude'),
     path.join(HOME, '.claude', 'local', 'claude'),
     '/usr/local/bin/claude'];

async function sesionesDelCli() {
  if (now() - cacheCli.t < 5) return cacheCli.datos;
  if (now() < cacheCli.falloHasta) return null;
  // el que funcionó la última vez va primero: lo normal es acertar a la primera
  const binarios = cacheCli.bin
    ? [cacheCli.bin, ...BINARIOS_CLI.filter((b) => b !== cacheCli.bin)]
    : BINARIOS_CLI;
  for (const bin of binarios) {
    const salida = await ejecutar(bin, ['agents', '--json'], 8000);
    if (salida == null) continue;
    try {
      const lista = JSON.parse(salida);
      if (!Array.isArray(lista)) continue;
      const porId = new Map();
      for (const a of lista) {
        if (!a?.sessionId) continue;
        porId.set(a.sessionId, a);
        // aquí es donde el directorio aprende quién es cada pid
        apuntarPid(a.pid, { sessionId: a.sessionId, nombre: a.name || '', cwd: a.cwd || '' });
      }
      cacheCli = { t: now(), datos: porId, falloHasta: 0, bin };
      return porId;
    } catch { /* salida que no era JSON */ }
  }
  cacheCli = { t: now(), datos: null, falloHasta: now() + 120, bin: cacheCli.bin };
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
      // segunda fuente del directorio: sin sessionId, pero dice a qué proyecto
      // le estás hablando cuando el CLI no está disponible
      apuntarPid(Number(pid), { cwd, vivo: true });
    } catch { /* murió mientras mirábamos */ }
  }));
  return out;
}

/**
 * Qué sesiones siguen escuchando. El socket vive mientras vive el proceso, así que su
 * ausencia es lo que convierte un "le escribí" en un "le escribí y ya no está".
 */
const DIR_SOCKS = path.join(
  process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`, 'cc-socks');

async function socketsVivos() {
  let ficheros;
  try { ficheros = await fsp.readdir(DIR_SOCKS); }
  catch { return null; }   // Windows, o aquí no hay sockets: no se afirma nada
  const vivos = new Set();
  for (const f of ficheros) {
    const pid = pidDeSocket(f);
    if (pid) { vivos.add(pid); apuntarPid(pid, { vivo: true }); }
  }
  // solo con el listado en la mano se puede AFIRMAR que uno ya no está
  for (const [pid, v] of porPid) if (v.vivo && !vivos.has(pid)) v.vivo = false;
  return vivos;
}

/* ─────────────────────────── ingesta ─────────────────────────── */

function blankSession(id, cwd, branch) {
  return {
    id, cwd, branch,
    project: path.basename(cwd || '') || 'sin proyecto',
    agents: new Map(), messages: [], tasks: [], spawns: [],
    // conversación con OTRAS sesiones de Claude Code, que no son sus agentes:
    // otro proceso, otro contexto, otra ventana de terminal
    cruces: [], cross: 0,
    // ficheros ESCRITOS por esta sesión: es lo que permite ver si dos sesiones
    // del mismo repo se están pisando
    escritos: new Map(),
    acts: 0, up: 0, lat: 0, toks: 0,
    lastActivity: 0, startedAt: 0, status: 'closed',
    // el hilo principal es un trabajador más: la mayoría de las sesiones no
    // lanzan un solo agente y aun así hacen cientos de acciones
    lead: { last: '', lastAt: 0, tool: '', acts: 0, toks: 0, recent: [] },
    // turnos: cuándo le pediste algo, cuándo te devolvió la palabra y lo último que dijo
    inicioTurno: 0, ultimoHumano: 0, finTurno: null, ultimoDicho: '',
    // procesos en segundo plano por tool_use_id, y las llamadas que aún no han contestado
    bg: new Map(), bgLanzando: new Map(),
  };
}

/** "20m", "21m 40s", "1h 5m": la caducidad que anuncia un Monitor, en segundos. */
function duracionTexto(txt) {
  let seg = 0;
  for (const [, n, u] of String(txt || '').matchAll(/(\d+)\s*(h|m|s)\b/g)) {
    seg += Number(n) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);
  }
  return seg;
}

/**
 * El aviso de cierre de un proceso en segundo plano. Llega por tres caminos según lo que
 * estuviera haciendo la sesión (en la cola, como adjunto a mitad de turno o como turno
 * propio), y muchas veces por dos o tres a la vez: cerrar es idempotente y vale el primero.
 * Los eventos intermedios de un Monitor no traen `<status>` ni `<tool-use-id>`: solo dicen
 * que sigue vivo.
 */
function avisoDeProceso(s, t, txt) {
  for (const [, n] of txt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tid = /<task-id>([^<]+)<\/task-id>/.exec(n)?.[1];
    const uid = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(n)?.[1];
    const st = /<status>([^<]+)<\/status>/.exec(n)?.[1];
    const p = (uid && s.bg.get(uid)) || [...s.bg.values()].find((x) => x.id === tid);
    if (!p) continue;   // lanzado antes de la cola que hemos leído, o un agente
    if (!st || st === 'running') { p.evento = Math.max(p.evento || 0, t); continue; }
    if (!p.fin || t < p.fin) { p.fin = t; p.estado = st; }
  }
}

/** Sigue en marcha y cuenta como trabajo: sin cierre y dentro de su plazo. */
function bgPendiente(p, ahora) {
  if (p.fin) return false;
  return p.vence ? ahora < p.vence + 60 : ahora - p.lanzado < BG_TOPE;
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

/**
 * Un mensaje con OTRA sesión. No es un agente de esta: es otro proceso con su propio
 * contexto, y por eso no cuenta ni como `up` ni como `lat`, que miden lo que pasa
 * dentro de un equipo. Antes caía en `up` (el `to` no era 'team-lead') y el panel
 * enseñaba como "mensajes al líder" cuatro avisos que iban a otra ventana.
 */
function cruce(s, c) {
  s.cross++;
  s.cruces.push(c);
  if (s.cruces.length > MSG_KEEP) s.cruces.shift();
  return c;
}

/** El emisor sabe si su mensaje llegó, pero lo sabe una línea después, en el resultado. */
const cruceEsperando = new Map();   // tool_use_id -> cruce pendiente de acuse

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

  /* LO QUE LLEGA DE OTRA SESIÓN.
     El receptor no lo ve como una herramienta sino como un mensaje de usuario, y lo
     acompaña de un `origin` con lo que no está en ningún otro sitio: el pid verificado
     del proceso que escribe, su nombre, y el identificador del mensaje. Ese identificador
     es el que aparece también en el acuse del emisor, y es lo que permite saber que el
     "enviado" de una sesión y el "recibido" de la otra son el mismo mensaje y no dos.

     `kind: 'peer'` NO basta como discriminador: los subagentes usan el mismo canal (ahí
     `from` es "Explore" y trae `senderTaskId`). Lo que distingue a otra sesión es que su
     dirección sea un socket. */
  if (o.type === 'user' && !o.isSidechain) {
    const org = o.origin && typeof o.origin === 'object' ? o.origin : null;
    const addr = String(org?.from || '');
    const txt = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
      : '';
    // el `origin` es lo bueno; el parseo del texto cubre las versiones que no lo traían
    const viejo = !addr.startsWith('uds:') && txt.includes('<cross-session-message')
      && /<cross-session-message\s+from="([^"]*)"(?:\s+from-name="([^"]*)")?/.exec(txt);
    if (addr.startsWith('uds:') || viejo) {
      const pid = org?.verifiedPeerPid || pidDeSocket(addr || viejo[1]);
      const nombre = String(org?.name || (viejo ? viejo[2] : '') || '');
      apuntarPid(pid, nombre ? { nombre } : {});
      const cuerpo = String(org?.body
        || txt.slice(txt.indexOf('>', txt.indexOf('<cross-session-message')) + 1));
      const linea = cuerpo.split('\n').map((l) => l.replace(/^[#*\s>-]+/, '').trim())
        .find((l) => l.length > 12) || '';
      cruce(s, { t, dir: 'in', pid, addr: addr || viejo[1], nombre, ok: true,
                 msgId: String(org?.msg_id || ''),
                 summary: linea.replace(/\*\*/g, '').slice(0, 110) });
      return;   // no hay herramientas dentro de un mensaje entrante
    }
  }

  /* TURNOS DEL HILO PRINCIPAL, para el aviso de "terminó".
     Que el transcript deje de crecer NO dice que Claude haya acabado: un comando largo
     (un build, una prueba) tampoco escribe nada mientras corre. Lo que sí lo dice es que
     cierre su turno (`stop_reason: end_turn`), y eso queda escrito. Un mensaje tuyo es un
     `user` que no es resultado de herramienta ni texto del sistema (lo que empieza por `<`). */
  if (!who && !o.isSidechain) {
    if (o.type === 'user' && !o.isMeta) {
      const bloques = Array.isArray(content) ? content : null;
      const esResultado = bloques?.some((b) => b && b.type === 'tool_result');
      const texto = typeof content === 'string' ? content
        : bloques ? bloques.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join(' ') : '';
      if (!esResultado && texto.trim() && !texto.trim().startsWith('<')) {
        s.inicioTurno = t;
        if (t > s.ultimoHumano) s.ultimoHumano = t;
      }
    } else if (o.type === 'assistant' && msg?.stop_reason === 'end_turn' && s.inicioTurno) {
      s.finTurno = { t, dur: t - s.inicioTurno, visto: false, avisado: null };
      s.inicioTurno = 0;
    }
  }

  // el cierre de un proceso en segundo plano: cola, adjunto o turno propio
  const aviso = o.type === 'queue-operation' ? o.content
    : o.type === 'attachment' ? o.attachment?.prompt
    : o.type === 'user' && typeof content === 'string' ? content : '';
  if (typeof aviso === 'string' && aviso.includes('<task-notification>')) avisoDeProceso(s, t, aviso);

  if (!Array.isArray(content)) return;

  /* El acuse del envío llega en la línea siguiente, como resultado de la herramienta:
     ahí se ve si el socket seguía escuchando o si la otra sesión se había reiniciado y
     el mensaje se perdió sin más. Un envío fallido es justo lo que hay que ver. */
  for (const b of content) {
    if (!b || b.type !== 'tool_result') continue;
    /* ¿Se fue al fondo? Lo dice el resultado, no la llamada: un Bash sin
       `run_in_background` también acaba ahí si pasa de 120 s, o si llega un mensaje
       mientras corre. La marca va ANCLADA al principio: medido el 2026-10-15, los 1.242
       lanzamientos reales empiezan por ella, y suelta en cualquier sitio cazaba un `grep`
       en primer plano cuya salida citaba un lanzamiento (y lo dejaba una hora "en marcha"). */
    const lz = s.bgLanzando.get(b.tool_use_id);
    if (lz) {
      s.bgLanzando.delete(b.tool_use_id);
      const r = typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '';
      const m = /^(?:Command\b.{0,80}?(?:in background with ID: |moved to the background \(ID: )|Monitor started \(task )([a-z0-9]+)/
        .exec(r.trimStart().slice(0, 400));
      if (m) {
        const exp = /expires in ([^;)]*?) unless/.exec(r)?.[1];
        const ms = /, timeout (\d+)ms/.exec(r)?.[1];
        const dura = exp ? duracionTexto(exp) : ms ? Number(ms) / 1000 : 0;
        s.bg.set(b.tool_use_id, { id: m[1], tipo: lz.tipo, desc: lz.desc, quien: lz.quien,
                                  lanzado: lz.t, vence: dura ? lz.t + dura : 0,
                                  fin: 0, estado: '', evento: 0 });
      }
    }
    const pend = cruceEsperando.get(b.tool_use_id);
    if (!pend) continue;
    cruceEsperando.delete(b.tool_use_id);
    const txt = typeof b.content === 'string' ? b.content
      : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '';
    if (b.is_error || /"success"\s*:\s*false|Failed to send/.test(txt)) {
      pend.ok = false;
      pend.fallo = /stale|ENOENT|restarted/.test(txt) ? 'esa sesión ya no escucha' : 'no se pudo entregar';
    }
    // el identificador que la otra sesión guardará al recibirlo: la costura entre los dos
    const id = /"msg_id"\s*:\s*"([^"]+)"/.exec(txt);
    if (id) pend.msgId = id[1];
  }

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
        s.ultimoDicho = dice;
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

      /* ¿Va a otra SESIÓN o a un compañero de esta? Lo dice la dirección: un socket
         es un proceso aparte. No cuenta como `up` ni como `lat` porque esas dos miden
         el reparto DENTRO de un equipo, y aquí no hay equipo: hay dos ventanas. */
      const pid = to.startsWith('uds:') ? pidDeSocket(to) : 0;
      if (pid || to.startsWith('uds:')) {
        const c = cruce(s, { t, dir: 'out', pid, addr: to, quien: from, ok: true,
                             nombre: porPid.get(pid)?.nombre || '',
                             summary: String(b.input?.summary || '').slice(0, 110) });
        if (b.id) cruceEsperando.set(b.id, c);
        if (who) {
          const a = agentOf(s, who);
          a.last = t; a.tool = 'envía';
          a.recent.unshift({ t, tool: '✉', d: `otra sesión · ${c.summary}`.slice(0, 70), msg: true, cross: true });
          a.recent.length = Math.min(a.recent.length, ACT_KEEP);
        } else {
          s.lead.recent.unshift({ t, tool: '✉', d: `otra sesión · ${c.summary}`.slice(0, 70), msg: true, cross: true });
          s.lead.recent.length = Math.min(s.lead.recent.length, ACT_KEEP);
          s.lead.lastAt = t;
        }
        s.acts++;
        continue;
      }

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

    // todo Bash y todo Monitor pueden acabar en segundo plano: se apuntan hasta su resultado
    if ((b.name === 'Bash' || b.name === 'Monitor') && b.id) {
      s.bgLanzando.set(b.id, { t, tipo: b.name, quien: who || '',
        desc: String(b.input?.description || detail('Bash', b.input)).slice(0, 80) });
      if (s.bgLanzando.size > 50) s.bgLanzando.delete(s.bgLanzando.keys().next().value);
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
      /* El mismo transcript aparece replicado en varios directorios: nos quedamos con la
         copia mayor, que es la real.

         El desempate por ruta NO es cosmético. Estos directorios se recorren en paralelo,
         así que con tamaños IGUALES (que es lo normal: son copias byte a byte) ganaba el
         primero en llegar, y eso cambia de un barrido a otro. Como el cursor de lectura va
         por RUTA, al cambiar de copia se volvía a leer desde la cola: 4 MB releídos y todo
         lo que hay en ellos contado dos veces. Medido el 2026-08-22 sobre una sesión
         replicada en 11 directorios con 2,9 MB (por debajo del tail, o sea el fichero
         entero): el mismo mensaje entre sesiones aparecía dos veces en el panel, y las
         acciones y los tokens venían inflados sin que se notara. Con el desempate, la ruta
         elegida es siempre la misma y el cursor sirve para lo que se creó. */
      if (!prev || st.size > prev.size || (st.size === prev.size && file < prev.file)) {
        best.set(id, { file, dir: path.join(dir, id), size: st.size, mtime: st.mtimeMs / 1000 });
      }
    }
  }));

  const live = await liveCwds();
  // quién sigue escuchando en su socket: convierte "le escribí" en "le escribí y ya no está"
  await socketsVivos().catch(() => null);
  // acuses que nunca llegaron (la sesión se cerró a media herramienta): no se acumulan
  if (cruceEsperando.size > 200) cruceEsperando.clear();
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
  /* Rutas de transcript leídas en este barrido: lo que NO esté aquí sale de `heads`,
     `missions` y `cursors` al final (ver la poda de abajo). */
  const vivas = new Set();

  for (const [id, info] of ordered) {
    vivas.add(info.file);
    const head = await readHead(info.file);
    if (!head) continue;
    seen.add(id);
    let s = sessions.get(id);
    if (!s) { s = blankSession(id, head.cwd, head.gitBranch); sessions.set(id, s); }

    await readNew(info.file, info.size, (o) => ingest(s, null, o), TAIL_LEAD);

    // subagentes
    let mtimeAgentes = 0;
    const subDir = path.join(info.dir, 'subagents');
    try {
      for (const f of await fsp.readdir(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const stem = f.slice(0, -6);
        const m = AGENT_FILE.exec(stem);
        const name = m ? m[1] : stem.replace(/^agent-/, '').slice(0, 10);
        const sf = path.join(subDir, f);
        vivas.add(sf);
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
    } catch (e) {
      /* Sin subagentes es ENOENT. Cualquier otro fallo es "no he podido mirar", no "ya no
         hay": sus cursores se conservan, porque podarlos con la sesión aún en memoria haría
         releer la cola en el siguiente barrido y contar dos veces lo ya contado. */
      if (e?.code !== 'ENOENT') {
        for (const k of cursors.keys()) if (k.startsWith(subDir + path.sep)) vivas.add(k);
      }
    }

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

    // lo que se apagó del todo sale de memoria; lo demás se queda para pintarlo
    for (const [k, p] of s.bg) {
      if (p.fin ? ahora - p.fin > BG_RECUERDO : ahora - p.lanzado > BG_OLVIDO) s.bg.delete(k);
    }
    /* Un proceso pendiente es trabajo aunque nadie escriba: cuando acabe, la sesión
       vuelve sola. Antes salía "te espera" con dos descargas corriendo. */
    const bgVivos = [...s.bg.values()].filter((p) => bgPendiente(p, ahora)).length;

    if (!abierta && podemosDescartar) s.status = 'closed';
    else if (idleLider < WORKING_S) s.status = 'working';
    // el líder callado pero los agentes vivos: tú estás libre, no te reclama
    else if ((actAgentes && idleAgentes < WORKING_S) || bgVivos) s.status = 'agents';
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

  /* Y lo mismo con lo que se guarda por RUTA de fichero.
   *
   * IMPACT-OK: poda al final de `scan()`, mapeada a mano (el grafo no indexa este repo).
   * `heads`, `missions` y `cursors` son cachés privadas de este fichero: las escriben
   * `readHead`, `readMission` y `readNew`, y las leen esas mismas tres funciones (más
   * `construirReplay` y `mapaDelDia` vía `readHead`). Nadie importa `server.mjs` y ningún
   * campo de la API sale de ellas. Por qué es seguro: borrar una entrada solo obliga a
   * volver a calcularla. Una cabecera o una misión se releen del disco (16 y 8 KB); un
   * cursor perdido hace que el fichero, si reaparece, se lea desde la cola, que es lo
   * mismo que con cualquier fichero recién descubierto. Las rutas fuera de la ventana de
   * MAX_AGE_H también se podan: su sesión ya salió de `sessions` en la línea de arriba, así
   * que conservar su cursor solo servía para que, al volver, empezara en blanco y sin la
   * cola. Las cabeceras que piden el mapa del día y el replay para ficheros fuera de la
   * ventana caen en el siguiente barrido y se releen cuando vuelvan a pedirse.
   * `porPid` y `porNombre` NO se tocan: crecen a propósito (ver su cabecera).
   * Sin producción implicada: panel local de solo lectura.
   *
   * El fallo: las tres crecían con cada transcript que moría (Claude los borra a los 30
   * días) y nunca soltaban nada. El servicio iba por 465 MB residentes. */
  for (const mapa of [heads, missions, cursors]) {
    for (const ruta of [...mapa.keys()]) if (!vivas.has(ruta)) mapa.delete(ruta);
  }

  // lo que está abierto ahora es lo que habrá que reabrir si el equipo se apaga
  historial.anotarAbiertas([...sessions.values()]
    .filter((s) => s.status !== 'closed').map((s) => s.id));

  // con todos los transcritos ya leídos, cerrar las identidades que el CLI no puede dar
  emparejarPorMsgId();
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

/*
 * El filtro de 6 h SOBREVIVE al reinicio del panel.
 *
 * Vivía solo en memoria, con el argumento escrito de que "persistirlo costaría
 * más de lo que arregla para un panel que se reinicia poco". La premisa era
 * falsa del revés: se reinicia poco cuando todo va bien, y muchísimo justo
 * cuando el filtro importa. El 2026-08-05 el puerto 7777 se quedó ocupado por un
 * proceso anterior, el arranque murió con EADDRINUSE y systemd lo reintentó
 * cada 33 segundos: 991 reinicios en 9 horas, cada uno estrenando memoria. De
 * ahí salieron 876 emisiones del mismo aviso, casi una por arranque.
 *
 * Fuera del repo (es estado de la máquina, no código) y sin dependencias: un
 * JSON diminuto que se reescribe solo cuando algo entra o sale del filtro, o
 * sea como mucho una vez cada 6 h por aviso.
 */
const MEMORIA_AVISOS = path.join(HOME, '.local', 'state', 'warroom', 'avisos-emitidos.json');

function cargarMemoriaDeAvisos() {
  let crudo;
  try { crudo = fs.readFileSync(MEMORIA_AVISOS, 'utf8'); } catch { return; }
  let guardado;
  try { guardado = JSON.parse(crudo); } catch { return; }  // fichero a medias: se empieza limpio
  if (!guardado || typeof guardado !== 'object') return;
  const ahora = now();
  for (const [clave, cuando] of Object.entries(guardado)) {
    // Lo caducado no se recarga: no tiene efecto y solo haría crecer el fichero.
    if (typeof cuando === 'number' && ahora - cuando < REPETIR) yaAvisado.set(clave, cuando);
  }
}

function guardarMemoriaDeAvisos() {
  const datos = JSON.stringify(Object.fromEntries(yaAvisado));
  fsp.mkdir(path.dirname(MEMORIA_AVISOS), { recursive: true })
    .then(() => fsp.writeFile(MEMORIA_AVISOS, datos))
    .catch(() => {});  // sin disco, el filtro degrada a lo de antes; no tumba el panel
}

cargarMemoriaDeAvisos();

/** Manda un aviso al endpoint configurado. Sin URL o sin clave, no hace nada. */
async function emitir(evento) {
  const url = urlIngest();
  const key = claveIngest();
  if (!url || !key || !ALERTAS_ON) return false;
  const clave = `${evento.event_type}|${evento.metadata?.sesion || ''}`;
  if (now() - (yaAvisado.get(clave) || 0) < REPETIR) return false;
  yaAvisado.set(clave, now());
  guardarMemoriaDeAvisos();
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

/**
 * Cierra un aviso cuando su condición deja de cumplirse.
 *
 * IMPACT-OK: función nueva. Mapeado a mano (sin subagente, no solicitado): nadie importa
 * este fichero, es el servidor del panel. Usa el MISMO endpoint que `emitir` con
 * `resolve: true`, así que no reimplementa el pipeline de alertas de nadie: el receptor
 * es quien decide qué hacer con ellas, y nunca se escribe en su base directamente.
 * Verificado contra un receptor real, que ya acepta esta rama.
 *
 * El `title` tiene que ser IDÉNTICO al de la emisión: `ingest-alert` deriva la clave de
 * deduplicación del title cuando el evento no trae una entidad propia, así que un texto
 * distinto cerraría otra cosa (o nada).
 */
async function resolver(evento) {
  const url = urlIngest();
  const key = claveIngest();
  if (!url || !key || !ALERTAS_ON) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ source: 'war-room', resolve: true, notify: false, ...evento }),
      signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch { return false; }
}

/**
 * Un aviso emitido y su forma de cerrarlo, para no repetir el título en dos sitios (que
 * es justo como se desincronizan y se acaba cerrando otra alerta o ninguna).
 */
function avisosDe(s) {
  const g = s.git;
  /*
   * IMPACT-OK: fichero del servidor del panel, nadie lo importa (verificado con
   * grep). Solo cambia cuándo se emite y cuándo se cierra un aviso; no toca el
   * pipeline de alertas, que sigue siendo el POST a `ingest-alert`.
   *
   * "No he podido mirarlo" NO es "ya no pasa". `estadoGit` devuelve null cuando
   * git no responde (timeout de 4 s, carga, un `index.lock` de otra sesión), y
   * eso hacía que `cumple` pasara a false, se resolviera el aviso y se BORRARA
   * `yaAvisado`. Tres segundos después git contestaba, la condición volvía a
   * cumplirse y, sin memoria, se emitía otra vez: el filtro de 6 h no llegaba a
   * aplicarse nunca.
   *
   * Medido en producción el 2026-08-09: 2.140 repeticiones en 890 minutos (2,41
   * por minuto) del mismo aviso, y una alerta muriendo a las 14:14 para renacer
   * a las 14:15. Con el servicio 2 días sin reiniciarse, o sea con la memoria
   * intacta. El hecho era cierto (25 ficheros sin commitear desde hacía 62 h);
   * lo roto era repetirlo cada 25 segundos, que es lo que enseña a no mirar
   * (§0.34 del Suite, misma idea).
   */
  const noSeHaPodidoMirarElRepo = g === null || g === undefined;
  return [
    {
      cumple: s.status === 'waiting' && s.idle > UMBRAL.olvidada,
      severity: 'warning', event_type: 'warroom_sesion_olvidada',
      title: `Sesión olvidada en ${s.project}`,
      message: `Lleva ${Math.round(s.idle / 3600)} h esperándote. Última acción: ${s.lead.last || '-'}`,
      metadata: { sesion: s.id, proyecto: s.project, idle_s: Math.round(s.idle) },
    },
    {
      // null = no se sabe. Ni se emite ni se cierra hasta que git conteste.
      cumple: noSeHaPodidoMirarElRepo
        ? null
        : !!(g.sucios && g.ultimoCommit && now() - g.ultimoCommit > UMBRAL.sinGuardar),
      severity: 'warning', event_type: 'warroom_trabajo_sin_guardar',
      title: `Trabajo sin commitear en ${s.project}`,
      message: `${g?.sucios} ficheros sueltos y el último commit es de hace ${Math.round((now() - (g?.ultimoCommit || 0)) / 3600)} h`,
      metadata: { sesion: s.id, proyecto: s.project, sucios: g?.sucios },
    },
  ];
}

/** Umbrales de los cuatro avisos aprobados. */
/* `turnoLargo` y `ausencia` son del aviso de "terminó". Medido el 2026-09-30 sobre 14 días
   de transcripts: turnos cerrados de 10 min o más, mediana de 8 al día y 25 el día más
   cargado. Por eso no basta con la duración: solo se avisa si en `ausencia` segundos no has
   contestado a esa sesión ni escrito en ninguna otra, o sea, si no estás delante. */
const UMBRAL = { olvidada: 3 * 3600, sinGuardar: 24 * 3600, atascado: 20 * 60,
                 turnoLargo: 10 * 60, ausencia: 3 * 60 };
/* Los turnos cerrados antes de que arrancara el panel ya están vistos: al leer la cola de
   un transcript salen decenas de ellos, y avisar de todos al reiniciar sería absurdo. */
const ARRANQUE_PANEL = Date.now() / 1000;
/* APAGADO por defecto. Un aviso nuevo es una fila más en la base de quien los recibe, y eso
   se enciende a propósito, no llega solo con una actualización del panel. */
const AVISO_TERMINADA = ajuste('WARROOM_AVISO_TERMINADA') === '1';
let ALERTAS_ON = ajuste('WARROOM_ALERTAS') === '1';

/**
 * "Terminó": un turno largo que acaba y te devuelve la palabra sin que estés delante.
 *
 * Se decide `ausencia` segundos después del cierre, no en el momento: si para entonces le
 * has contestado, o has escrito en cualquier otra sesión, estás en el equipo y ya lo ves
 * (el panel, o el hook que avisa dentro de la sesión en la que escribes). Solo si no, sale.
 * Y se cierra en cuanto le contestas, que es también lo que rearma el aviso de esa sesión.
 */
async function avisoDeTurno(s) {
  if (!AVISO_TERMINADA) return;
  const evento = 'warroom_tarea_terminada';
  const clave = `${evento}|${s.id}`;
  const titulo = `Terminó en ${historial.nombreDe(s.id) || s.project}`;
  /* Se cierra en cuanto le contestas. Se mira en `yaAvisado`, que se guarda en disco, y
     no solo en la sesión en memoria: si el panel se reinicia con un aviso abierto, así lo
     sigue cerrando (y sin cerrarlo, el filtro de 6 h callaría el siguiente de esa sesión). */
  const emitido = yaAvisado.get(clave);
  if (emitido && s.ultimoHumano > emitido) {
    await resolver({ event_type: evento, title: s.finTurno?.avisado || titulo });
    yaAvisado.delete(clave);
    guardarMemoriaDeAvisos();
    if (s.finTurno?.avisado) s.finTurno = null;
    return;
  }
  const f = s.finTurno;
  if (!f || f.visto || f.avisado) return;
  if (f.t < ARRANQUE_PANEL || f.dur < UMBRAL.turnoLargo || s.ultimoHumano > f.t) { f.visto = true; return; }
  const edad = now() - f.t;
  if (edad < UMBRAL.ausencia) return;
  f.visto = true;
  // más tarde de lo previsto (el panel estuvo parado): ya no es un aviso a tiempo
  if (edad > UMBRAL.ausencia + 600) return;
  if ([...sessions.values()].some((o) => o.ultimoHumano > f.t)) return;   // estás delante
  const ok = await emitir({
    severity: 'info', event_type: evento, title: titulo,
    message: `${Math.round(f.dur / 60)} min trabajando y te ha devuelto el turno.`
      + (s.ultimoDicho ? ` Lo último: ${s.ultimoDicho.slice(0, 160)}` : ''),
    metadata: { sesion: s.id, proyecto: s.project, minutos: Math.round(f.dur / 60) },
  });
  if (ok) f.avisado = titulo;
}

async function revisarAvisos() {
  if (!ALERTAS_ON) return;
  for (const s of sessions.values()) {
    /*
      Los avisos de ESTADO se cierran solos cuando su condición desaparece. Hasta el
      2026-08-06 solo se emitían: `warroom_trabajo_sin_guardar` acumulaba 6 abiertas y
      CERO resueltas en toda su historia, porque commitear no se lo decía a nadie y la
      única salida era el barrido de antigüedad, a los SIETE días.

      Se cierra en la TRANSICIÓN, no en cada pasada: esto corre cada 3 s y llamar siempre
      sería un POST por sesión y por aviso cada tres segundos para no hacer nada el 99,9%
      de las veces. `yaAvisado` ya sabe qué se emitió, así que sirve de memoria.

      `yaAvisado` se persiste en disco desde el 2026-08-09 (ver MEMORIA_AVISOS), así que
      un reinicio ya no olvida lo emitido ni deja el aviso abierto hasta el barrido de los
      7 días. Antes sí, y eso convirtió un crash-loop de 991 arranques en 876 avisos.
    */
    for (const av of avisosDe(s)) {
      const clave = `${av.event_type}|${s.id}`;
      const { cumple, ...evento } = av;
      // `null` es "no se ha podido comprobar", que no es lo mismo que "ya no
      // pasa". Cerrar por no haber podido mirar borraba la memoria del filtro y
      // convertía un aviso legítimo en 2,41 repeticiones por minuto.
      if (cumple === null) continue;
      if (cumple) {
        await emitir(evento);
      } else if (yaAvisado.has(clave)) {
        await resolver({ event_type: evento.event_type, title: evento.title });
        yaAvisado.delete(clave);
        guardarMemoriaDeAvisos();
      }
    }
    await avisoDeTurno(s);
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

/*
 * Las líneas de un fichero que contienen alguna marca, sin descodificar el resto.
 *
 * IMPACT-OK: función nueva con un único llamador, `medirReglas`, que sigue devolviendo
 * exactamente el mismo objeto a `/api/reglas`. Es el patrón de `leerFichero` en
 * `consumo.mjs`: trozos de 4 MB, la marca se busca en bytes con Buffer.indexOf y solo se
 * convierte en texto la línea que la contiene. Por qué es seguro: las marcas son ASCII y
 * un byte ASCII nunca aparece dentro de un carácter UTF-8 multibyte, así que buscar en
 * bytes encuentra las mismas líneas que el `includes` sobre el texto. Una marca no lleva
 * salto de línea, así que si empieza antes del último `\n` del trozo, acaba antes; la
 * que cae después va en el resto que se arrastra al trozo siguiente, igual que la línea a
 * medias. Una línea con varias marcas se descodifica una sola vez: tras procesarla se
 * sigue buscando desde su final. La última línea sin `\n` se entrega también, como hacía
 * el `split` (si está a medias, el JSON.parse del llamador la descarta como antes).
 * Sin producción implicada: panel local de solo lectura.
 */
const TROZO_REGLAS = 4 * 1024 * 1024;
const MARCAS_REGLAS = ['"Agent"', 'deploy-ef.sh', 'functions deploy'].map((m) => Buffer.from(m));

async function lineasConMarca(file, marcas, onLinea) {
  const fh = await fsp.open(file, 'r');
  try {
    let pos = 0;
    let resto = Buffer.alloc(0);
    for (;;) {
      const buf = Buffer.alloc(TROZO_REGLAS);
      const { bytesRead } = await fh.read(buf, 0, TROZO_REGLAS, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const datos = resto.length ? Buffer.concat([resto, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const fin = datos.lastIndexOf(10);
      if (fin === -1) { resto = datos; continue; }
      // la próxima aparición de cada marca; solo se vuelve a buscar la que quedó atrás
      const prox = marcas.map((m) => datos.indexOf(m));
      let desde = 0;
      for (;;) {
        let i = -1;
        for (let k = 0; k < marcas.length; k++) {
          if (prox[k] !== -1 && prox[k] < desde) prox[k] = datos.indexOf(marcas[k], desde);
          if (prox[k] !== -1 && (i === -1 || prox[k] < i)) i = prox[k];
        }
        if (i === -1 || i > fin) break;
        const ini = datos.lastIndexOf(10, i) + 1;
        const fl = datos.indexOf(10, i);
        onLinea(datos.toString('utf8', ini, fl));
        desde = fl + 1;
      }
      resto = Buffer.from(datos.subarray(fin + 1));
      // entre trozo y trozo se deja respirar al servidor: el panel sigue emitiendo
      await new Promise((ok) => setImmediate(ok));
    }
    if (resto.length && marcas.some((m) => resto.includes(m))) onLinea(resto.toString('utf8'));
  } finally {
    await fh.close();
  }
}

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

      /* IMPACT-OK: cambia CÓMO se lee, no qué se cuenta. El filtro de marcas que antes era
         un `includes` por línea lo hace ahora `lineasConMarca` en bytes, y cada línea que
         lo pasa recibe el mismo JSON.parse y el mismo conteo de agentes, deploys y
         councils. Sin producción implicada: panel local de solo lectura.

         El fallo: esto hacía `readFile` ENTERO de cada transcript de 30 días y lo partía
         por líneas cada 15 minutos. Era la única lectura no incremental del panel: cientos
         de MB convertidos a texto de golpe para quedarse con unas pocas líneas. */
      const asientos = new Set();
      try {
        await lineasConMarca(file, MARCAS_REGLAS, (linea) => {
          let o;
          try { o = JSON.parse(linea); } catch { return; }
          const c = o.message?.content;
          if (!Array.isArray(c)) return;
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
        });
      } catch { continue; }
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

/**
 * CUARTA FUENTE: los dos lados del mismo mensaje.
 *
 * El CLI solo lista las sesiones VIVAS, así que una conversación de ayer se quedaba con
 * un pid suelto que no se podía traducir, y la misma charla salía partida en dos filas
 * sin relación aparente. Pero un mensaje deja huella en los dos transcripts y las dos
 * huellas comparten identificador: el emisor lo recibe en el acuse de su envío, y el
 * receptor lo guarda en el `origin` de lo que le llega. Cruzándolas se despeja quién es
 * quién sin preguntarle a nadie, y funciona igual con sesiones cerradas hace días.
 *
 * Emparejar por identificador y no por hora es lo que lo hace fiable: entre el envío y
 * la lectura pueden pasar minutos si la otra sesión estaba ocupada, así que cualquier
 * ventana de tiempo o se pasa de corta y no empareja, o se pasa de larga y confunde dos
 * mensajes distintos. Lo que aprende por aquí NUNCA pisa lo que dijo el CLI, que es dato
 * directo y no inferencia.
 */
function emparejarPorMsgId() {
  const salidas = new Map();   // msgId -> { sesion, pid }
  const llegadas = new Map();
  for (const s of sessions.values()) {
    for (const c of s.cruces) {
      if (!c.msgId || !c.pid) continue;
      (c.dir === 'out' ? salidas : llegadas).set(c.msgId, { sesion: s.id, pid: c.pid });
    }
  }
  for (const [msgId, o] of salidas) {
    const i = llegadas.get(msgId);
    if (!i || i.sesion === o.sesion) continue;
    // o.pid es el proceso de quien RECIBIÓ, i.pid el de quien ENVIÓ
    if (!porPid.get(o.pid)?.sessionId) apuntarPid(o.pid, { sessionId: i.sesion, inferido: true });
    if (!porPid.get(i.pid)?.sessionId) apuntarPid(i.pid, { sessionId: o.sesion, inferido: true });
  }
}

/**
 * De un pid a alguien con nombre. Se resuelve AQUÍ y no al leer el transcript, porque el
 * directorio se va rellenando: un mensaje leído hace diez minutos, cuando aún no sabíamos
 * quién era ese pid, queda resuelto en cuanto la otra sesión aparece por cualquiera de
 * las cuatro fuentes.
 */
function quienEs(pid, nombre) {
  const v = porPid.get(pid) || (nombre ? porPid.get(porNombre.get(nombre)) : null) || null;
  const id = v?.sessionId || null;
  const ses = id ? sessions.get(id) : null;
  return {
    id,
    nombre: v?.nombre || nombre || ses?.nombre || '',
    proyecto: ses?.project || (v?.cwd ? path.basename(v.cwd) : ''),
    vivo: !!v?.vivo,
  };
}

/**
 * Las conversaciones entre sesiones, agregadas por pareja.
 *
 * Un mensaje deja huella en los DOS transcripts, el de quien lo manda y el de quien lo
 * recibe, así que sumar los dos lados contaría cada aviso dos veces. Se descarta el
 * recibido solo cuando aparece su envío, y se reconocen por el mismo identificador que
 * usa `emparejarPorMsgId`. Descartarlo porque el emisor "esté por ahí" perdía mensajes de
 * verdad: de cada transcript se lee la cola y no entero, así que de una sesión larga
 * tenemos lo que recibió sin tener lo que mandó.
 */
function enlacesEntreSesiones() {
  const todos = [];
  const enviados = new Set();
  for (const s of sessions.values()) {
    for (const c of s.cruces) {
      const q = quienEs(c.pid, c.nombre);
      const otro = q.id || (c.pid ? `pid:${c.pid}` : `nom:${q.nombre || '?'}`);
      todos.push({ s, c, q, otro, par: [s.id, otro].sort().join('~') });
      if (c.dir === 'out' && c.msgId) enviados.add(c.msgId);
    }
  }
  const cuenta = todos.filter((x) => x.c.dir === 'out' || !enviados.has(x.c.msgId));

  const pares = new Map();
  for (const { s, c, q, otro, par } of cuenta) {
    let e = pares.get(par);
    if (!e) {
      e = { a: s.id, aNombre: s.nombre || '', aProy: s.project,
            b: q.id, bRef: otro, bNombre: q.nombre, bProy: q.proyecto, bVivo: q.vivo,
            enviados: 0, recibidos: 0, fallidos: 0, ultimo: 0, ultimoTexto: '' };
      pares.set(par, e);
    }
    // la otra punta se conoce mejor por unos cruces que por otros: si uno la resolvió, vale
    if (!e.b && q.id) { e.b = q.id; e.bProy = q.proyecto || e.bProy; }
    if (!e.bNombre && q.nombre) e.bNombre = q.nombre;
    if (q.vivo) e.bVivo = true;

    /* Enviados y recibidos van SIEMPRE desde el punto de vista de `a`. Los dos lados
       aportan cruces al mismo par, y el mismo mensaje es "salida" para uno y "llegada"
       para el otro: sin fijar la perspectiva, una conversación de ida y vuelta se
       enseñaría como si solo uno hubiera hablado. */
    const desdeA = s.id === e.a;
    const salida = desdeA ? c.dir === 'out' : c.dir === 'in';
    if (salida) { e.enviados++; if (c.ok === false) e.fallidos++; }
    else e.recibidos++;
    if (c.t > e.ultimo) { e.ultimo = c.t; e.ultimoTexto = c.summary || ''; }
  }
  return [...pares.values()]
    .map((e) => Object.assign(e, { n: e.enviados + e.recibidos }))
    .sort((x, y) => y.ultimo - x.ultimo);
}

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
      // `nombre` es la dirección que da Claude para escribirle; `alias`, el que le pones tú
      alias: historial.nombreDe(s.id), reanudar: historial.comando(s.id, s.cwd),
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
      // lo hablado con OTRAS sesiones, aparte de `up` y `lat`, que son de puertas adentro
      cross: s.cross,
      cruces: s.cruces.slice(-MSG_KEEP).map((c) => {
        const q = quienEs(c.pid, c.nombre);
        return { t: c.t, dir: c.dir, quien: c.quien || 'team-lead', pid: c.pid,
                 ok: c.ok !== false, fallo: c.fallo || '', summary: c.summary || '',
                 otroId: q.id, otroNombre: q.nombre, otroProy: q.proyecto, otroVivo: q.vivo };
      }),
      agents: [...s.agents.values()].map((a) => ({
        name: a.name, title: a.title || '', type: a.type || '',
        born: a.born, last: a.last, acts: a.acts, toks: a.toks,
        msgs: a.msgs, action: a.action, tool: a.tool, color: a.color, dice: a.dice || '',
        retired: a.retired, recent: a.recent.slice(0, ACT_KEEP),
      })),
      // `pendiente` es lo que cuenta como trabajo; con la sesión cerrada ya no corre nada
      bg: [...s.bg.values()]
        .sort((a, b) => b.lanzado - a.lanzado).slice(0, BG_KEEP)
        .map((p) => ({ id: p.id, tipo: p.tipo, desc: p.desc, quien: p.quien,
                       lanzado: p.lanzado, vence: p.vence, fin: p.fin, estado: p.estado,
                       evento: p.evento,
                       pendiente: s.status !== 'closed' && bgPendiente(p, now()) })),
    }));
  return { now: now(), error: fleetError,
           aviso: avisoFuentes?.largo || null, avisoCorto: avisoFuentes?.corto || null,
           sessions: list, enlaces: enlacesEntreSesiones() };
}

/* ─────────────────────────── http ─────────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const clients = new Set();

/** Sin Origin (curl, un hook) se acepta: quien lo manda ya está en este equipo. */
function origenPropio(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === PORT;
  } catch { return false; }
}

/* Pasado el tope se deja de guardar pero se sigue leyendo hasta el final: cortar la
   conexión a mitad deja al cliente sin respuesta y sin saber por qué. */
function leerCuerpo(req, tope) {
  return new Promise((ok, mal) => {
    const trozos = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n <= tope) trozos.push(c);
    });
    req.on('end', () => (n > tope
      ? mal(new Error('cuerpo demasiado grande'))
      : ok(Buffer.concat(trozos).toString('utf8'))));
    req.on('error', mal);
  });
}

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
      /* IMPACT-OK: blindaje del interruptor, calcado de /api/nombre de más abajo. Un POST
         simple (sin cabeceras especiales) no dispara el preflight de CORS, así que antes
         cualquier web podía mover este interruptor en silencio: pasaba el filtro de Host
         (va a 127.0.0.1) y el método. Exigir content-type application/json obliga al
         navegador a pedir permiso antes de enviar (preflight, que aquí nadie contesta), y
         si trae Origin tiene que ser este panel. Sin Origin (curl, hooks) sigue valiendo:
         quien lo lanza ya está en este equipo. Verificado el 2026-10-13: POST con Origin
         ajeno 415 sin content-type y 403 con él; curl local sin Origin 200. */
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
        return res.end(JSON.stringify({ ok: false, error: 'el cuerpo va en JSON' }));
      }
      if (!origenPropio(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'solo desde este equipo' }));
      }
      ALERTAS_ON = url.searchParams.get('on') === '1';
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      activas: ALERTAS_ON,
      hayClave: !!claveIngest(),
      hayDestino: !!urlIngest(),
      umbrales: { olvidada_h: UMBRAL.olvidada / 3600, sinGuardar_h: UMBRAL.sinGuardar / 3600, atascado_min: UMBRAL.atascado / 60,
                  turnoLargo_min: UMBRAL.turnoLargo / 60, ausencia_min: UMBRAL.ausencia / 60 },
      tareaTerminada: AVISO_TERMINADA,
      // IMPACT-OK: dos campos nuevos (ver F_REFRESCO). Sin producción implicada: panel local de solo lectura.
      refresco_ok: refresco.ok,
      refresco_fallo: refresco.fallo,
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
  /* Todas las sesiones en disco, con su comando para reanudarlas. En demostración no se
     enseña nada: el modo demo existe para sacar capturas sin nombres reales. */
  if (url.pathname === '/api/historial') {
    const datos = demo
      ? { ahora: now(), limpiezaDias: 30, total: 0, ocultas: 0, apagado: null, sesiones: [], demo: true }
      : await historial.listar((id) => sessions.get(id)?.status || null);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos));
  }
  /* Retomar una sesión: lo último que se dijo, su borrador de cierre, sus tareas sin
     cerrar, cómo está su repo AHORA y lo que lleva consumido. Bajo demanda: solo se pide
     al desplegar una fila, no para las ciento y pico del historial. */
  if (url.pathname === '/api/sesion') {
    const id = url.searchParams.get('id') || '';
    const d = demo ? null : await historial.detalle(id, (x) => sessions.get(x)?.status || null);
    if (d) {
      const tareas = await loadTasks(id);
      d.tareas = tareas.filter((t) => t.status !== 'completed');
      d.tareasTotal = tareas.length;
      // como con el borrador: una sesión abierta en el contenedor tiene su repo en `main/`
      d.git = d.cwd ? (await estadoGit(d.cwd)) || (await estadoGit(path.join(d.cwd, 'main'))) : null;
      d.tokens = consumo.deSesion(id);
    }
    res.writeHead(d ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(d || { error: 'no encuentro esa sesión' }));
  }
  if (url.pathname === '/api/buscar') {
    const datos = demo
      ? { q: '', sesiones: [], demo: true }
      : await historial.buscar(url.searchParams.get('q'), (x) => sessions.get(x)?.status || null);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos));
  }
  if (url.pathname === '/api/consumo') {
    const n = [7, 30, 90].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 7;
    const datos = demo ? { demo: true, dias: n, porDia: [], sesiones: [], carpetas: [], modelos: [], totales: [0, 0, 0, 0] }
      : await consumo.resumen(n, historial.ficha);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos));
  }
  /* Poner nombre es el único cambio que se puede hacer desde el panel, y solo toca su
     propio fichero. Aun así va blindado contra que lo dispare otra web: POST, JSON (que
     obliga al navegador a preguntar antes y aquí nadie le contesta que sí) y, si la
     petición trae Origin, que sea este mismo panel. */
  if (url.pathname === '/api/nombre') {
    const json = { 'Content-Type': 'application/json; charset=utf-8' };
    if (req.method !== 'POST') {
      res.writeHead(405, { ...json, Allow: 'POST' });
      return res.end(JSON.stringify({ ok: false, error: 'para poner un nombre, POST' }));
    }
    if (!origenPropio(req.headers.origin)) {
      res.writeHead(403, json);
      return res.end(JSON.stringify({ ok: false, error: 'solo desde el propio panel' }));
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      res.writeHead(415, json);
      return res.end(JSON.stringify({ ok: false, error: 'el cuerpo va en JSON' }));
    }
    let d;
    try { d = JSON.parse(await leerCuerpo(req, 4096)); }
    catch {
      res.writeHead(400, json);
      return res.end(JSON.stringify({ ok: false, error: 'cuerpo ilegible o demasiado grande' }));
    }
    const r = historial.ponerNombre(d?.id, d?.nombre);
    res.writeHead(r.ok ? 200 : 400, json);
    return res.end(JSON.stringify(r));
  }
  if (url.pathname === '/api/grafo') {
    const datos = await leerGrafo();
    res.writeHead(datos ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(datos || { ausente: true }));
  }
  if (url.pathname === '/api/explorador') {
    const html = await explorador();
    if (!html) {
      // El botón se queda visible a propósito aunque no haya grafo: es la única
      // pista de que esto existe. Pero "sin grafo" a secas no significa nada para
      // quien acaba de clonar, así que la página explica qué es y cómo montárselo.
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8">
<title>Sin grafo en esta máquina</title>
<style>
 body{background:#0d0d10;color:#e8e8ec;font:15px/1.6 system-ui,sans-serif;
      margin:0;display:grid;place-items:center;min-height:100vh}
 main{max-width:34rem;padding:2rem}
 h1{font-size:1.3rem;margin:0 0 1rem}
 a{color:#e60076}
 code{background:#1a1a20;padding:.1rem .35rem;border-radius:3px;font-size:.9em}
</style>
<main>
<h1>🕸 Aquí no hay ningún grafo, y no pasa nada</h1>
<p>El War Room puede dibujar además un <strong>grafo de tu código</strong>: qué módulos
   hay, quién llama a quién y qué se rompe si tocas un fichero. Es opcional y el panel
   funciona igual sin él.</p>
<p>El grafo no viene incluido porque no hay uno que valga para todos los lenguajes ni
   para todos los repositorios. Lo que el panel define es el <strong>formato</strong>:
   si tu herramienta exporta un JSON con esa forma, esta vista se dibuja sola.</p>
<p><a href="https://github.com/Stiwidh/corvere-war-room/blob/master/docs/GRAFO.md"
      target="_blank" rel="noopener">Cómo montarte el tuyo, y cómo pedírselo a Claude</a></p>
<p style="opacity:.6;font-size:.9em">Cuando lo tengas, apunta
   <code>WARROOM_GRAFO_JSON</code> a ese fichero y recarga.</p>
</main>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  /* Las vistas acotadas a UN proyecto, para el detalle de una sesión. Van bajo demanda y
     no dentro de `warroom.json` porque serían 26 juegos de SVG en un fichero que el panel
     recarga cada pocos segundos, y solo se mira uno cada vez. */
  if (url.pathname === '/api/piezas') {
    const proy = (url.searchParams.get('proyecto') || '').replace(/[^\w.-]/g, '').slice(0, 80);
    const datos = await piezasDe(proy);
    res.writeHead(datos ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(datos || JSON.stringify({ ausente: true }));
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

/* Al apagar el equipo, systemd manda SIGTERM: último volcado de qué había abierto, para
   que tras el arranque se sepa qué tenías delante. Sin esto se perdería como mucho el
   último minuto, que es justo el que importa. En demo no se escribe nada. */
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    if (!demo) historial.volcar();
    process.exit(0);
  });
}

setInterval(tick, SCAN_MS);
if (!demo) consumo.iniciar();
setInterval(() => {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}, PUSH_MS);

await tick();
/*
 * Un arranque que falla dice POR QUÉ y QUIÉN lo impide.
 *
 * El 2026-08-05 alguien dejó un `node server.mjs` a mano ocupando el 7777. El
 * servicio murió con un stack trace de EADDRINUSE, systemd lo reintentó cada 3
 * segundos y así 991 veces durante 9 horas. Nueve horas de panel caído en las
 * que el log repetía un volcado de `node:net` que no nombra al culpable, así
 * que hacía falta ir a buscarlo con `ss` para entender nada.
 */
server.on('error', (e) => {
  if (e?.code !== 'EADDRINUSE') throw e;
  let quien = '';
  try {
    quien = execFileSync('ss', ['-lptnH', `sport = :${PORT}`],
                         { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* sin ss, nos quedamos con el mensaje base */ }
  console.error(`El puerto ${PORT} ya está ocupado, así que el panel no puede arrancar.`);
  console.error(quien
    ? `Lo tiene: ${quien}\nSi es un arranque a mano, mátalo y el servicio entrará solo.`
    : `Mira quién lo tiene con: ss -lptn 'sport = :${PORT}'`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const n = sessions.size;
  console.log(`Corvere War Room  ·  http://${HOST}:${PORT}`);
  console.log(`${n} sesion${n === 1 ? '' : 'es'} en la ventana de ${MAX_AGE_H} h`);
});
