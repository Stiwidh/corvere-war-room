/* Corvere War Room, consumo de tokens (cliente).
 *
 * Por día, por sesión, por carpeta y por modelo. Lo "nuevo" (entrada + caché escrita +
 * salida) va en las barras; lo releído de caché va aparte y en número, porque es del orden
 * de treinta veces mayor (medido el 2026-09-30) y en el mismo eje aplastaría lo demás.
 *
 * IMPACT-OK: fichero nuevo. Lo carga `index.html` después de `historial.js`, del que usa
 * `Historial.enfocar` para abrir una sesión desde su fila. Lee `/api/consumo`, ruta nueva
 * de `server.mjs`. Sin producción implicada: panel local.
 */
const Consumo = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const M = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2).replace('.', ',')} mil M`
    : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M`
    : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n || 0));
  const nuevos = (v) => v[0] + v[1] + v[3];

  let abierto = false;
  let dias = 7;
  let datos = null;
  let temporizador = null;

  const diaCorto = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es', { weekday: 'short', day: 'numeric' });
  const diaLargo = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });

  function tiles(t) {
    const tile = (clase, lab, val, sub) => `<div class="kpi ${clase}"><span class="lab">${lab}</span>
      <span class="val tnum">${val}</span><span class="sub">${sub}</span></div>`;
    const veces = nuevos(t) ? Math.round(t[2] / nuevos(t)) : 0;
    return `<div class="cons-kpis">
      ${tile('acc', 'Nuevos', M(nuevos(t)), 'entrada + caché escrita + salida')}
      ${tile('ok', 'Salida', M(t[3]), 'lo que escribe Claude')}
      ${tile('hot', 'Caché escrita', M(t[1]), 'contexto nuevo que se guarda')}
      ${tile('cero', 'Releídos de caché', M(t[2]), veces ? `${veces} veces lo nuevo: el contexto que se reenvía en cada turno` : 'el contexto que se reenvía en cada turno')}
    </div>`;
  }

  /* Una sola serie, así que sin leyenda: el título la nombra. Barras finas con los datos
     anclados abajo y el valor en el tooltip; solo se rotula el máximo. */
  function barras(porDia) {
    const max = Math.max(...porDia.map((d) => nuevos(d.v)), 1);
    const cada = porDia.length > 31 ? 7 : porDia.length > 10 ? 3 : 1;
    const cols = porDia.map((d, i) => {
      const h = nuevos(d.v) ? Math.max(1.5, (nuevos(d.v) / max) * 100) : 0;
      return `<div class="cons-col" data-i="${i}"><div class="cons-bar" style="height:${h}%"></div></div>`;
    }).join('');
    const ejes = porDia.map((d, i) => `<span>${i % cada === 0 || i === porDia.length - 1 ? esc(diaCorto(d.fecha)) : ''}</span>`).join('');
    return `<div class="cons-graf">
      <div class="cons-tit">Tokens nuevos por día <span class="note">máximo ${M(max)}</span></div>
      <div class="cons-barras" id="cons-barras">${cols}</div>
      <div class="cons-ejes">${ejes}</div></div>`;
  }

  function sesiones(lista) {
    if (!lista.length) return '<div class="empty">Sin consumo en este rango.</div>';
    const max = Math.max(...lista.map((s) => nuevos(s.v)), 1);
    return `<div class="cons-tabla">
      <div class="cons-fila cab"><span>sesión</span><span>carpeta</span><span>nuevos</span><span>salida</span><span>releídos</span></div>
      ${lista.map((s) => `<div class="cons-fila" data-ses="${esc(s.id)}" title="abrir en el historial">
        <span class="nom">${esc(s.nombre || s.titulo || s.id.slice(0, 8))}${s.automatica ? ' <span class="note">automática</span>' : ''}</span>
        <span class="note">${esc(s.proyecto)}</span>
        <span class="cons-celda"><span class="barrita" style="width:${(nuevos(s.v) / max) * 100}%"></span><span class="tnum">${M(nuevos(s.v))}</span></span>
        <span class="tnum">${M(s.v[3])}</span>
        <span class="tnum note">${M(s.v[2])}</span></div>`).join('')}
    </div>`;
  }

  function carpetasYModelos(d) {
    const max = Math.max(...d.carpetas.map((c) => nuevos(c.v)), 1);
    const carpetas = d.carpetas.slice(0, 10).map((c) => `<div class="cons-h">
      <span class="nom">${esc(c.proyecto)}</span>
      <span class="cons-celda"><span class="barrita" style="width:${(nuevos(c.v) / max) * 100}%"></span><span class="tnum">${M(nuevos(c.v))}</span></span></div>`).join('');
    const modelos = d.modelos.map((m) => `<div class="cons-h"><span class="nom mono">${esc(m.modelo)}</span>
      <span class="tnum note">${M(nuevos(m.v))} nuevos · ${M(m.v[3])} de salida</span></div>`).join('');
    return `<div class="cons-cols">
      <div><div class="cons-tit">Por carpeta <span class="note">donde se abrió la sesión</span></div>${carpetas || '<div class="empty">-</div>'}</div>
      <div><div class="cons-tit">Por modelo</div>${modelos || '<div class="empty">-</div>'}</div></div>`;
  }

  function pintar() {
    if (!abierto || !datos) return;
    for (const b of document.querySelectorAll('#cons-rango .vtab')) b.classList.toggle('on', Number(b.dataset.d) === dias);
    if (datos.demo) { $('consumo').innerHTML = '<div class="empty">En modo demostración no se enseña el consumo.</div>'; return; }
    $('consnote').textContent = datos.calculando
      ? 'leyendo todos los transcripts por primera vez, tarda unos segundos…'
      : `${diaLargo(datos.desde)} a ${diaLargo(datos.hasta)}`;
    $('consumo').innerHTML = tiles(datos.totales) + barras(datos.porDia)
      + `<div class="cons-tit">Las sesiones que más han gastado</div>${sesiones(datos.sesiones)}`
      + carpetasYModelos(datos);
  }

  async function cargar() {
    try {
      const r = await fetch(`/api/consumo?dias=${dias}`);
      if (r.ok) datos = await r.json();
    } catch { return; }
    pintar();
    // la primera vez se calcula en segundo plano: se vuelve a preguntar hasta que acabe
    clearTimeout(temporizador);
    if (abierto) temporizador = setTimeout(cargar, datos?.calculando ? 3000 : 60000);
  }

  function alternar(v = !abierto) {
    abierto = v;
    $('consumoPanel').hidden = !abierto;
    $('b-consumo').setAttribute('aria-pressed', String(abierto));
    clearTimeout(temporizador);
    if (abierto) { pintar(); cargar(); }
  }

  /* ── eventos ── */

  $('b-consumo').addEventListener('click', () => alternar());
  $('cons-rango').addEventListener('click', (e) => {
    const b = e.target.closest('.vtab');
    if (!b) return;
    dias = Number(b.dataset.d);
    datos = null;
    $('consumo').innerHTML = '<div class="empty">cargando…</div>';
    cargar();
  });
  $('consumo').addEventListener('click', (e) => {
    const f = e.target.closest('[data-ses]');
    if (f) Historial.enfocar(f.dataset.ses);
  });

  // el tooltip de las barras: el desglose del día, que la barra sola no cuenta
  const tip = $('consTip');
  $('consumo').addEventListener('mousemove', (e) => {
    const col = e.target.closest('.cons-col');
    if (!col || !datos) { tip.style.opacity = 0; return; }
    const d = datos.porDia[Number(col.dataset.i)];
    if (!d) return;
    tip.innerHTML = `<b>${esc(diaLargo(d.fecha))}</b><br>
      <span class="l">nuevos</span> ${M(nuevos(d.v))}<br>
      <span class="l">entrada</span> ${M(d.v[0])} · <span class="l">caché escrita</span> ${M(d.v[1])}<br>
      <span class="l">salida</span> ${M(d.v[3])} · <span class="l">releídos</span> ${M(d.v[2])}`;
    tip.style.opacity = 1;
    tip.style.left = `${Math.min(window.innerWidth - 280, e.clientX + 14)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  $('consumo').addEventListener('mouseleave', () => { tip.style.opacity = 0; });

  return { alternar };
})();
