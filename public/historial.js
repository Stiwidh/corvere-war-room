/* Corvere War Room, historial de sesiones (cliente).
 *
 * Todas las sesiones que siguen en disco, con el comando para volver a entrar y el nombre
 * que les pongas. Arriba, si el equipo se apagó con sesiones abiertas, esas primero.
 *
 * IMPACT-OK: fichero nuevo. Lo carga `index.html` con <script src> ANTES de `app.js`, que
 * reutiliza dos piezas suyas (`copiar` y `editor`) en el detalle de una sesión. Lee
 * `/api/historial` y escribe por `POST /api/nombre`, las dos nuevas en `server.mjs`. Sin
 * producción implicada: panel local.
 */
const Historial = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PASO = 60;                 // filas por tanda: ciento y pico de golpe es una pared
  const COLOR = { working: 'var(--ok)', agents: 'var(--accent-soft)', waiting: 'var(--warn)', closed: 'var(--idle)' };
  // la pastilla de estado y el tinte de la fila al pasar por encima (capa de relieve)
  const ESTADO = { working: ['trabajando', 'ok'], agents: ['agentes al lío', 'acc'], waiting: ['abierta', 'warn'] };
  const TINTE = { working: 'var(--ok)', agents: 'var(--accent-soft)', waiting: 'var(--warn)', closed: 'var(--accent-soft)' };
  const COPIAR = '⧉ reanudar';

  let datos = null;
  let abierto = false;
  let filtro = '';
  let tope = PASO;
  let desplegada = null;           // id de la fila con el detalle abierto
  let temporizador = null;
  /* Búsqueda DENTRO de las conversaciones: { q, cargando, r }. Escribir en el campo filtra
     al momento por nombre, título y carpeta; Enter o el botón busca además en lo que
     dijisteis, que lee todos los transcripts y tarda unos segundos. */
  let busqueda = null;

  const ahoraSeg = () => Date.now() / 1000;
  function rato(seg) {
    if (seg < 90) return 'ahora';
    if (seg < 3600) return `hace ${Math.round(seg / 60)} min`;
    if (seg < 86400) return `hace ${Math.round(seg / 3600)} h`;
    return `hace ${Math.round(seg / 86400)} d`;
  }
  const hora = (t) => new Date(t * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const fecha = (t) => (t ? new Date(t * 1000).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
  function dia(t) {
    const d = new Date(t * 1000);
    const cero = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dif = Math.round((cero(new Date()) - cero(d)) / 86400000);
    if (dif === 0) return 'hoy';
    if (dif === 1) return 'ayer';
    return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // tu nombre manda; luego el de /rename, el que genera Claude y, si no hay, cómo empezó
  const titulo = (s) => s.nombre || s.tituloNativo || s.titulo || s.primerMensaje || s.id.slice(0, 8);

  /** Al portapapeles. 127.0.0.1 es contexto seguro y la API moderna vale; el respaldo es
      para un navegador que la tenga bloqueada. */
  async function copiar(texto) {
    if (!texto) return false;
    try { await navigator.clipboard.writeText(texto); return true; } catch { /* al respaldo */ }
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  async function guardarNombre(id, nombre) {
    try {
      const r = await fetch('/api/nombre', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, nombre }),
      });
      return await r.json();
    } catch {
      return { ok: false, error: 'sin conexión con el panel' };
    }
  }

  /** Cambia `el` por un campo de texto. Enter o salir del campo guarda, Esc lo deja como
      estaba. `alTerminar` recibe la respuesta del servidor, o null si no hubo cambio. */
  function editor(el, id, actual, alTerminar) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'alias-input';
    input.value = actual || '';
    input.maxLength = 80;
    input.placeholder = 'nombre para esta sesión (vacío lo quita)';
    input.setAttribute('aria-label', 'nombre de la sesión');
    el.replaceChildren(input);
    input.focus();
    input.select();
    let hecho = false;
    const terminar = async (guardar) => {
      if (hecho) return;
      hecho = true;
      // sin soltar el foco, el repintado seguiría creyendo que estás escribiendo y no
      // quitaría el campo (el blur que dispara vuelve aquí y lo para `hecho`)
      input.blur();
      if (!guardar || input.value.trim() === (actual || '').trim()) { alTerminar(null); return; }
      alTerminar(await guardarNombre(id, input.value));
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); terminar(true); }
      // sin el stopPropagation, este mismo Esc cerraría además el detalle de la sesión
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); terminar(false); }
    });
    input.addEventListener('blur', () => terminar(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  function aviso(texto) {
    const n = $('histnote');
    n.textContent = texto;
    n.style.color = 'var(--err)';
    setTimeout(() => { n.style.color = ''; pintar(); }, 4000);
  }

  /* ── pintado ── */

  function detalle(s) {
    return `<div class="hist-mas">
      ${s.comando
        ? `<code class="hist-cmd">${esc(s.comando)}</code>`
        : '<div class="hist-aviso">Claude ya borró este transcript: la sesión no se puede reanudar.</div>'}
      <div class="hist-datos">
        <span>id ${esc(s.id)}</span>
        <span>empezó ${esc(fecha(s.inicio))}</span>
        <span>último cambio ${esc(fecha(s.ultima))}</span>
        <span>${(s.bytes / 1048576).toFixed(1).replace('.', ',')} MB</span>
        ${s.tituloNativo && s.tituloNativo !== s.nombre ? `<span>nombre en Claude: ${esc(s.tituloNativo)}</span>` : ''}
        ${s.titulo ? `<span>título que le puso Claude: ${esc(s.titulo)}</span>` : ''}
      </div>
      ${s.primerMensaje ? `<div class="hist-primero"><span class="l">empezó con</span>${esc(s.primerMensaje)}</div>` : ''}
      ${Retomar.html(s.id, pintar)}
    </div>`;
  }

  /* Los fragmentos de una búsqueda por contenido, con lo encontrado resaltado. */
  function hallazgos(s) {
    return `<div class="hall-lista">${s.hallazgos.map((h) => `<div class="hall">
      <span class="quien ${h.quien === 'tú' ? 'tu' : ''}">${esc(h.quien)}</span>
      <span class="cuando tnum">${h.t ? esc(fecha(h.t)) : ''}</span>
      <span class="txt">${esc(h.antes)}<mark>${esc(h.hallado)}</mark>${esc(h.despues)}</span></div>`).join('')}</div>`;
  }

  function fila(s, ahora, extra = '') {
    const t = titulo(s);
    // debajo, lo que ayude a reconocerla y no esté ya en el título
    const sub = [s.titulo, s.primerMensaje].find((x) => x && x !== t) || '';
    const quedan = datos.limpiezaDias * 86400 - (ahora - s.ultima);
    const caduca = !s.borrado && quedan < 7 * 86400
      ? `<span class="hist-tag warn" title="Claude borra los transcripts a los ${datos.limpiezaDias} días">`
        + `se borra en ${Math.max(0, Math.ceil(quedan / 86400))} d</span>` : '';
    const estado = ESTADO[s.estado]
      ? `<span class="hist-tag ${ESTADO[s.estado][1]}">${ESTADO[s.estado][0]}</span>` : '';
    const abierta = desplegada === s.id;
    // "HEAD" es lo que apunta Claude fuera de una rama con nombre: no ayuda a reconocer nada
    const rama = s.rama && s.rama !== 'HEAD' ? s.rama : '';
    const late = s.estado === 'working' || s.estado === 'agents' ? ' late' : '';
    return `<div class="hist-fila${s.borrado ? ' borrada' : ''}${abierta ? ' abierta' : ''}" data-id="${esc(s.id)}"
      style="--t:${TINTE[s.estado] || TINTE.closed}">
      <span class="punto${late}" style="--p:${COLOR[s.estado] || COLOR.closed}"></span>
      <span class="hist-tit${s.nombre ? ' propio' : ''}" data-nombre>${esc(t)}</span>
      <span class="hist-meta">
        ${estado}${caduca}
        <span class="proy">${esc(s.proyecto)}${rama ? ` · ${esc(rama)}` : ''}</span>
        <span class="tnum" title="${esc(fecha(s.ultima))}">${rato(ahora - s.ultima)}</span>
        <button type="button" class="mini" data-accion="renombrar" title="ponerle nombre">✎</button>
        ${s.borrado
          ? '<span class="hist-tag idle">transcript borrado</span>'
          : `<button type="button" class="mini" data-accion="copiar" title="${esc(s.comando)}">${COPIAR}</button>`}
      </span>
      ${sub ? `<span class="hist-sub">${esc(sub)}</span>` : ''}
      ${extra}
      ${abierta ? detalle(s) : ''}
    </div>`;
  }

  /* Lo que tenías delante al apagar va primero y aparte: es exactamente lo que se busca al
     encender el equipo. Desaparece solo cuando ya las has reabierto todas. */
  function bloqueApagado(ahora) {
    const a = datos.apagado;
    const pendientes = a.sesiones.filter((s) => s.estado === 'closed');
    if (!pendientes.length) return '';
    const n = a.sesiones.length;
    return `<div class="hist-apagado">
      <div class="hist-apagado-cab">Al apagar el equipo (${esc(dia(a.t))}, ${hora(a.t)}) tenías
        ${n} ${n === 1 ? 'sesión abierta' : 'sesiones abiertas'}
        <span class="note">${pendientes.length === n ? 'ninguna reabierta' : `${pendientes.length} sin reabrir`}</span></div>
      ${a.sesiones.map((s) => fila(s, ahora)).join('')}
    </div>`;
  }

  function pintar() {
    if (!abierto || !datos) return;
    // no se repinta mientras escribes un nombre: se perdería lo tecleado
    const activo = document.activeElement;
    if (activo?.classList?.contains('alias-input') && $('hist').contains(activo)) return;
    const ahora = ahoraSeg();
    if (busqueda) { pintarBusqueda(ahora); return; }
    const q = sinTildes(filtro.trim());
    const pasa = (s) => !q || sinTildes([s.nombre, s.tituloNativo, s.titulo, s.primerMensaje,
      s.proyecto, s.rama, s.id].join(' ')).includes(q);
    const lista = datos.sesiones.filter(pasa);
    // la fila desplegada tiene que verse aunque quede más allá de la tanda (viene del consumo)
    if (desplegada) { const i = lista.findIndex((s) => s.id === desplegada); if (i >= tope) tope = i + 1; }

    let html = !q && datos.apagado?.sesiones?.length ? bloqueApagado(ahora) : '';
    let previo = '';
    for (const s of lista.slice(0, tope)) {
      const d = dia(s.ultima);
      if (d !== previo) { html += `<div class="hist-dia">${esc(d)}</div>`; previo = d; }
      html += fila(s, ahora);
    }
    if (lista.length > tope) {
      html += `<button type="button" class="hist-mas-btn" data-accion="mas">ver ${Math.min(PASO, lista.length - tope)} más · quedan ${lista.length - tope}</button>`;
    }
    if (!lista.length) {
      html = `<div class="empty">${q ? 'Nada coincide con esa búsqueda.'
        : datos.demo ? 'En modo demostración no se enseña el historial.' : 'No hay sesiones en disco.'}</div>`;
    }
    $('hist').innerHTML = html;
    $('histnote').textContent = `${datos.total} sesiones en disco`
      + (q ? ` · ${lista.length} coinciden` : '')
      + ` · Claude las guarda ${datos.limpiezaDias} días`
      + (datos.ocultas ? ` · ${datos.ocultas} automáticas o vacías fuera` : '');
  }

  function pintarBusqueda(ahora) {
    const b = busqueda;
    // la nota de arriba habla del filtro rápido, que aquí no manda
    $('histnote').textContent = `${datos.total} sesiones en disco · Claude las guarda ${datos.limpiezaDias} días`;
    const volver = '<button type="button" class="mini" data-accion="salir-busqueda">✕ volver a la lista</button>';
    if (b.cargando) {
      $('hist').innerHTML = `<div class="hist-busca-cab">Buscando «${esc(b.q)}» dentro de las conversaciones… ${volver}</div>`;
      return;
    }
    const r = b.r || {};
    if (r.error) {
      $('hist').innerHTML = `<div class="hist-busca-cab">${esc(r.error)} ${volver}</div>`;
      return;
    }
    const n = r.sesiones?.length || 0;
    const cab = `<div class="hist-busca-cab">«${esc(r.q)}» en las conversaciones: ${n} ${n === 1 ? 'sesión' : 'sesiones'}
      <span class="note">${r.miradas} de ${r.total} leídas en ${(r.ms / 1000).toFixed(1).replace('.', ',')} s${r.cortada ? ' · cortada: afina la búsqueda' : ''}</span>
      ${volver}</div>`;
    $('hist').innerHTML = cab + (n
      ? r.sesiones.map((s) => fila({ ...(datos.sesiones.find((x) => x.id === s.id) || s) }, ahora, hallazgos(s))).join('')
      : '<div class="empty">Nada: ni tú ni Claude lo escribisteis así en ninguna sesión que siga en disco.</div>');
  }

  async function buscarDentro() {
    const q = $('hist-q').value.trim();
    if (!q) return;
    busqueda = { q, cargando: true };
    pintar();
    let r;
    try { r = await (await fetch(`/api/buscar?q=${encodeURIComponent(q)}`)).json(); }
    catch { r = { error: 'sin conexión con el panel' }; }
    if (busqueda?.q !== q) return;   // mientras tanto se cambió o se cerró la búsqueda
    busqueda = { q, r };
    pintar();
  }

  async function cargar() {
    try {
      const r = await fetch('/api/historial');
      if (!r.ok) return;
      datos = await r.json();
    } catch { return; }
    pintar();
  }

  function alternar(v = !abierto) {
    abierto = v;
    $('histPanel').hidden = !abierto;
    $('b-historial').setAttribute('aria-pressed', String(abierto));
    clearInterval(temporizador);
    temporizador = null;
    if (!abierto) {
      // cerrado a mano: lo del último apagado ya está visto y no vuelve a abrirse solo
      try { if (datos?.apagado) localStorage.setItem('warroom.apagadoVisto', String(datos.apagado.t)); } catch { /* sin almacenamiento */ }
      return;
    }
    tope = PASO;
    pintar();
    cargar();
    temporizador = setInterval(cargar, 30000);
  }

  /* ── eventos ── */

  $('b-historial').addEventListener('click', () => alternar());
  $('hist-q').addEventListener('input', (e) => { filtro = e.target.value; tope = PASO; busqueda = null; pintar(); });
  $('hist-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarDentro(); } });
  $('hist-dentro').addEventListener('click', buscarDentro);

  $('hist').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-accion]');
    if (b?.dataset.accion === 'mas') { tope += PASO; pintar(); return; }
    if (b?.dataset.accion === 'salir-busqueda') { busqueda = null; pintar(); return; }
    const f = e.target.closest('.hist-fila');
    const s = f && datos?.sesiones.find((x) => x.id === f.dataset.id);
    if (!s) return;
    if (b?.dataset.accion === 'copiar') {
      const ok = await copiar(s.comando);
      b.textContent = ok ? 'copiado ✓' : 'no se pudo copiar';
      b.classList.toggle('ok', ok);
      setTimeout(() => { b.textContent = COPIAR; b.classList.remove('ok'); }, 1600);
      return;
    }
    if (b?.dataset.accion === 'renombrar') {
      editor(f.querySelector('[data-nombre]'), s.id, s.nombre, async (r) => {
        if (r && !r.ok) { aviso(`no se guardó el nombre: ${r.error}`); return; }
        if (r?.ok) await cargar(); else pintar();
      });
      return;
    }
    // dentro del detalle se puede seleccionar, desplegar el borrador o copiar sin que la fila se pliegue
    if (e.target.closest('code, input, button, .hist-mas, .hall-lista')) return;
    desplegada = desplegada === s.id ? null : s.id;
    pintar();
  });

  /* Al encender el equipo, el War Room se abre solo al iniciar sesión. Si al apagar quedaron
     sesiones abiertas, el historial se abre también: es lo primero que se va a buscar. Una
     vez cerrado a mano, ese apagado ya no lo vuelve a abrir. */
  (async () => {
    await cargar();
    const a = datos?.apagado;
    if (!a || !a.sesiones.some((s) => s.estado === 'closed')) return;
    let visto = '';
    try { visto = localStorage.getItem('warroom.apagadoVisto') || ''; } catch { /* sin almacenamiento */ }
    if (visto !== String(a.t) && !abierto) alternar(true);
  })();

  /** Abre el historial con una sesión desplegada (lo usa el panel de consumo). */
  function enfocar(id) {
    busqueda = null;
    filtro = '';
    $('hist-q').value = '';
    desplegada = id;
    if (!abierto) alternar(true); else pintar();
    setTimeout(() => document.querySelector(`.hist-fila[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 400);
  }

  return { copiar, editor, alternar, enfocar };
})();
