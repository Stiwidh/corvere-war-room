/**
 * Flota de demostración.
 *
 * Con `WARROOM_DEMO=1` el servidor sirve esto en lugar de tus transcripts. Existe
 * por dos motivos:
 *
 *  1. Quien acaba de clonar el repo no tiene cinco sesiones de Claude Code
 *     abiertas, así que vería un panel vacío y cerraría la pestaña.
 *  2. Las capturas del README se hacen aquí. Ni un nombre real, y siempre en el
 *     mismo momento bueno: agentes trabajando y mensajes en vuelo.
 *
 * No hay estado ni azar: todo se deriva del reloj, así que la escena avanza sola
 * (un mensaje nuevo cada pocos segundos) y dos capturas del mismo segundo salen
 * idénticas.
 */

// misma paleta que server.mjs; se repite aquí para no crear un ciclo de imports
const PAL = ['#9810FA', '#E60076', '#00E68C', '#FFB547', '#6fb1ff',
             '#c084fc', '#ff9ec9', '#00c2b8', '#f97362', '#8b8ef7'];

const RITMO = 3;            // un mensaje nuevo cada 3 s
const T0 = 1767225600;      // origen fijo de la serie de mensajes (1 ene 2026)

/** Los agentes de la sesión grande. El prefijo repetido es a propósito: el mapa
 *  descarta las palabras que comparten los hermanos, así que estos cinco salen
 *  como SE, PE, TE, TY y A en vez de cinco "RE" indistinguibles. */
const EQUIPO_GRANDE = [
  ['review-security', 'revisa autenticación y permisos'],
  ['review-perf', 'perfila las consultas lentas'],
  ['review-tests', 'cobertura del checkout'],
  ['review-types', 'tipos del contrato de pago'],
  ['review-a11y', 'accesibilidad del formulario'],
  ['explore-rutas', 'mapa de las rutas afectadas'],
  ['explore-esquema', 'de dónde cuelga la tabla pedidos'],
  ['plan-rollout', 'orden de despliegue sin caídas'],
  ['db-migrator', 'migración de la tabla pedidos'],
  ['api-designer', 'contrato del webhook de pago'],
  ['docs-writer', 'changelog y guía de migración'],
  ['refactor-carrito', 'saca la lógica de precios del componente'],
];

const EQUIPO_MEDIO = [
  ['explore-componentes', 'inventario de tarjetas duplicadas'],
  ['ui-tablas', 'tabla de clientes con orden y filtro'],
  ['ui-filtros', 'filtros que sobreviven a la recarga'],
  ['api-clientes', 'endpoint de listado paginado'],
  ['tests-e2e', 'recorrido completo de alta de cliente'],
  ['audit-consultas', 'busca las llamadas sin índice'],
];

const EQUIPO_CHICO = [
  ['docs-referencia', 'referencia de la API pública'],
  ['docs-ejemplos', 'ejemplos que compilan'],
];

const ACCIONES = [
  ['Edit', 'src/checkout/precios.ts'],
  ['Read', 'src/checkout/carrito.tsx'],
  ['Bash', 'npm test -- checkout'],
  ['Grep', 'calcularTotal'],
  ['Write', 'tests/precios.test.ts'],
  ['Read', 'db/esquema.sql'],
  ['Edit', 'src/api/pedidos.ts'],
  ['Bash', 'npx tsc --noEmit'],
];

/** Acciones recientes de un agente, con el reloj corriendo por detrás. */
function recientes(ahora, semilla, cuantas = 6) {
  const out = [];
  for (let i = 0; i < cuantas; i++) {
    const [tool, d] = ACCIONES[(semilla + i * 3) % ACCIONES.length];
    out.push({ t: ahora - (i * 11 + (semilla % 7)), tool, d });
  }
  return out;
}

function agente(ahora, i, [name, title], opts = {}) {
  const vivo = opts.retired ? 400 : (i * 7) % 38;   // < 45 s = se ve encendido
  return {
    name, title, type: name.split('-')[0],
    born: ahora - 900 - i * 60,
    last: ahora - vivo,
    acts: 12 + ((i * 17) % 40),
    toks: 40000 + ((i * 9973) % 260000),
    msgs: (i * 3) % 5,
    action: ACCIONES[(i * 5) % ACCIONES.length][1],
    tool: ACCIONES[(i * 5) % ACCIONES.length][0],
    color: PAL[i % PAL.length],
    dice: '',
    retired: !!opts.retired,
    recent: recientes(ahora, i * 5),
  };
}

/**
 * Mensajes de la sesión grande. La serie es infinita y se recorta a los últimos:
 * cada `RITMO` segundos entra uno nuevo, que es lo que hace que en el mapa se
 * vean viajar por el cable en vez de quedarse quietos.
 */
