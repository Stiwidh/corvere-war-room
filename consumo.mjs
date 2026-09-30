/**
 * Corvere War Room, consumo de tokens por día, por sesión y por carpeta.
 *
 * El mapa contaba solo los tokens de SALIDA (`usage.output_tokens`), y eso es la parte
 * pequeña: cada turno manda otra vez el contexto, y ahí está el grueso. Esto suma las
 * cuatro partes que Claude apunta en cada respuesta, con su día y su sesión.
 *
 * IMPACT-OK: módulo nuevo; lo importa solo `server.mjs` (una ruta nueva, `/api/consumo`,
 * y un campo en `/api/sesion`). No toca `/api/state` ni a sus lectores. Escribe solo
 * `~/.local/state/warroom/tokens.json`. Sin producción implicada: panel local.
 *
 * Cómo se cuenta, y por qué así (medido el 2026-09-30 sobre 475 transcripts, 5,2 GB):
 *   · Una respuesta de Claude ocupa varias líneas (una por bloque) que repiten su
 *     `usage`: 164.069 líneas para 77.324 mensajes. Se cuenta por `message.id`,
 *     quedándose con el máximo de cada campo, no sumando líneas.
 *   · Un mismo transcript aparece enlazado en varias carpetas: el cursor va por inodo,
 *     no por ruta, para no leerlo dos veces.
 *   · El 0,5 % de los mensajes aparece en dos ficheros distintos (sesiones que copian el
 *     historial de otra). Dentro de una misma ejecución del panel no se cuentan dos
 *     veces; tras un reinicio sí podrían, y es ese 0,5 % como mucho.
 *   · Solo se descodifica la línea que contiene `"usage":`, localizada en bytes: son
 *     480 MB de los 5,2 GB. La primera pasada es la única cara; luego se lee lo nuevo.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const DIR_ESTADO = path.join(HOME, '.local', 'state', 'warroom');
const F_TOKENS = path.join(DIR_ESTADO, 'tokens.json');
const TROZO = 4 * 1024 * 1024;
const MARCA = Buffer.from('"usage":');
const DIAS_GUARDA = 120;
const RELEER_S = 60;

const ahora = () => Date.now() / 1000;
const pad = (n) => String(n).padStart(2, '0');
/** El día en la hora de esta máquina, que es la de quien trabaja con ella. */
function fechaLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function leerJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

const guardado = leerJSON(F_TOKENS) || {};
/** `dev:ino` -> bytes ya leídos */
const cursores = new Map(Object.entries(guardado.cursores || {}));
/** día -> sesión -> [entrada, caché escrita, caché leída, salida] */
const dias = guardado.dias || {};
/** día -> modelo -> [entrada, caché escrita, caché leída, salida] */
const modelos = guardado.modelos || {};
/** message.id -> lo ya contado de ese mensaje. Solo en memoria (ver cabecera). */
const contados = new Map();

let enCurso = null;
let ultimaPasada = Number(guardado.ultimaPasada) || 0;
let primeraPasada = !cursores.size;

function sumar(tabla, dia, clave, delta) {
  const d = (tabla[dia] ||= {});
  const v = (d[clave] ||= [0, 0, 0, 0]);
  for (let k = 0; k < 4; k++) v[k] += delta[k];
}

function procesar(linea, sesion) {
  let o;
  try { o = JSON.parse(linea); } catch { return; }
  const m = o.message;
  const u = m?.usage;
  if (o.type !== 'assistant' || !u || m.model === '<synthetic>') return;
  const t = Date.parse(o.timestamp || '');
  if (!t) return;
  const id = m.id || o.uuid;
  const nuevo = [u.input_tokens || 0, u.cache_creation_input_tokens || 0,
                 u.cache_read_input_tokens || 0, u.output_tokens || 0];
  const antes = contados.get(id) || [0, 0, 0, 0];
  const delta = nuevo.map((v, k) => Math.max(0, v - antes[k]));
  if (!delta.some(Boolean)) return;
  contados.set(id, nuevo.map((v, k) => Math.max(v, antes[k])));
  const dia = fechaLocal(t);
  sumar(dias, dia, sesion, delta);
  sumar(modelos, dia, m.model || '?', delta);
}

