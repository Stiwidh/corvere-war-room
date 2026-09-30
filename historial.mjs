/**
 * Corvere War Room, historial de sesiones.
 *
 * El mapa enseña lo que está abierto AHORA, en una ventana de 36 h. Esto es lo otro:
 * todas las sesiones que siguen en disco, con el comando para volver a entrar en cada
 * una y un nombre que les pones tú, para no ir a buscar ocho hexadecimales cada vez que
 * reinicias el equipo.
 *
 * IMPACT-OK: módulo nuevo. Mapeo a mano (el grafo no indexa este repo): lo importa solo
 * `server.mjs`, que lo usa en su barrido, en el snapshot (dos campos NUEVOS por sesión,
 * `alias` y `reanudar`, ninguno renombrado) y en dos rutas nuevas. Los consumidores
 * externos de `/api/state` leen campos que no cambian. Sin
 * producción implicada: panel local.
 *
 * Qué escribe y dónde: tres JSON en ~/.local/state/warroom/, fuera del repo (que es
 * público) y fuera de ~/.claude (que el panel no toca nunca):
 *
 *   nombres.json    los nombres que pones desde el panel
 *   historial.json  el índice, que sobrevive a que Claude borre un transcript viejo
 *   abiertas.json   cuándo se vio abierta cada sesión por última vez, para saber cuáles
 *                   tenías delante cuando apagaste
 *
 * El nombre llega a Claude sin que el panel escriba en ~/.claude: el comando que se copia
 * lleva `--name`, y es el propio Claude quien lo guarda al reanudar. Verificado el
 * 2026-09-30 con el CLI 2.1.285: escribe un `custom-title` en el MISMO transcript y
 * conserva el sessionId, así que el nombre sale en su selector de /resume y en el título
 * de la terminal.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const AJUSTES_CLAUDE = path.join(HOME, '.claude', 'settings.json');
const DIR_ESTADO = path.join(HOME, '.local', 'state', 'warroom');
const F_NOMBRES = path.join(DIR_ESTADO, 'nombres.json');
const F_INDICE = path.join(DIR_ESTADO, 'historial.json');
const F_ABIERTAS = path.join(DIR_ESTADO, 'abiertas.json');

/* Cuánto leer de cada transcript. Medido el 2026-09-30 sobre 193 sesiones: tu primer
   mensaje cae a 29 KB de mediana y a 111 KB en el p90, porque delante van las salidas de
   los hooks de arranque; el peor, a 3,1 MB. Se lee en escalones y se para al encontrarlo,
   y como el principio de un transcript no cambia, se lee una sola vez por sesión. */
const CABEZA = 256 * 1024;
const CABEZA_MAX = 4 * 1024 * 1024;
/* El título que genera Claude (`ai-title`) se reescribe una y otra vez a lo largo del
   fichero ("last-wins" en su propio código), así que el vigente está en la cola. */
const COLA = 256 * 1024;
const REFRESCO_S = 20;
const LATIDO_S = 60;
/* "Abiertas al apagar" son las que se vieron abiertas en los últimos minutos antes del
   último latido del panel. Al apagar, las terminales mueren un poco antes que el propio
   panel, y su último barrido puede verlas ya cerradas: por eso una ventana y no un
   instante exacto. */
const VENTANA_APAGADO_S = 5 * 60;
const NOMBRE_MAX = 80;
const DIAS_BORRADAS = 365;   // una fila cuyo transcript ya no existe se guarda un año

const ahora = () => Date.now() / 1000;
const ID_VALIDO = /^[0-9a-f][0-9a-f-]{7,63}$/i;

function tsOf(v) {
  const t = Date.parse(v || '');
  return Number.isNaN(t) ? 0 : Math.round(t / 1000);
}

function leerJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/* Escritura atómica, a un temporal y luego rename: un apagado a media escritura no puede
   dejar el fichero partido y el siguiente arranque sin nombres. En 600 porque el índice
   lleva la primera frase de cada sesión. */
