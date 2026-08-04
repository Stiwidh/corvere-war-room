/**
 * Genera las capturas del README contra el modo demostración.
 *
 *   WARROOM_DEMO=1 WARROOM_PORT=7799 node server.mjs &
 *   node capturas.mjs
 *
 * Habla con Chrome por CDP en vez de usar `--screenshot` a secas, por dos
 * motivos: hay que ESPERAR a que llegue el primer envío por SSE y a que las
 * físicas coloquen los nodos (con `--screenshot` sale el panel vacío o los
 * pulpos amontonados en el centro), y hay que poder abrir el detalle de una
 * sesión antes de disparar la segunda foto.
 *
 * Sale a 2x: el panel dibuja el canvas según `devicePixelRatio`, así que con
 * `--force-device-scale-factor=2` el mapa se rasteriza al doble y el texto
 * pequeño aguanta que alguien amplíe la imagen.
 *
 * Sin dependencias: Chrome, el WebSocket que trae Node 22 y nada más.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_BASE = process.env.WARROOM_URL || 'http://127.0.0.1:7799';
const SALIDA = process.env.WARROOM_CAPTURAS || path.join(import.meta.dirname, 'docs');
const PUERTO_CDP = 9333;
const ANCHO = 1920, ALTO = 1080, ESCALA = 2;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome del sistema, o el que se haya bajado Playwright. */
function buscarChrome() {
  const fijos = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
                 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const c of fijos) if (fssync.existsSync(c)) return c;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of fssync.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const c = path.join(cache, d, 'chrome-linux', 'chrome');
      if (fssync.existsSync(c)) return c;
    }
  } catch { /* no hay caché de playwright */ }
  return null;
}

/** Cliente CDP mínimo: manda métodos y espera su respuesta por id. */
function conectar(url) {
  const ws = new WebSocket(url);
  const pendientes = new Map();
  let n = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const p = pendientes.get(m.id);
    if (!p) return;
    pendientes.delete(m.id);
    m.error ? p.rechaza(new Error(m.error.message)) : p.cumple(m.result);
  });
  const listo = new Promise((r, x) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', () => x(new Error('no he podido hablar con Chrome')));
  });
  const enviar = (method, params = {}) => new Promise((cumple, rechaza) => {
    const id = ++n;
    pendientes.set(id, { cumple, rechaza });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { listo, enviar, cerrar: () => ws.close() };
}

async function main() {
  const chrome = buscarChrome();
  if (!chrome) { console.error('No encuentro Chrome ni Chromium.'); process.exit(1); }

  const perfil = await fs.mkdtemp(path.join(os.tmpdir(), 'warroom-capturas-'));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--remote-debugging-port=${PUERTO_CDP}`, `--user-data-dir=${perfil}`,
    `--window-size=${ANCHO},${ALTO}`, `--force-device-scale-factor=${ESCALA}`,
    URL_BASE,
  ], { stdio: 'ignore' });

  try {
    // el puerto tarda un momento en abrir
    let objetivo = null;
    for (let i = 0; i < 40 && !objetivo; i++) {
      await esperar(250);
      try {
        const lista = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/list`).then((r) => r.json());
        objetivo = lista.find((t) => t.type === 'page' && t.url.startsWith('http'));
      } catch { /* aún no responde */ }
    }
    if (!objetivo) throw new Error('Chrome no ha levantado el puerto de depuración');

    const cdp = conectar(objetivo.webSocketDebuggerUrl);
    await cdp.listo;

    await fs.mkdir(SALIDA, { recursive: true });
    const disparar = async (nombre) => {
      const { data } = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
      const destino = path.join(SALIDA, nombre);
      await fs.writeFile(destino, Buffer.from(data, 'base64'));
      const b = await fs.readFile(destino);
      console.log(`  ${nombre}  ${b.readUInt32BE(16)}x${b.readUInt32BE(20)} px · ${(b.length / 1024).toFixed(0)} KB`);
    };

    const evaluar = (expr) => cdp.enviar('Runtime.evaluate', { expression: expr, returnByValue: true });

    // margen para el primer SSE y para que los muelles coloquen los nodos
    console.log('esperando a que la flota se asiente...');
    await esperar(6000);
    await disparar('mapa.png');

    // El detalle de la sesión con más agentes. El mapa es un canvas, así que en
    // vez de clicar a ciegas sobre un píxel se repite lo que hace el clic:
    // `Pulpos.enfocar` es lo que abre el mapa en modo foco, y sin esa llamada
    // sale la ficha pero el mapa se queda como estaba.
    await evaluar(`(() => {
      const s = state.sessions.slice().sort((a, b) => b.agents.length - a.agents.length)[0];
      openId = s.id; Pulpos.enfocar(s.id); render();
      return s.project;
    })()`);
    await esperar(5000);   // el foco entra con animación
    await disparar('detalle.png');

    cdp.cerrar();
  } finally {
    proc.kill();
    await fs.rm(perfil, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