const RUTAS = [
  ['review-security', 'db-migrator', true, 'la migración deja permisos abiertos en pedidos'],
  ['explore-esquema', 'db-migrator', true, 'pedidos cuelga de clientes por cliente_id, ojo al borrado'],
  ['review-perf', 'api-designer', true, 'el listado hace N+1, hace falta índice en pedido_id'],
  ['review-tests', 'refactor-carrito', true, 'si sacas precios, tres tests apuntan al sitio viejo'],
  ['api-designer', 'LEAD', false, 'contrato del webhook cerrado, firmado con HMAC'],
  ['review-types', 'api-designer', true, 'el tipo de importe va en céntimos, no en euros'],
  ['db-migrator', 'LEAD', false, 'migración lista, falta tu OK para tocar producción'],
  ['plan-rollout', 'review-security', true, 'necesito tu visto bueno antes de la fase 2'],
  ['review-a11y', 'refactor-carrito', true, 'el input de cupón se queda sin etiqueta'],
  ['docs-writer', 'LEAD', false, 'changelog escrito, faltan los ejemplos'],
];

function mensajes(ahora, cuantos = 16) {
  const ultimo = Math.floor((ahora - T0) / RITMO);
  const out = [];
  for (let k = Math.max(0, ultimo - cuantos + 1); k <= ultimo; k++) {
    const [from, to, lateral, summary] = RUTAS[k % RUTAS.length];
    out.push({ t: T0 + k * RITMO, from, to, lateral, summary });
  }
  return out;
}

function sesion(ahora, cfg) {
  const agentes = (cfg.equipo || []).map((a, i) =>
    agente(ahora, i, a, { retired: i >= (cfg.vivos ?? cfg.equipo?.length ?? 0) }));
  const msgs = cfg.mensajes ? mensajes(ahora) : [];
  return {
    id: cfg.id,
    project: cfg.repo,
    cwd: `/home/dev/proyectos/${cfg.repo}`,
    branch: cfg.rama,
    status: cfg.estado,
    idle: Math.round(cfg.idle),
    idleLider: Math.round(cfg.idleLider ?? cfg.idle),
    acts: cfg.acts,
    up: msgs.filter((m) => !m.lateral).length,
    lat: cfg.lat ?? msgs.filter((m) => m.lateral).length,
    toks: cfg.toks,
    startedAt: ahora - cfg.viva,
    lastActivity: ahora - cfg.idle,
    hasTeam: !!cfg.equipo?.length,
    git: cfg.git || null,
    doc: cfg.doc || null,
    colgando: cfg.colgando || 0,
    escritos: (cfg.escritos || []).map(([ruta, hace, quien]) =>
      ({ ruta, t: Math.round(ahora - hace), quien })),
    lead: {
      last: cfg.leadAccion || '',
      lastAt: ahora - cfg.idleLider ?? cfg.idle,
      tool: cfg.leadTool || '',
      acts: Math.round(cfg.acts * 0.4),
      toks: Math.round(cfg.toks * 0.3),
      recent: recientes(ahora, 2, 8),
    },
    tasks: cfg.tareas || [],
    messages: msgs,
    agents: agentes,
  };
}

