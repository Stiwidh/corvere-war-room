/* Corvere War Room — cliente. Pinta la flota y el detalle de una sesión. */

const $ = (id) => document.getElementById(id);

const WORKING = 45;      // segundos sin escribir para dejar de estar "trabajando"
const THINKING = 150;

let state = { sessions: [], now: 0 };
let openId = null;       // sesión abierta en detalle
let verCerradas = false; // el cajón de las que ya no están

/* ── formato ── */
function ago(sec) {
  if (sec == null || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) { const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60); return m ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.floor(sec / 86400)} d ${Math.round((sec % 86400) / 3600)} h`;
}
const num = (n) => (n || 0).toLocaleString('es');
const clock = (t) => new Date(t * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const kindClass = (n) => ({ Read: 'read', Write: 'edit', Edit: 'edit', Bash: 'bash', Grep: 'grep', Glob: 'grep' })[n] || 'other';
const ESTADO = {
  working: 'trabajando',
  agents: 'agentes al lío',   // el líder está parado pero sus agentes no: tú estás libre
  waiting: 'te espera',
  closed: 'cerrada',
};

/* ── conexión ── */
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try { state = JSON.parse(e.data); } catch { return; }
    $('sub').innerHTML = `<span class="live-dot"></span> ${state.sessions.length} sesiones · ${new Date().toLocaleTimeString('es')}`;
    render();
  };
  es.onerror = () => {
    $('sub').innerHTML = '<span class="live-dot off"></span> sin conexión con el servidor';
  };
}

/* ── el icono de la pestaña avisa ──
   Ámbar en cuanto alguna sesión te reclama, verde si la flota está a lo suyo,
   gris si no hay nada vivo. Así el aviso llega aunque el panel esté en otro
   monitor o en una pestaña de fondo. El punto se busca por su id en el SVG y no
   por su color: el hex aparece más de una vez en el fichero y un replace de
   texto pintaba el comentario en vez del círculo. */
const ICONO = { espera: '#FFB547', activa: '#00E68C', vacia: '#5A5766' };
let iconoBase = null;    // promesa del SVG plantilla, se pide una sola vez
let iconoColor = null;

function pintarFavicon(color) {
  if (color === iconoColor) return;
  iconoColor = color;
  iconoBase ??= fetch('/favicon.svg').then((r) => r.text());
  iconoBase
    .then((svg) => {
      const pintado = svg.replace(/(<circle id="estado"[^>]*fill=")[^"]*/, `$1${iconoColor}`);
      $('favicon').href = `data:image/svg+xml,${encodeURIComponent(pintado)}`;
    })
    .catch(() => { iconoBase = null; });   // si falló, se reintenta al siguiente cambio
}

/* ── render principal ── */
function render() {
  const s = state.sessions;
  const working = s.filter((x) => x.status === 'working').length;
  const conAgentes = s.filter((x) => x.status === 'agents').length;
  const waiting = s.filter((x) => x.status === 'waiting').length;
  const agents = s.reduce((n, x) => n + x.agents.filter((a) => !a.retired).length, 0);
  const lat = s.reduce((n, x) => n + x.lat, 0);
  const olvidada = s.filter((x) => x.status === 'waiting').sort((a, b) => b.idle - a.idle)[0];

  $('kpis').innerHTML = `
    ${state.aviso ? `<div class="kpi warn" title="${state.aviso}"><span class="lab">Ojo</span><span class="val" style="font-size:13px">${state.avisoCorto || 'detección parcial'}</span></div>` : ''}
    <div class="kpi"><span class="lab">Trabajando</span><span class="val">${working}</span></div>
    ${conAgentes ? `<div class="kpi"><span class="lab">Agentes al lío</span><span class="val" style="color:var(--accent-soft)">${conAgentes}</span></div>` : ''}
    <div class="kpi warn"><span class="lab">Te esperan</span><span class="val">${waiting}</span></div>
    <div class="kpi"><span class="lab">Agentes vivos</span><span class="val">${agents}</span></div>
    <div class="kpi ${lat ? 'hot' : ''}"><span class="lab">Laterales</span><span class="val tnum">${lat}</span></div>
    ${olvidada ? `<div class="kpi warn"><span class="lab">Más olvidada</span><span class="val" style="font-size:13px">${olvidada.project.slice(0, 16)} · ${ago(olvidada.idle)}</span></div>` : ''}`;

  pintarFavicon(waiting ? ICONO.espera
    : (working || conAgentes) ? ICONO.activa
    : ICONO.vacia);

  if (openId) {
    const ses = s.find((x) => x.id === openId);
    if (ses) return renderDetail(ses);
    openId = null;   // la sesión desapareció mientras la mirábamos
  }
  renderFleet(s);
}

/* ── vista flota: mapa arriba, tarjetas debajo ── */
function renderFleet(list) {
  $('detail').hidden = true; $('back').hidden = true;
  $('mapaPanel').hidden = false;
  $('b-replay').hidden = true;
  if ($('mapaPanel').classList.contains('enfocado')) {
    $('mapaPanel').classList.remove('enfocado');
    setTimeout(() => Pulpos.medir(), 330);
  }
  // al motor solo van las abiertas, más la que estés mirando en detalle
  Pulpos.sync(list.filter((s) => s.status !== 'closed' || s.id === openId), state.now);
  const agentesVivos = list.reduce((n, s) => n + s.agents.filter((a) => !a.retired).length, 0);
  // el mapa es el presente: las cerradas no lo ensucian, viven en su cajón
  const cerradas = list.filter((s) => s.status === 'closed');
  $('b-cerradas').hidden = !cerradas.length;
  $('b-cerradas').textContent = `cerradas (${cerradas.length})`;
  $('b-cerradas').setAttribute('aria-pressed', String(verCerradas));
  $('cerradasPanel').hidden = !verCerradas || !cerradas.length;
  if (verCerradas && cerradas.length) pintarCerradas(cerradas);

  $('mapanote').textContent = `${list.length - cerradas.length} sesiones abiertas · ${agentesVivos} agentes`
    + ` · arrastra para colocar · clic en una cabeza para entrar`;
  if (!list.length) {
    $('mapanote').textContent = 'ninguna sesión de Claude Code abierta ahora mismo';
  }
}

/** El cajón de las cerradas: no ensucian el mapa pero siguen a un clic. */
function pintarCerradas(list) {
  $('cerradas').innerHTML = list
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((s) => `
      <div class="task" data-cerrada="${s.id}" style="cursor:pointer">
        <span class="id mono">✕</span>
        <span class="s"><b style="color:var(--txt)">${s.project}</b>
          · cerró hace ${ago(state.now - s.lastActivity)}
          · ${num(s.acts)} acciones · ${num(s.toks)} tokens
          ${s.agents.length ? ` · ${s.agents.length} agentes` : ''}</span>
        <span class="own">▶ reproducir</span>
      </div>`).join('');
  $('cerradas').querySelectorAll('[data-cerrada]').forEach((el) => {
    el.addEventListener('click', () => {
      openId = el.dataset.cerrada;
      Pulpos.enfocar(openId);
      render();
      abrirReplay(openId);
    });
  });
}

/* ── vista detalle ── */
function renderDetail(s) {
  $('detail').hidden = false; $('back').hidden = false;
  $('mapaPanel').hidden = false;
  $('cerradasPanel').hidden = true;
  $('b-cerradas').hidden = true;
  if (!$('mapaPanel').classList.contains('enfocado')) {
    $('mapaPanel').classList.add('enfocado');
    setTimeout(() => Pulpos.medir(), 330);
  }
  $('dtitle').innerHTML = `${s.project} <span class="note">${s.cwd} · ${ESTADO[s.status]}${s.status === 'waiting' ? ' desde hace ' + ago(s.idle) : ''}</span>`;

  const vivos = s.agents.filter((a) => !a.retired);
  const muertos = s.agents.filter((a) => a.retired);
  // el mismo lienzo de siempre, enfocado en esta sesión: nada de un grafo aparte
  if (Pulpos.replayEstado()) return;   // en replay manda el transcript, no el vivo
  $('mapanote').textContent = `${s.project} · ${vivos.length} agentes vivos · ${muertos.length} retirados`;
  $('b-replay').hidden = false;
  Pulpos.sync(state.sessions, state.now);

  // la ficha que antes vivía en la tarjeta del mapa
  $('fichaSes').innerHTML = `
    <div class="cmeta">
      <span>${s.branch || 'sin rama'}</span><span>${s.id.slice(0, 8)}</span>
      ${s.hasTeam ? '<span style="color:var(--accent-soft)">equipo</span>' : ''}
      <span>arrancó ${ago(state.now - s.startedAt)} atrás</span>
    </div>
    <div class="cleft"><span class="l">dónde lo dejaste</span>${s.lead.last || '—'}</div>
    <div class="cstats">
      <div class="cstat"><span class="l">acciones</span><span class="v tnum">${num(s.acts)}</span></div>
      <div class="cstat"><span class="l">tokens</span><span class="v tnum">${num(s.toks)}</span></div>
      <div class="cstat"><span class="l">al líder</span><span class="v tnum">${s.up}</span></div>
      <div class="cstat lat"><span class="l">laterales</span><span class="v tnum">${s.lat}</span></div>
    </div>`;

  /* el hilo principal es la primera columna: la mayoría de las sesiones no
     lanzan agentes y sin esto el detalle sale vacío aunque esté a full */
  const lider = {
    name: '__lead__', title: 'hilo principal', type: 'Claude Code',
    born: s.startedAt, last: s.lead.lastAt, acts: s.lead.acts, toks: s.lead.toks,
    msgs: s.messages.filter((m) => m.from === 'team-lead').length,
    action: (s.lead.last || '').replace(/^\S+\s*/, ''), tool: s.lead.tool,
    recent: s.lead.recent || [], color: '#9810FA', esLider: true,
  };

  /* columnas */
  const cont = $('cols'); const keep = new Set();
  [lider, ...vivos].forEach((a, i) => {
    keep.add(a.name);
    let d = cont.querySelector(`[data-a="${CSS.escape(a.name)}"]`);
    if (!d) {
      d = document.createElement('div'); d.dataset.a = a.name; d.className = 'agent';
      d.innerHTML = `<div class="ahead">
          <div class="arow"><span class="led"></span><span class="aname"></span><span class="astate"></span></div>
          <div class="atype"></div><div class="now"></div></div>
        <div class="stream"></div>
        <div class="afoot">
          <div class="met"><span class="l">acciones</span><span class="v tnum"></span></div>
          <div class="met"><span class="l">tokens</span><span class="v tnum"></span></div>
          <div class="met"><span class="l">mensajes</span><span class="v tnum"></span></div>
          <div class="met"><span class="l">vive</span><span class="v"></span></div></div>`;
      cont.appendChild(d);
    }
    d.style.order = i;
    const since = state.now - a.last;
    d.className = 'agent' + (a.esLider ? ' lider' : '')
      + (since < WORKING ? ' live' : since < THINKING ? ' think' : '');
    d.querySelector('.aname').textContent = a.title || a.name;
    d.querySelector('.astate').textContent = since < WORKING ? 'trabajando' : since < THINKING ? 'pensando' : 'parado ' + ago(since);
    d.querySelector('.atype').textContent = a.type || '';
    d.querySelector('.now').innerHTML = `<b>${a.tool || ''}</b> ${a.action || ''}`;
    d.querySelector('.stream').innerHTML = a.recent.map((r) => `
      <div class="ev ${r.msg ? 'msg' : ''} ${r.lateral ? 'lat' : ''} ${r.dice ? 'dice' : ''}">
        <span class="t">${clock(r.t)}</span>
        <span class="k ${r.msg ? 'send' : r.dice ? 'say' : kindClass(r.tool)}">${r.msg ? '✉' : r.tool}</span>
        <span class="d">${r.d || ''}</span></div>`).join('');
    const m = d.querySelectorAll('.afoot .v');
    m[0].textContent = a.acts; m[1].textContent = num(a.toks);
    m[2].textContent = a.msgs; m[3].textContent = ago(a.last - a.born);
  });
  for (const el of [...cont.children]) if (!keep.has(el.dataset.a)) el.remove();

  /* retirados */
  $('morguePanel').hidden = !muertos.length;
  $('morguenote').textContent = `${muertos.length} de ${s.agents.length}`;
  $('morgue').innerHTML = muertos.map((a) => `<span class="tomb">
      <span class="nm">${(a.title || a.name).slice(0, 30)}</span><span class="x">·</span>${ago(a.last - a.born)}
      <span class="x">·</span>${a.acts} acciones<span class="x">·</span>${Math.round(a.toks / 1000)}k</span>`).join('');

  /* tablero */
  $('tasknote').textContent = s.tasks.length ? `${s.tasks.filter((t) => t.status === 'completed').length}/${s.tasks.length} hechas` : 'no existe';
  $('tasks').innerHTML = s.tasks.length
    ? s.tasks.map((t) => `<div class="task ${t.blockedBy.length ? 'blocked' : t.status}">
        <span class="id mono">${t.id}</span><span class="s">${t.subject}</span>
        <span class="own">${t.blockedBy.length ? 'bloq ' + t.blockedBy.join(',') : (t.owner || 'libre')}</span></div>`).join('')
    : `<div class="empty">Esta sesión <b>no tiene tablero compartido</b>.<br>Sin <code>blockedBy</code>,
       ninguna dependencia entre agentes es estructural.</div>`;

  /* mensajes */
  $('msgnote').textContent = `${s.up + s.lat} mensajes · ${s.lat} laterales`;
  $('feed').innerHTML = [...s.messages].reverse().map((m) => `
    <div class="msg ${m.lateral ? 'lat' : 'up'}">
      <div class="hd"><span class="tm">${clock(m.t)}</span><span class="fr">${m.from}</span>
        <span class="ar">→</span><span class="to">${m.to}</span>
        <span class="tag">${m.lateral ? 'lateral' : 'al líder'}</span></div>
      <div class="bd">${m.summary}</div></div>`).join('')
    || '<div class="empty">Todavía ningún mensaje entre agentes.</div>';

}

Pulpos.init($('mapa'), $('ficha'), {
  alClicarLider: (id) => { openId = id; Pulpos.enfocar(id); render(); },
});
$('b-soltar').addEventListener('click', () => Pulpos.soltarTodos());
$('b-plegar').addEventListener('click', (e) => {
  const p = $('mapaPanel').classList.toggle('plegado');
  e.target.textContent = p ? 'desplegar' : 'plegar';
  if (!p) setTimeout(() => Pulpos.medir(), 320);
});
/* ── replay de una sesión: la autopsia ── */
const hhmmss = (s) => [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60 | 0]
  .map((v) => String(v | 0).padStart(2, '0')).join(':');

async function abrirReplay(id) {
  const r = await fetch('/api/replay?id=' + encodeURIComponent(id));
  if (!r.ok) return;
  const datos = await r.json();
  $('barraReplay').hidden = false;
  $('b-replay').hidden = true;
  $('mapanote').textContent = `${datos.project} · replay de ${Math.round(datos.duracion / 60)} min · ${datos.agentes.length} agentes`;
  Pulpos.empezarReplay(datos, (rp) => {
    $('r-fill').style.width = (rp.t / rp.datos.duracion * 100) + '%';
    $('r-clock').textContent = `${hhmmss(rp.t)} / ${hhmmss(rp.datos.duracion)}`;
    $('r-play').textContent = rp.playing ? '⏸' : '▶';
  });
}
function cerrarReplay() {
  Pulpos.pararReplay();
  // pararReplay suelta el foco; si seguimos dentro de una sesión hay que
  // devolverlo, o el detalle se queda enseñando el mapa entero apretado
  if (openId) Pulpos.enfocar(openId);
  $('barraReplay').hidden = true;
  $('b-replay').hidden = !openId;
  render();
}
$('b-replay').addEventListener('click', () => openId && abrirReplay(openId));
$('b-cerradas').addEventListener('click', () => { verCerradas = !verCerradas; render(); });

/* ── el mapa del día: dónde se fue el tiempo ── */
const PAL_DIA = ['#9810FA', '#E60076', '#00E68C', '#FFB547', '#6fb1ff', '#00c2b8'];
let verDia = false;
$('b-dia').addEventListener('click', async () => {
  verDia = !verDia;
  $('diaPanel').hidden = !verDia;
  $('b-dia').setAttribute('aria-pressed', String(verDia));
  if (!verDia) return;
  const d = await (await fetch('/api/dia?dias=1')).json();
  const h0 = new Date(d.desde * 1000);
  const solapado = d.proyectos.reduce((n, p) => n + p.activas, 0);
  $('dianote').textContent = `últimas 24 h · ${d.proyectos.length} proyectos · `
    + `${Math.round(solapado * d.franja_s / 3600)} h de trabajo sumadas`;
  $('dia').innerHTML = d.proyectos.map((p, i) => {
    const mx = Math.max(...p.barras) || 1;
    const col = PAL_DIA[i % PAL_DIA.length];
    const tira = p.barras.map((b) => {
      const h = b ? Math.max(2, Math.round(b / mx * 26)) : 0;
      return `<div class="dia-b" style="height:${h}px;background:${col};opacity:${b ? 0.35 + 0.65 * (b / mx) : 0}"></div>`;
    }).join('');
    const horas = Math.floor(p.activas * d.franja_s / 3600);
    const mins = Math.round((p.activas * d.franja_s % 3600) / 60);
    return `<div class="dia-fila">
        <span class="dia-nombre" style="color:${col}">${p.nombre}</span>
        <div class="dia-tira">${tira}</div>
        <span class="dia-tot">${horas}h${String(mins).padStart(2, '0')} · ${num(p.total)} ev</span>
      </div>`;
  }).join('') + `<div class="dia-horas">${
    Array.from({ length: 12 }, (_, i) => {
      const t = new Date(h0.getTime() + i * 2 * 3600 * 1000);
      return `<span>${String(t.getHours()).padStart(2, '0')}h</span>`;
    }).join('')}</div>`;
});
$('r-play').addEventListener('click', () => Pulpos.replayPausa());
$('r-salir').addEventListener('click', cerrarReplay);
document.querySelectorAll('.r-vel').forEach((b) => b.addEventListener('click', () => {
  const rp = Pulpos.replayEstado();
  if (rp) Pulpos.replayVelocidad((rp.datos.duracion / 90) * Number(b.dataset.v));
  document.querySelectorAll('.r-vel').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
}));
$('r-track').addEventListener('click', (e) => {
  const r = $('r-track').getBoundingClientRect();
  Pulpos.replaySaltar(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
});

const volver = () => {
  if (Pulpos.replayEstado()) return cerrarReplay();
  openId = null; Pulpos.enfocar(null); render();
};
$('back').addEventListener('click', volver);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) volver(); });

/* ── Grafo del código ────────────────────────────────────────────────────────
 * Solo se dibuja si el servidor encuentra el JSON que exporta APPs/CORVERE_GRAPH.
 * En una máquina sin grafo devuelve 404 y esta sección no aparece jamás.
 *
 * La pregunta que responde no es "cuántos nodos tiene" (eso da igual), sino
 * "¿se está usando?". Por eso el número grande es el de consultas que llegan
 * SOLAS desde los hooks: si eso es cero, el grafo depende de que alguien se
 * acuerde, y ahí es donde murió el MCP de Obsidian con 17 usos en 1.527 sesiones.
 */
const hace = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '?';
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' d';
};

/*
  Las 6 instancias Supabase y las alertas vivas del centro de mando.

  Dos decisiones de diseño que no son estéticas:

  1. El porcentaje es contra el techo de SU plan, y por eso el plan se muestra al lado.
     Free son 500 MB y Pro 8 GB por proyecto: con un techo único, otra instancia (Pro)
     salía al 84% en rojo estando al 5%, y esa alarma falsa tapaba la única de verdad,
     la del un proyecto en Free. Un panel que grita por lo que no importa deja de mirarse.
     La barra se pinta siempre, incluso al 4%, porque lo que importa no es el número de
     hoy sino a qué velocidad sube, y eso solo se ve comparando.
  2. Las alertas van agrupadas por tipo y no una a una. 153 eventos en 48 h en lista
     plana son una pared que nadie lee; 20 tipos ordenados por gravedad se leen en
     cinco segundos, que es el tiempo real que tiene un panel.
*/
function pintarProduccion(d) {
  const p = d.produccion;
  if (!p || !p.instancias || !p.instancias.length) { $('prodPanel').hidden = true; return; }
  $('prodPanel').hidden = false;

  const color = (pct) => (pct >= 80 ? 'var(--err)' : pct >= 60 ? 'var(--warn)' : 'var(--ok)');
  const sev = { critical: 'var(--err)', error: 'var(--err)', warning: 'var(--warn)', info: 'var(--txt-3)' };

  const barras = p.instancias.map((i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:4px 0">
      <span style="width:132px;font-size:12px;color:var(--txt-2)">${i.nombre}</span>
      <span class="tnum" style="width:62px;font-size:12px;text-align:right">${i.mb} MB</span>
      <span style="flex:1;min-width:90px;height:7px;background:var(--surf-2);border-radius:4px;overflow:hidden">
        <span style="display:block;height:100%;width:${Math.min(i.pct, 100)}%;background:${color(i.pct)}"></span>
      </span>
      <span class="tnum" style="width:34px;font-size:11px;color:${color(i.pct)}">${i.pct}%</span>
      <span class="note" style="width:62px;font-size:10px;text-transform:uppercase">${i.plan || ''}</span>
      <span class="note" style="width:118px;font-size:11px">${i.crons} crons${
        i.crons_parados ? ` · <b style="color:var(--err)">${i.crons_parados} parados</b>` : ''}</span>
    </div>`).join('');

  const alertas = (p.alertas_48h || []).slice(0, 12).map((a) => `
    <div style="display:flex;gap:10px;font-size:12px;padding:3px 0;border-bottom:1px solid var(--line-soft)">
      <span class="tnum" style="width:34px;text-align:right;color:${sev[a.severidad] || 'var(--txt-3)'}">${a.n}</span>
      <span style="width:64px;font-size:10px;text-transform:uppercase;color:${sev[a.severidad] || 'var(--txt-3)'}">${a.severidad}</span>
      <span style="flex:1;color:var(--txt-2)">${a.tipo}</span>
      <span class="note tnum" style="font-size:11px">${a.ultima || ''}</span>
    </div>`).join('');

  const resto = (p.alertas_48h || []).length - 12;
  $('prodnote').textContent =
    `${p.instancias.length} instancias · ${p.alertas_eventos} eventos de alerta en 48 h`;
  $('prod').innerHTML = `
    ${barras}
    <div class="note" style="margin:12px 0 6px;font-size:11px">
      ALERTAS 48 H — las emite el centro de mando, que es el centro de mando. Aquí solo se miran.
    </div>
    ${alertas}
    ${resto > 0 ? `<div class="note" style="font-size:11px;padding-top:6px">… y ${resto} tipo${resto > 1 ? 's' : ''} más</div>` : ''}`;
}

