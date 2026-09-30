/* Corvere War Room, "retomar" una sesión (cliente).
 *
 * Lo que sale al desplegar una fila del historial para volver a ella sin releerla: lo
 * último que le pediste, lo último que te contestó, sus tareas sin cerrar, cómo está su
 * repo ahora, lo que lleva consumido y el borrador que dejó al cerrarse.
 *
 * IMPACT-OK: fichero nuevo. Lo carga `index.html` con <script src> antes de
 * `historial.js`, su único consumidor (`Retomar.html`). Lee `/api/sesion`, ruta nueva de
 * `server.mjs`. Sin producción implicada: panel local.
 */
const Retomar = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const VIGENCIA_MS = 30000;
  const cache = new Map();        // id -> { t, d }
  const pidiendo = new Set();
  const borradoresAbiertos = new Set();

  const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M`
    : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n || 0));
  function hace(seg) {
    if (seg < 3600) return `hace ${Math.max(1, Math.round(seg / 60))} min`;
    if (seg < 86400) return `hace ${Math.round(seg / 3600)} h`;
    return `hace ${Math.round(seg / 86400)} d`;
  }

  /** Lo que haya en caché ya; si está viejo o no está, lo pide y avisa al llegar. */
  function pedir(id, alLlegar) {
    const c = cache.get(id);
    if (c && Date.now() - c.t < VIGENCIA_MS) return c.d;
    if (!pidiendo.has(id)) {
      pidiendo.add(id);
      fetch(`/api/sesion?id=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((d) => {
          pidiendo.delete(id);
          cache.set(id, { t: Date.now(), d });
          alLlegar();
        });
    }
    return c ? c.d : undefined;   // lo de antes mientras llega lo nuevo
  }

  const bloque = (etiqueta, cuerpo, clase = '') => `<div class="ret ${clase}"><span class="l">${etiqueta}</span>${cuerpo}</div>`;

  /** El HTML de la parte de "retomar" de una fila. `alLlegar` repinta cuando hay datos. */
  function html(id, alLlegar) {
    const d = pedir(id, alLlegar);
    if (d === undefined) return '<div class="hist-aviso cargando">leyendo dónde se quedó…</div>';
    if (!d) return '<div class="hist-aviso">No se pudo leer el detalle de esta sesión.</div>';
    const partes = [];
    if (d.ultimoPedido) partes.push(bloque('lo último que le pediste', `<p>${esc(d.ultimoPedido)}</p>`));
    if (d.ultimaRespuesta) partes.push(bloque('lo último que contestó Claude', `<p class="largo">${esc(d.ultimaRespuesta)}</p>`));

    const pend = d.tareas || [];
    if (pend.length) {
      partes.push(bloque(`tareas sin cerrar · ${pend.length} de ${d.tareasTotal}`,
        `<ul>${pend.slice(0, 8).map((t) => `<li>${esc(t.subject)}${t.owner ? ` <span class="note">${esc(t.owner)}</span>` : ''}</li>`).join('')}</ul>`));
    }

    // el estado del repo es el de AHORA, no el del momento en que se cerró la sesión
    const g = d.git;
    if (g) {
      const avisos = [];
      if (g.sucios) avisos.push(`<b class="aviso">${g.sucios} ficheros sin commitear</b>`);
      if (g.sinSubir) avisos.push(`<b class="aviso">${g.sinSubir} commits sin subir</b>`);
      if (!avisos.length) avisos.push('todo commiteado y subido');
      if (g.ultimoCommit) avisos.push(`último commit ${hace(Date.now() / 1000 - g.ultimoCommit)}`);
      partes.push(bloque('su repo, ahora', `<p>${avisos.join(' · ')}</p>`));
    }

    const v = d.tokens;
    if (v) {
      partes.push(bloque('consumo de la sesión',
        `<p class="mono">${M(v[0] + v[1] + v[3])} nuevos · ${M(v[3])} de salida · ${M(v[2])} releídos de caché</p>`));
    }

    if (d.borrador) {
      partes.push(`<details class="ret-borr" data-borr="${esc(id)}"${borradoresAbiertos.has(id) ? ' open' : ''}>
        <summary>borrador del cierre <span class="note">${esc(d.borrador.ruta)}</span></summary>
        <pre>${esc(d.borrador.texto)}</pre></details>`);
    }
    return partes.length ? `<div class="ret-grid">${partes.join('')}</div>`
      : '<div class="hist-aviso">No hay nada más que contar de esta sesión.</div>';
  }

  // el desplegable del borrador sobrevive al repintado; `toggle` no burbujea, de ahí la captura
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.borr) return;
    if (d.open) borradoresAbiertos.add(d.dataset.borr); else borradoresAbiertos.delete(d.dataset.borr);
  }, true);

  return { html };
})();