function escribirJSON(f, datos) {
  try {
    fs.mkdirSync(DIR_ESTADO, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(datos), { mode: 0o600 });
    fs.renameSync(tmp, f);
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────── nombres ─────────────────────────── */

const nombres = new Map(Object.entries(leerJSON(F_NOMBRES) || {})
  .filter(([id, v]) => ID_VALIDO.test(id) && v && typeof v.nombre === 'string'));

export const nombreDe = (id) => nombres.get(id)?.nombre || '';

/** Pone o quita (con un nombre vacío) el nombre de una sesión. */
export function ponerNombre(id, nombre) {
  id = String(id || '');
  if (!ID_VALIDO.test(id)) return { ok: false, error: 'id de sesión no válido' };
  const limpio = String(nombre ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, NOMBRE_MAX);
  const antes = nombres.get(id);
  if (limpio) nombres.set(id, { nombre: limpio, t: Math.round(ahora()) });
  else nombres.delete(id);
  if (!escribirJSON(F_NOMBRES, Object.fromEntries(nombres))) {
    // lo que no se ha podido guardar no se enseña como guardado
    if (antes) nombres.set(id, antes); else nombres.delete(id);
    return { ok: false, error: 'no se pudo guardar en disco' };
  }
  return { ok: true, nombre: limpio };
}

/* ─────────────────────────── el comando ─────────────────────────── */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * `cd` delante porque Claude guarda cada sesión bajo el directorio donde se abrió: con él
 * el comando funciona pegado en cualquier terminal. `--name` solo si le has puesto nombre,
 * para no pisar el que tuviera en Claude.
 */
export function comando(id, cwd, nombre = nombreDe(id)) {
  if (!cwd || !ID_VALIDO.test(String(id || ''))) return '';
  if (process.platform === 'win32') {
    const q = (s) => `"${String(s).replace(/"/g, '')}"`;
    return `cd /d ${q(cwd)} && claude --resume ${id}${nombre ? ` --name ${q(nombre)}` : ''}`;
  }
  return `cd ${shq(cwd)} && claude --resume ${id}${nombre ? ` --name ${shq(nombre)}` : ''}`;
}

/* Cuántos días guarda Claude los transcripts antes de borrarlos. Lo dice su ajuste
   `cleanupPeriodDays`; sin él, 30. Pasado ese plazo la fila sigue aquí, pero ya no se
   puede reanudar, y el panel lo avisa antes de que pase. */
let limpieza = { t: 0, dias: 30 };
function diasDeLimpieza() {
  if (ahora() - limpieza.t < 60) return limpieza.dias;
  const n = Number(leerJSON(AJUSTES_CLAUDE)?.cleanupPeriodDays);
  limpieza = { t: ahora(), dias: Number.isFinite(n) && n > 0 ? n : 30 };
  return limpieza.dias;
}

/* ─────────────────────────── índice ─────────────────────────── */

const indice = new Map(Object.entries(leerJSON(F_INDICE)?.sesiones || {})
  .filter(([id, v]) => ID_VALIDO.test(id) && v && typeof v === 'object'));
let ultimoRefresco = 0;
let refrescando = null;

function textoDe(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ');
}

/** Recorre el principio del fichero línea a línea, en escalones, hasta que `alLinea` diga basta. */
async function recorrerCabeza(fh, size, alLinea) {
  let pos = 0;
  let resto = Buffer.alloc(0);
  while (pos < size && pos < CABEZA_MAX) {
    const n = Math.min(CABEZA, size - pos);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, pos);
    if (!bytesRead) break;
    pos += bytesRead;
    // se trabaja en bytes y no en texto: un carácter partido entre dos escalones se
    // convertiría en basura si cada trozo se decodificara por separado
    const datos = Buffer.concat([resto, buf.subarray(0, bytesRead)]);
    let ini = 0;
    let i;
    while ((i = datos.indexOf(10, ini)) !== -1) {
      if (alLinea(datos.toString('utf8', ini, i)) === false) return pos;
      ini = i + 1;
    }
    resto = datos.subarray(ini);
  }
  return pos;
}

async function analizarCabeza(fh, size) {
  const r = { cwd: '', rama: '', inicio: 0, entrypoint: '', primerMensaje: '', titulo: '', tituloNativo: '' };
  r.cabeza = await recorrerCabeza(fh, size, (linea) => {
    if (!linea) return undefined;
    const interesa = linea.includes('"type":"user"') || linea.includes('"ai-title"')
      || linea.includes('"custom-title"');
    // lo caro es parsear las salidas de los hooks de arranque, que son enormes
    if (r.cwd && !interesa) return undefined;
    let o;
    try { o = JSON.parse(linea); } catch { return undefined; }
    if (!r.cwd && o.cwd) { r.cwd = o.cwd; r.rama = o.gitBranch || ''; }
    if (!r.entrypoint && o.entrypoint) r.entrypoint = o.entrypoint;
    if (!r.inicio && o.timestamp) r.inicio = tsOf(o.timestamp);
    if (o.type === 'ai-title' && o.aiTitle) r.titulo = String(o.aiTitle);
    if (o.type === 'custom-title' && o.customTitle) r.tituloNativo = String(o.customTitle);
    if (o.type === 'user' && !o.isMeta && !o.isSidechain && !r.primerMensaje) {
      const t = textoDe(o.message?.content).trim();
      // lo que empieza por `<` no lo escribiste tú: comandos, avisos, mensajes de otra sesión
      if (t && !t.startsWith('<')) r.primerMensaje = t.replace(/\s+/g, ' ').slice(0, 220);
    }
    return r.cwd && r.primerMensaje ? false : undefined;
  });
  return r;
}

async function analizarCola(fh, size) {
  const desde = Math.max(0, size - COLA);
  const buf = Buffer.alloc(size - desde);
  const { bytesRead } = await fh.read(buf, 0, buf.length, desde);
  const lineas = buf.toString('utf8', 0, bytesRead).split('\n');
  if (desde > 0) lineas.shift();          // la primera puede venir cortada
  const r = { titulo: '', tituloNativo: '' };
  for (let i = lineas.length - 1; i >= 0 && !(r.titulo && r.tituloNativo); i--) {
    const l = lineas[i];
    if (!r.titulo && l.includes('"ai-title"')) {
      try { r.titulo = String(JSON.parse(l).aiTitle || ''); } catch { /* línea a medias */ }
    }
    if (!r.tituloNativo && l.includes('"custom-title"')) {
      try { r.tituloNativo = String(JSON.parse(l).customTitle || ''); } catch { /* línea a medias */ }
    }
  }
  return r;
}

async function barrer() {
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS); } catch { return; }

  /* El mismo transcript aparece enlazado en varios directorios: se elige la copia mayor
     y, a igualdad, la misma ruta siempre (el mismo criterio que el barrido del mapa). */
  const mejor = new Map();
  for (const pd of dirs) {
    let entradas;
    try { entradas = await fsp.readdir(path.join(PROJECTS, pd), { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const id = e.name.slice(0, -6);
      if (!ID_VALIDO.test(id)) continue;
      const file = path.join(PROJECTS, pd, e.name);
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      const prev = mejor.get(id);
      if (!prev || st.size > prev.size || (st.size === prev.size && file < prev.file)) {
        mejor.set(id, { file, size: st.size, mtime: Math.round(st.mtimeMs / 1000) });
      }
    }
  }

  let cambios = false;
  for (const [id, f] of mejor) {
    const prev = indice.get(id);
    if (prev && !prev.borrado && prev.bytes === f.size && prev.ultima === f.mtime) {
      if (prev.fichero !== f.file) { prev.fichero = f.file; cambios = true; }   // índices de antes de guardar la ruta
      continue;
    }
    let fh;
    try {
      fh = await fsp.open(f.file, 'r');
      const v = { ...(prev || {}), id, bytes: f.size, ultima: f.mtime, borrado: false, fichero: f.file };
      /* La cabeza se relee solo si falta algo que pueda estar ahí: sesión nueva, fichero
         que ha encogido (reescrito) o primer mensaje aún sin escribir. */
      const releer = !prev || !prev.cwd || f.size < (prev.bytes || 0)
        || (!prev.primerMensaje && (prev.cabeza || 0) < Math.min(f.size, CABEZA_MAX));
      let cab = null;
      if (releer) {
        cab = await analizarCabeza(fh, f.size);
        Object.assign(v, { cwd: cab.cwd, rama: cab.rama, inicio: cab.inicio,
                           entrypoint: cab.entrypoint, primerMensaje: cab.primerMensaje,
                           cabeza: cab.cabeza });
      }
      const cola = await analizarCola(fh, f.size);
      v.titulo = cola.titulo || prev?.titulo || cab?.titulo || '';
      v.tituloNativo = cola.tituloNativo || prev?.tituloNativo || cab?.tituloNativo || '';
      if (v.cwd) { indice.set(id, v); cambios = true; }
    } catch { /* ilegible ahora: lo intenta el siguiente barrido */ } finally { await fh?.close(); }
  }

  const tope = ahora() - DIAS_BORRADAS * 86400;
  for (const [id, v] of indice) {
    if (mejor.has(id)) continue;
    if (!v.borrado) { v.borrado = true; cambios = true; }
    if ((v.ultima || 0) < tope) { indice.delete(id); cambios = true; }
  }
  if (cambios) escribirJSON(F_INDICE, { version: 1, sesiones: Object.fromEntries(indice) });
}

/** Refresca el índice como mucho cada REFRESCO_S, y nunca dos barridos a la vez. */
function refrescar() {
  if (refrescando) return refrescando;
  if (ahora() - ultimoRefresco < REFRESCO_S) return Promise.resolve();
  refrescando = barrer().catch(() => {}).finally(() => {
    ultimoRefresco = ahora();
    refrescando = null;
  });
  return refrescando;
}

/* ─────────────────── lo que tenías abierto al apagar ─────────────────── */

/* La hora de arranque del equipo es lo que distingue "el panel se ha reiniciado" de "el
   equipo se ha reiniciado". Tolerancia de 2 min porque sale de restar el uptime al reloj
   y baila unos segundos entre lecturas. */
const arranque = Math.round(ahora() - os.uptime());
const previo = leerJSON(F_ABIERTAS) || {};
const vistas = new Map();
let latido = 0;
let apagado = null;

if (previo.arranque && Math.abs(previo.arranque - arranque) > 120) {
  // hubo un apagado desde el último latido: lo abierto en ese momento es lo que tenías delante
  const fin = Number(previo.latido) || 0;
  const ids = Object.entries(previo.vistas || {})
    .filter(([id, t]) => ID_VALIDO.test(id) && Number(t) >= fin - VENTANA_APAGADO_S)
    .map(([id]) => id);
  apagado = ids.length ? { t: fin, arranque, ids } : null;
} else {
  // mismo arranque: solo se reinició el panel, y lo calculado al arrancar el equipo sigue valiendo
  apagado = previo.apagado || null;
  latido = Number(previo.latido) || 0;
  for (const [id, t] of Object.entries(previo.vistas || {})) vistas.set(id, Number(t) || 0);
}

let firmaAbiertas = '';
let ultimoVolcado = 0;

/** Lo llama el barrido del mapa con las sesiones que ve abiertas. */
export function anotarAbiertas(ids) {
  const t = Math.round(ahora());
  for (const id of ids) vistas.set(id, t);
  latido = t;
  const firma = [...ids].sort().join(',');
  if (firma !== firmaAbiertas || t - ultimoVolcado >= LATIDO_S) {
    firmaAbiertas = firma;
    volcar();
  }
}

/** Escribe el estado a disco. Síncrono a propósito: también se llama al recibir SIGTERM. */
export function volcar() {
  // una sesión vista abierta hace una semana no dice nada del próximo apagado
  for (const [id, t] of vistas) if (latido - t > 7 * 86400) vistas.delete(id);
  ultimoVolcado = Math.round(ahora());
  escribirJSON(F_ABIERTAS, { arranque, latido, vistas: Object.fromEntries(vistas), apagado });
}

/* ─────────────────────────── lo que se sirve ─────────────────────────── */

function fila(v, estadoDe) {
  const nombre = nombreDe(v.id);
  return {
    id: v.id, cwd: v.cwd, proyecto: path.basename(v.cwd || '') || '?', rama: v.rama || '',
    nombre, tituloNativo: v.tituloNativo || '', titulo: v.titulo || '',
    primerMensaje: v.primerMensaje || '',
    inicio: v.inicio || 0, ultima: v.ultima || 0, bytes: v.bytes || 0,
    estado: estadoDe(v.id) || 'closed', borrado: !!v.borrado,
    comando: v.borrado ? '' : comando(v.id, v.cwd, nombre),
  };
}

/**
 * Todas las sesiones, de la más reciente a la más vieja. `estadoDe(id)` lo pone el
 * servidor: dice si esa sesión está abierta ahora mismo.
 *
 * Fuera quedan las que no abriste tú (entrypoint `sdk-*`: las lanza un programa con el
 * SDK) y las vacías. No se esconden en silencio: se cuentan en `ocultas`.
 */
export async function listar(estadoDe) {
  await refrescar();
  const filas = [];
  let ocultas = 0;
  for (const v of indice.values()) {
    const automatica = /^sdk/.test(v.entrypoint || '');
    const vacia = !v.primerMensaje && !v.titulo && !v.tituloNativo;
    if (automatica || vacia) { ocultas++; continue; }
    filas.push(fila(v, estadoDe));
  }
  filas.sort((a, b) => b.ultima - a.ultima);
  const porId = new Map(filas.map((f) => [f.id, f]));
  return {
    ahora: ahora(),
    limpiezaDias: diasDeLimpieza(),
    total: filas.length,
    ocultas,
    apagado: apagado
      ? { t: apagado.t, sesiones: apagado.ids.map((id) => porId.get(id)).filter(Boolean) }
      : null,
    sesiones: filas,
  };
}

/** Lo mínimo para ponerle cara a una sesión desde otro módulo (el consumo). */
export function ficha(id) {
  const v = indice.get(id);
  return {
    nombre: nombreDe(id), titulo: v?.tituloNativo || v?.titulo || v?.primerMensaje || '',
    proyecto: path.basename(v?.cwd || '') || '?', automatica: /^sdk/.test(v?.entrypoint || ''),
  };
}

/* ─────────────────── retomar: dónde se quedó una sesión ─────────────────── */

/* El borrador que deja el hook de bitácora al cerrar la sesión (commits, dónde se tocó,
   duración). Sus "cabos sueltos" son del ecosistema entero y no de esta sesión, así que
   se cortan: aquí estorbarían. */
async function borradorDe(v) {
  if (!v.cwd) return null;
  /* Donde lo deja el hook depende de en qué carpeta acabó la sesión, que no tiene por qué
     ser donde empezó: abierta en el contenedor `PROYECTOS/X/`, suele cerrarse en su repo,
     `X/main/`. Se mira en los dos. */
  let dir = null;
  let suyo = null;
  for (const d of [path.join(v.cwd, '_journal', '_borradores'), path.join(v.cwd, 'main', '_journal', '_borradores')]) {
    let nombresFich;
    try { nombresFich = await fsp.readdir(d); } catch { continue; }
    suyo = nombresFich.filter((f) => f.endsWith(`_${v.id.slice(0, 8)}.md`)).sort().pop();
    if (suyo) { dir = d; break; }
  }
  if (!suyo) return null;
  try {
    let texto = await fsp.readFile(path.join(dir, suyo), 'utf8');
    const corte = texto.indexOf('\n## Cabos sueltos');
    if (corte > 0) texto = texto.slice(0, corte);
    return { ruta: path.join(dir, suyo), texto: texto.trim().slice(0, 4000) };
  } catch {
    return null;
  }
}

/**
 * Lo necesario para volver a una sesión sin releerla: lo último que le pediste, lo último
 * que te contestó y el borrador de su cierre. Se lee de la cola del transcript (1 MB).
 */
export async function detalle(id, estadoDe) {
  if (!ID_VALIDO.test(String(id || ''))) return null;
  await refrescar();
  const v = indice.get(id);
  if (!v) return null;
  const r = { ...fila(v, estadoDe), ultimoPedido: '', ultimaRespuesta: '', borrador: null };
  if (!v.borrado && v.fichero) {
    let fh;
    try {
      fh = await fsp.open(v.fichero, 'r');
      const { size } = await fh.stat();
      /* Se empieza por el último mega y se amplía si hace falta: detrás de tu último
         mensaje puede haber varios megas de herramientas (medido: un "ok" que quedaba más
         atrás del primer mega). */
      for (const ventana of [1, 4, 16].map((mb) => mb * 1024 * 1024)) {
        r.ultimoPedido = ''; r.ultimaRespuesta = '';
        const desde = Math.max(0, size - ventana);
        const buf = Buffer.alloc(size - desde);
        const { bytesRead } = await fh.read(buf, 0, buf.length, desde);
        const lineas = buf.toString('utf8', 0, bytesRead).split('\n');
        if (desde > 0) lineas.shift();
        for (let i = lineas.length - 1; i >= 0 && !(r.ultimoPedido && r.ultimaRespuesta); i--) {
          const l = lineas[i];
          if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"')) continue;
          let o;
          try { o = JSON.parse(l); } catch { continue; }
          if (o.isSidechain || o.isMeta) continue;
          const c = o.message?.content;
          if (!r.ultimaRespuesta && o.type === 'assistant') {
            const t = textoDe(c).trim();
            if (t) r.ultimaRespuesta = t.slice(0, 1500);
          }
          if (!r.ultimoPedido && o.type === 'user') {
            if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;
            const t = textoDe(c).trim();
            if (t && !t.startsWith('<')) r.ultimoPedido = t.slice(0, 800);
          }
        }
        if ((r.ultimoPedido && r.ultimaRespuesta) || desde === 0) break;
      }
    } catch { /* ilegible: se devuelve lo que haya */ } finally { await fh?.close(); }
  }
  r.borrador = await borradorDe(v);
  return r;
}

/* ─────────────────── buscar dentro de las conversaciones ─────────────────── */

/* Sin tildes y sin mayúsculas: "facturacion" encuentra "Facturación". Se hace en el
   patrón y no normalizando el texto, porque normalizar 2 GB en cada búsqueda es lo caro. */
const VARIANTES = { a: 'aáàä', e: 'eéèë', i: 'iíìï', o: 'oóòö', u: 'uúùü', n: 'nñ', c: 'cç' };
const escapar = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Varias palabras valen en cualquier orden, siempre que estén en el MISMO mensaje: pedir
   que fueran seguidas dejaba sin resultado búsquedas normales de dos palabras, que casi
   nunca aparecen juntas y en ese orden. */
function palabras(q) {
  return q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/\s+/).filter((p) => p.length >= 2);
}