async function pintarGrafo() {
  let d = null;
  try {
    const r = await fetch('/api/grafo');
    if (r.ok) d = await r.json();
  } catch { /* sin grafo: la sección no existe y ya está */ }
  if (!d || d.ausente) {
    $('grafoPanel').hidden = true; $('vistasPanel').hidden = true;
    $('prodPanel').hidden = true; return;
  }
  pintarVistas(d);
  pintarProduccion(d);

  const u = d.uso, s = d.salud;
  // Semáforo honesto: lo que importa es el uso automático, no el total.
  const salud = u.desde_hooks === 0 ? '#E60076'
    : (u.ultimas_24h === 0 ? '#FFB547' : '#00E68C');
  const veredicto = u.desde_hooks === 0
    ? 'NADIE lo consulta solo: depende de que alguien se acuerde'
    : (u.ultimas_24h === 0 ? 'sin uso en 24 h' : 'vivo');

  const kpi = (n, txt, col) => `<div style="min-width:104px">
      <div class="tnum" style="font-size:26px;line-height:1;color:${col || '#e8e6f0'}">${n}</div>
      <div class="note" style="font-size:11px">${txt}</div></div>`;

  const viejo = (s.snapshots_produccion || []).filter((x) => x.horas > 168).length;
  const idx = (s.indexaciones || [])[0];

  $('grafonote').textContent =
    `${s.nodos_total.toLocaleString('es')} nodos · ${s.aristas_total.toLocaleString('es')} aristas`
    + (idx ? ` · indexado hace ${hace(idx.empezado)}` : '');

  $('grafo').innerHTML = `
    <div style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start">
      ${kpi(u.desde_hooks, 'consultas desde hooks', salud)}
      ${kpi(u.ultimas_24h, 'en 24 h')}
      ${kpi(u.total, 'total')}
      ${kpi(d.drift.rpc_fantasma + d.drift.tabla_fantasma, 'drift repo↔prod', '#FFB547')}
      ${viejo ? kpi(viejo, 'snapshots >7 d', '#E60076') : ''}
    </div>
    <div class="note" style="margin:8px 0 12px;color:${salud}">${veredicto}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      ${u.por_verbo.map((v) => `<span class="note" style="border:1px solid #3a3550;
        border-radius:999px;padding:2px 9px;font-size:11px">
        ${v.verbo} <b class="tnum">${v.n}</b>
        <span style="opacity:.6">${v.origen}</span></span>`).join('')}
    </div>
    <div class="list">${(u.ultimas || []).slice(0, 12).map((q) => `
      <div style="display:flex;gap:10px;font-size:12px;padding:3px 0;border-bottom:1px solid #26223a">
        <span class="tnum note" style="width:52px">${hace(q.ts)}</span>
        <b style="width:74px">${q.verbo}</b>
        <span style="opacity:.65;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${(q.argumento || '').replace(/[<>]/g, '')}</span>
        <span class="note tnum" style="width:46px;text-align:right">${q.filas} f</span>
        <span class="note" style="width:74px;text-align:right;opacity:.55">${q.origen}</span>
      </div>`).join('')}</div>`;
  $('grafoPanel').hidden = false;
}

