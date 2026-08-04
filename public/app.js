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
connect();