/** Lee lo nuevo de un fichero desde su cursor. Devuelve si había algo. */
async function leerFichero(ruta, clave, sesion, size) {
  let desde = Number(cursores.get(clave)) || 0;
  if (size < desde) desde = 0;            // reescrito o truncado
  if (size === desde) return false;
  const fh = await fsp.open(ruta, 'r');
  try {
    let pos = desde;
    let resto = Buffer.alloc(0);
    while (pos < size) {
      const n = Math.min(TROZO, size - pos);
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const datos = resto.length ? Buffer.concat([resto, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const fin = datos.lastIndexOf(10);
      if (fin === -1) { resto = datos; continue; }
      // solo se descodifica la línea que lleva un `usage`: el resto ni se convierte en texto
      let i = datos.indexOf(MARCA);
      while (i !== -1 && i < fin) {
        const ini = datos.lastIndexOf(10, i) + 1;
        const fl = datos.indexOf(10, i);
        procesar(datos.toString('utf8', ini, fl), sesion);
        i = datos.indexOf(MARCA, fl);
      }
      resto = Buffer.from(datos.subarray(fin + 1));
      // entre trozo y trozo se deja respirar al servidor: el panel sigue emitiendo
      await new Promise((ok) => setImmediate(ok));
    }
    // la línea a medio escribir se relee la próxima vez
    cursores.set(clave, pos - resto.length);
  } finally {
    await fh.close();
  }
  return true;
}

async function barrer() {
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS); } catch { return; }
  const vistos = new Set();
  let cambios = false;
  const mirar = async (ruta, sesion) => {
    let st;
    try { st = await fsp.stat(ruta); } catch { return; }
    const clave = `${st.dev}:${st.ino}`;
    if (vistos.has(clave)) return;         // el mismo fichero por otra carpeta
    vistos.add(clave);
    try { if (await leerFichero(ruta, clave, sesion, st.size)) cambios = true; } catch { /* al siguiente */ }
  };
  for (const pd of dirs) {
    const dir = path.join(PROJECTS, pd);
    let entradas;
    try { entradas = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        await mirar(path.join(dir, e.name), e.name.slice(0, -6));
      } else if (e.isDirectory()) {
        // los agentes de una sesión cuentan como consumo de esa sesión
        const sub = path.join(dir, e.name, 'subagents');
        let fichs;
        try { fichs = await fsp.readdir(sub); } catch { continue; }
        for (const f of fichs) if (f.endsWith('.jsonl')) await mirar(path.join(sub, f), e.name);
      }
    }
  }
  // los cursores de ficheros que ya no existen no sirven para nada
  for (const k of [...cursores.keys()]) if (!vistos.has(k)) { cursores.delete(k); cambios = true; }
  if (contados.size > 400000) contados.clear();
  const tope = fechaLocal(Date.now() - DIAS_GUARDA * 86400000);
  for (const t of [dias, modelos]) for (const d of Object.keys(t)) if (d < tope) { delete t[d]; cambios = true; }
  ultimaPasada = ahora();
  if (cambios || primeraPasada) guardar();
  primeraPasada = false;
}

function guardar() {
  try {
    fs.mkdirSync(DIR_ESTADO, { recursive: true });
    const tmp = `${F_TOKENS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ultimaPasada, cursores: Object.fromEntries(cursores), dias, modelos }),
      { mode: 0o600 });
    fs.renameSync(tmp, F_TOKENS);
  } catch { /* sin disco: se recalcula la próxima vez */ }
}

/** Una pasada como mucho cada RELEER_S y nunca dos a la vez. */
export function refrescar() {
  if (enCurso) return enCurso;
  if (ahora() - ultimaPasada < RELEER_S) return Promise.resolve();
  enCurso = barrer().catch(() => {}).finally(() => { enCurso = null; });
  return enCurso;
}

const total = (v) => v[0] + v[1] + v[3];   // lo nuevo: entrada, caché escrita y salida

/**
 * Resumen de los últimos `n` días. `ficha(id)` pone nombre y carpeta a cada sesión.
 * La primera vez, mientras se lee todo, devuelve lo que haya con `calculando: true`.
 */
export async function resumen(n, ficha) {
  // la pasada normal es rápida y se espera; la primera (todo el disco) no
  if (primeraPasada) void refrescar(); else await refrescar();
  const fechas = [];
  for (let k = n - 1; k >= 0; k--) fechas.push(fechaLocal(Date.now() - k * 86400000));
  const porDia = [];
  const porSesion = new Map();
  const porModelo = new Map();
  const totales = [0, 0, 0, 0];
  for (const f of fechas) {
    const dia = [0, 0, 0, 0];
    for (const [ses, v] of Object.entries(dias[f] || {})) {
      const acc = porSesion.get(ses) || [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) { dia[k] += v[k]; acc[k] += v[k]; totales[k] += v[k]; }
      porSesion.set(ses, acc);
    }
    for (const [mod, v] of Object.entries(modelos[f] || {})) {
      const acc = porModelo.get(mod) || [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) acc[k] += v[k];
      porModelo.set(mod, acc);
    }
    porDia.push({ fecha: f, v: dia });
  }
  const porCarpeta = new Map();
  const sesiones = [...porSesion.entries()].map(([id, v]) => {
    const f = ficha(id);
    const c = porCarpeta.get(f.proyecto) || [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) c[k] += v[k];
    porCarpeta.set(f.proyecto, c);
    return { id, ...f, v };
  }).sort((a, b) => total(b.v) - total(a.v));
  return {
    dias: n, desde: fechas[0], hasta: fechas[fechas.length - 1],
    calculando: primeraPasada || (!!enCurso && !ultimaPasada),
    actualizado: ultimaPasada, totales, porDia,
    sesiones: sesiones.slice(0, 15),
    carpetas: [...porCarpeta.entries()].map(([proyecto, v]) => ({ proyecto, v }))
      .sort((a, b) => total(b.v) - total(a.v)),
    modelos: [...porModelo.entries()].map(([modelo, v]) => ({ modelo, v }))
      .sort((a, b) => total(b.v) - total(a.v)),
  };
}

/** Lo que lleva gastado una sesión, sumando todos sus días. */
export function deSesion(id) {
  const v = [0, 0, 0, 0];
  let hay = false;
  for (const d of Object.values(dias)) {
    const s = d[id];
    if (!s) continue;
    hay = true;
    for (let k = 0; k < 4; k++) v[k] += s[k];
  }
  return hay ? v : null;
}

/** Arranca la primera pasada en segundo plano, lejos del arranque del panel. */
export function iniciar() {
  setTimeout(() => { void refrescar(); }, 15000).unref?.();
}