/* Vistas del mapa del código. Los SVG llegan ya dibujados desde el grafo, así que aquí
 * solo se inyectan: si el dibujo cambia allí, cambia aquí sin tocar nada. */
let vistaActiva = 'treemap';
const LEDE = {
  treemap: ['Cada rectángulo es un <b>módulo</b> y su área es su número de ficheros. '
    + 'Es la única vista que mete el ecosistema entero en una pantalla sin mentir sobre '
    + 'el tamaño. Pasa el ratón para ver la ruta y el conteo.',
    '<i style="color:var(--accent-soft)">pantalla</i>'
    + '<i style="color:var(--accent)">servicio</i><i style="color:var(--ok)">Edge Functions</i>'],
  matriz: ['Fila = quién importa, columna = a quién. Una <b>columna poblada</b> es una '
    + 'pieza de la que depende medio sistema; una <b>fila poblada</b>, un módulo frágil. '
    + 'Los bloques pegados a la diagonal son proyectos aislados entre sí, que es lo que '
    + 'permite trabajar en paralelo sin pisarse.',
    '<i style="color:var(--accent)">dependencia</i>'
    + '<i style="color:var(--err)">ciclo (se importan mutuamente)</i>'],
};

function pintarVistas(d){
  const v = d && d.vistas;
  if (!v || !v.treemap) { $('vistasPanel').hidden = true; return; }
  const s = v.stats || {};
  $('vistasnote').textContent =
    `${s.modulos} módulos · ${s.ficheros} ficheros · ${s.pares} dependencias · ${s.ciclos} ciclos`;
  const [lede, ley] = LEDE[vistaActiva];
  const svg = vistaActiva === 'treemap'
    ? `<svg viewBox="0 0 1180 560">${v.treemap}</svg>`
    : `<svg viewBox="0 0 ${v.lado_matriz} ${v.lado_matriz}">${v.matriz}</svg>`;
  $('vistas').innerHTML = `<p class="v-lede">${lede}</p><div class="v-ley">${ley}</div>${svg}`;
  for (const b of document.querySelectorAll('.vtab'))
    b.classList.toggle('on', b.dataset.v === vistaActiva);
  $('vistasPanel').hidden = false;
}

document.getElementById('vtabs').addEventListener('click', async (e) => {
  const b = e.target.closest('.vtab');
  if (!b) return;
  vistaActiva = b.dataset.v;
  try { const r = await fetch('/api/grafo'); if (r.ok) pintarVistas(await r.json()); } catch {}
});

pintarGrafo();
setInterval(pintarGrafo, 20000);

connect();