export function flota(ahora) {
  const sessions = [
    sesion(ahora, {
      id: 'a1c9f4e2-demo-0001', repo: 'checkout-api', rama: 'feat/pago-aplazado',
      estado: 'working', idle: 4, idleLider: 4, viva: 7400,
      acts: 1487, toks: 3_120_000, equipo: EQUIPO_GRANDE, vivos: 9, mensajes: true,
      leadTool: 'Edit', leadAccion: 'src/checkout/precios.ts',
      git: { sucios: 7, sinSeguir: 1, sinSubir: 2, ultimoCommit: ahora - 5400 },
      doc: { semaforo: '🟡', texto: 'pago aplazado, falta el webhook de confirmación' },
      colgando: 3,
      escritos: [['src/checkout/precios.ts', 90, 'refactor-carrito'],
                 ['db/2026_pedidos.sql', 300, 'db-migrator']],
      tareas: [
        { id: '1', subject: 'Migrar la tabla pedidos', status: 'completed', owner: 'db-migrator', blockedBy: [] },
        { id: '2', subject: 'Contrato del webhook de pago', status: 'in_progress', owner: 'api-designer', blockedBy: [] },
        { id: '3', subject: 'Sacar los precios del componente', status: 'in_progress', owner: 'refactor-carrito', blockedBy: [] },
        { id: '4', subject: 'Desplegar la fase 2', status: 'pending', owner: 'plan-rollout', blockedBy: ['2', '3'] },
      ],
    }),
    sesion(ahora, {
      id: 'b7d2e8a1-demo-0002', repo: 'checkout-api', rama: 'fix/cupones',
      estado: 'waiting', idle: 190, viva: 2600, acts: 212, toks: 410_000,
      leadTool: 'Bash', leadAccion: 'npm test -- cupones',
      git: { sucios: 2, sinSeguir: 0, sinSubir: 0, ultimoCommit: ahora - 1200 },
    }),
    sesion(ahora, {
      id: 'c3e5b9d7-demo-0003', repo: 'panel-clientes', rama: 'main',
      estado: 'agents', idle: 12, idleLider: 320, viva: 5100,
      acts: 934, toks: 2_050_000, equipo: EQUIPO_MEDIO, vivos: 5, lat: 41,
      leadTool: 'Agent', leadAccion: 'esperando a los seis agentes',
      git: { sucios: 4, sinSeguir: 2, sinSubir: 1, ultimoCommit: ahora - 9000 },
      doc: { semaforo: '🟢', texto: 'listado de clientes con filtros persistentes' },
      colgando: 2,
      tareas: [
        { id: '1', subject: 'Tabla de clientes con orden', status: 'in_progress', owner: 'ui-tablas', blockedBy: [] },
        { id: '2', subject: 'Filtros que sobreviven a la recarga', status: 'in_progress', owner: 'ui-filtros', blockedBy: [] },
      ],
    }),
    sesion(ahora, {
      id: 'd9a4c1f6-demo-0004', repo: 'infra', rama: 'main',
      estado: 'waiting', idle: 14700, viva: 21000, acts: 356, toks: 780_000,
      leadTool: 'Read', leadAccion: 'docker-compose.yml',
      git: { sucios: 11, sinSeguir: 3, sinSubir: 0, ultimoCommit: ahora - 172800 },
      doc: { semaforo: '🟠', texto: 'a medias: falta el healthcheck del worker' },
      colgando: 5,
    }),
    sesion(ahora, {
      id: 'e2f7b3c8-demo-0005', repo: 'sitio-docs', rama: 'docs/api-v2',
      estado: 'working', idle: 7, viva: 1500, acts: 148, toks: 320_000,
      equipo: EQUIPO_CHICO, vivos: 2,
      leadTool: 'Write', leadAccion: 'docs/api/v2.md',
      git: { sucios: 3, sinSeguir: 1, sinSubir: 0, ultimoCommit: ahora - 600 },
    }),
  ];

  /* Dos sesiones hablándose. No es un equipo: son dos ventanas distintas, cada una con su
     contexto, coordinándose para no pisarse en el mismo repo. Va en el demo porque es la
     mitad de lo que enseña el panel y sin ella el capítulo entero sale vacío en las
     capturas.

     IMPACT-OK: añadido aditivo al final de `flota()`, el único export que usa nadie
     (`server.mjs` lo importa solo si WARROOM_DEMO=1, y `capturas.mjs` lo arranca así para
     las imágenes del README). No toca ninguna de las cinco sesiones ya definidas: añade
     `cruces` a dos de ellas y el `enlaces` del snapshot, que es justo lo que el servidor
     real calcula ahora. Sin producción implicada: datos inventados para un panel local. */
  const charla = [
    ['out', 620, 'Toco precios.ts y la migración de pedidos, no entres ahí'],
    ['in', 560, 'Recibido. Yo me quedo en cupones, no me acerco a precios'],
    ['out', 240, 'Migración aplicada, ya puedes rebasar'],
    ['in', 90, 'Rebasado y en verde. Subo cuando acabes tú'],
  ];
  const dos = { id: 'b7d2e8a1-demo-0002', nombre: 'checkout-api-7f', proy: 'checkout-api' };
  const uno = { id: 'a1c9f4e2-demo-0001', nombre: 'checkout-api-2c', proy: 'checkout-api' };
  const cruce = (otro, invertido) => charla.map(([dir, hace, summary]) => ({
    t: ahora - hace, dir: invertido ? (dir === 'out' ? 'in' : 'out') : dir,
    quien: 'team-lead', pid: 0, ok: true, fallo: '', summary,
    otroId: otro.id, otroNombre: otro.nombre, otroProy: otro.proy, otroVivo: true,
  }));
  sessions[0].nombre = uno.nombre; sessions[0].cruces = cruce(dos, false); sessions[0].cross = charla.length;
  sessions[1].nombre = dos.nombre; sessions[1].cruces = cruce(uno, true);  sessions[1].cross = charla.length;

  const enlaces = [{
    a: uno.id, aNombre: uno.nombre, aProy: uno.proy,
    b: dos.id, bRef: dos.id, bNombre: dos.nombre, bProy: dos.proy, bVivo: true,
    enviados: 2, recibidos: 2, fallidos: 0, n: 4,
    ultimo: ahora - 90, ultimoTexto: charla[charla.length - 1][2],
  }];
  return { now: ahora, error: null, aviso: null, sessions, enlaces };
}