function patron(palabra) {
  return new RegExp([...palabra].map((ch) => (VARIANTES[ch] ? `[${VARIANTES[ch]}]` : escapar(ch))).join(''), 'i');
}

/* El mismo patrón, pero para buscar sobre los BYTES leídos como latin1 (una copia directa,
   sin descodificar). Medido el 2026-09-30 sobre 1,85 GB: descodificar UTF-8 costaba 6 s de
   los 7 de una búsqueda, y la expresión regular 50 ms. En UTF-8 una letra con tilde son
   dos bytes que empiezan por 0xC3, así que cada vocal acepta también "0xC3 y otro byte":
   deja pasar algún falso positivo, que descarta luego el patrón bueno sobre la línea ya
   descodificada. Lo que no puede es dejarse uno de verdad. Se busca solo la palabra más
   larga, que es la que más descarta; las demás se comprueban en la línea. */
function patronBytes(palabra) {
  return new RegExp([...palabra].map((ch) => (VARIANTES[ch] ? `(?:${ch}|\xC3[\x80-\xBF])` : escapar(ch))).join(''), 'gi');
}

const limpio = (s) => s.replace(/\s+/g, ' ');

/** Si la línea es algo que escribiste tú o que contestó Claude y tiene todas las palabras, el fragmento. */
function coincidencia(linea, rxs, rx) {
  let o;
  try { o = JSON.parse(linea); } catch { return null; }
  if (o.isSidechain || o.isMeta) return null;
  const c = o.message?.content;
  let quien;
  if (o.type === 'user') {
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
    quien = 'tú';
  } else if (o.type === 'assistant') {
    quien = 'Claude';
  } else {
    return null;   // salidas de hooks, adjuntos: el mismo texto sale en todas las sesiones
  }
  const texto = textoDe(c).trim();
  if (!texto || (quien === 'tú' && texto.startsWith('<'))) return null;
  if (!rxs.every((r) => r.test(texto))) return null;
  const m = rx.exec(texto);
  if (!m) return null;
  const ini = Math.max(0, m.index - 80);
  const fin = Math.min(texto.length, m.index + m[0].length + 120);
  return {
    t: tsOf(o.timestamp), quien,
    antes: (ini > 0 ? '…' : '') + limpio(texto.slice(ini, m.index)),
    hallado: limpio(m[0]),
    despues: limpio(texto.slice(m.index + m[0].length, fin)) + (fin < texto.length ? '…' : ''),
  };
}

async function buscarEn(fichero, rxBytes, rxs, rx, tope) {
  const hallazgos = [];
  let fh;
  try {
    fh = await fsp.open(fichero, 'r');
    const { size } = await fh.stat();
    const TROZO = 4 << 20;
    const buf = Buffer.alloc(TROZO);
    let pos = 0;
    let resto = Buffer.alloc(0);
    while (pos < size && hallazgos.length < tope) {
      const { bytesRead } = await fh.read(buf, 0, TROZO, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const datos = resto.length ? Buffer.concat([resto, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      // hasta el último salto de línea; lo que queda se completa con el siguiente trozo
      const fin = pos >= size ? datos.length : datos.lastIndexOf(10);
      if (fin <= 0) { resto = Buffer.from(datos); continue; }
      const bloque = datos.toString('latin1', 0, fin);
      rxBytes.lastIndex = 0;
      let m;
      while (hallazgos.length < tope && (m = rxBytes.exec(bloque))) {
        const ini = bloque.lastIndexOf('\n', m.index) + 1;
        let fl = bloque.indexOf('\n', m.index);
        if (fl < 0) fl = bloque.length;
        // latin1 es un byte por carácter: las posiciones valen igual en el buffer
        const h = coincidencia(datos.toString('utf8', ini, fl), rxs, rx);
        if (h) hallazgos.push(h);
        rxBytes.lastIndex = fl;          // una línea se mira una vez
      }
      resto = Buffer.from(datos.subarray(Math.min(datos.length, fin + 1)));
    }
  } catch { /* ilegible: sin hallazgos */ } finally { await fh?.close(); }
  return hallazgos;
}

let ultimaBusqueda = { q: '', t: 0, r: null };

/**
 * Busca en lo que dijisteis tú y Claude (no en las salidas de herramientas ni de hooks),
 * de la sesión más reciente a la más vieja. Se corta a las 40 sesiones con hallazgos o a
 * los 20 s, y lo dice.
 */
export async function buscar(q, estadoDe) {
  q = String(q || '').trim().slice(0, 80);
  const ps = palabras(q);
  if (q.length < 3 || !ps.length) return { q, error: 'escribe al menos 3 letras', sesiones: [] };
  if (ultimaBusqueda.q === q && ahora() - ultimaBusqueda.t < 60) return ultimaBusqueda.r;
  await refrescar();
  const larga = ps.reduce((a, b) => (b.length > a.length ? b : a));
  const rxs = ps.map(patron);
  const rx = patron(larga);
  const rxBytes = patronBytes(larga);
  const t0 = Date.now();
  const candidatas = [...indice.values()]
    .filter((v) => v.fichero && !v.borrado && !/^sdk/.test(v.entrypoint || ''))
    .sort((a, b) => b.ultima - a.ultima);
  const sesiones = [];
  let miradas = 0;
  let cortada = false;
  for (const v of candidatas) {
    if (Date.now() - t0 > 20000 || sesiones.length >= 40) { cortada = true; break; }
    miradas++;
    const hallazgos = await buscarEn(v.fichero, rxBytes, rxs, rx, 3);
    if (hallazgos.length) sesiones.push({ ...fila(v, estadoDe), hallazgos });
  }
  const r = { q, ms: Date.now() - t0, miradas, total: candidatas.length, cortada, sesiones };
  ultimaBusqueda = { q, t: ahora(), r };
  return r;
}
