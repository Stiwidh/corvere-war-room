/**
 * Mapa de pulpos: una sesión es una cabeza (su hilo principal) con tentáculos
 * (sus agentes). Nada está en posición fija — muelles, repulsión y flotación —,
 * y las sesiones del mismo repositorio comparten zona.
 *
 * No sabe nada de red: se le pasa el estado con sync() y él pinta.
 */
const Pulpos = (() => {
  const COL = { working:'#00E68C', agents:'#c084fc', waiting:'#FFB547', closed:'#5A5766' };
  const PAL = ['#9810FA','#E60076','#00E68C','#FFB547','#6fb1ff','#c084fc','#ff9ec9','#00c2b8','#f97362','#8b8ef7','#7ee787'];
  const FAM = {
    lente:        { forma:'hex',     color:'#c084fc', txt:'lente de council' },
    especialista: { forma:'rombo',   color:'#00c2b8', txt:'especialista (SEAT)' },
    explorador:   { forma:'tri',     color:'#6fb1ff', txt:'explorador / plan' },
    trabajo:      { forma:'circulo', color:null,      txt:'agente de trabajo' },
  };
  const WORKING = 45;
  const ESTADO = { working:'trabajando', agents:'agentes al lío', waiting:'te espera', closed:'cerrada' };
  const rato = (s) => {
    if (s == null || s < 0) return '';
    if (s < 60) return Math.round(s) + ' s';
    if (s < 3600) return Math.round(s/60) + ' min';
    if (s < 86400) return Math.floor(s/3600) + ' h';
    return Math.floor(s/86400) + ' d';
  };
  const miles = (n) => (n||0).toLocaleString('es');
  const tk = (n) => n >= 1e6 ? (n/1e6).toFixed(1).replace('.',',') + ' M'
                  : n >= 1000 ? Math.round(n/1000) + ' k' : String(n||0);

  let c, ctx, ficha, alClicarLider = () => {};
  let W = 0, H = 0, t = 0, ultimo = 0;
  let zonas = [], leads = new Map(), agentes = new Map();
  let pulsos = [], destellos = [], hover = null, arrastrando = null, foco = null;
  let replay = null;   // { datos, t, playing, vel, idx, alCambiar }
  let vistos = new Map();   // sesión -> timestamp del último mensaje ya animado

  /* ── identidad de los agentes ── */
  function familia(nombre){
    const s = String(nombre || '').toLowerCase();
    if (s.includes('seat')) return 'especialista';
    if (s.startsWith('council')) return 'lente';
    if (/^(explore|plan|research|audit)/.test(s)) return 'explorador';
    return 'trabajo';
  }
  /** Iniciales que distinguen: se tiran las palabras que comparte con sus hermanos. */
  function recalcIniciales(leadId){
    const suyos = [...agentes.values()].filter(a => a.leadId === leadId);
    const trocear = (n) => String(n).split(/[\s\-_:]+|(?=[A-Z][a-z])/).filter(Boolean).map(p => p.toLowerCase());
    const cuenta = {};
    for (const a of suyos) for (const p of new Set(trocear(a.etiqueta))) cuenta[p] = (cuenta[p]||0)+1;
    for (const a of suyos){
      const partes = trocear(a.etiqueta);
      const propias = partes.filter(p => (cuenta[p]||0) < 2);
      const base = (propias.length ? propias : partes).join('');
      a.ini = (base.replace(/[^a-záéíóúñ0-9]/g,'').slice(0,2) || '??').toUpperCase();
    }
  }

  /* ── zonas por repositorio ── */
  function repartirZonas(){
    // en foco, la sesión elegida se queda sola y ocupa todo el lienzo
    if (foco && leads.has(foco)){
      const L = leads.get(foco);
      zonas = [{ nombre: L.repo, cx: W/2, cy: H/2, rx: W/2-10, ry: H/2-10 }];
      L.zona = zonas[0];
      return;
    }
    const nombres = [...new Set([...leads.values()].map(l => l.repo))];
    if (!nombres.length){ zonas = []; return; }

    // Cada repo pesa lo que contiene: un repo con tres sesiones y quince
    // agentes necesita mucho más sitio que uno con una cabeza sola. Se reparte
    // en dos columnas y las filas y columnas se estiran según ese peso.
    const peso = (n) => {
      const ses = [...leads.values()].filter(l => l.repo === n).length;
      const ags = [...agentes.values()].filter(a => leads.get(a.leadId)?.repo === n).length;
      return 1 + (ses - 1) * 0.8 + ags * 0.22;
    };
    const orden = nombres.map(n => ({ n, p: peso(n) })).sort((a,b) => b.p - a.p);
    const cols = Math.min(2, orden.length);
    const filas = [];
    for (let i = 0; i < orden.length; i += cols) filas.push(orden.slice(i, i + cols));

    // reparto de alturas: mitad equitativo, mitad por peso, para que las zonas
    // pequeñas no se queden en una rendija
    const pf = filas.map(f => f.reduce((s,z) => s + z.p, 0));
    const tot = pf.reduce((a,b) => a+b, 0) || 1;
    const bruto = pf.map(p => 0.5 + 0.5 * (p/tot) * filas.length);
    const norm = bruto.reduce((a,b) => a+b, 0);
    const alturas = bruto.map(x => H * x / norm);

    zonas = [];
    let y = 0;
    filas.forEach((fila, fi) => {
      const alto = alturas[fi];
      const pTot = fila.reduce((s,z) => s + z.p, 0) || 1;
      let x = 0;
      for (const z of fila){
        // el ancho también se reparte por peso, con suelo del 34 %
        const frac = fila.length === 1 ? 1 : Math.max(0.34, Math.min(0.66, z.p / pTot));
        const ancho = W * (fila.length === 1 ? 1 : frac);
        zonas.push({ nombre: z.n, cx: x + ancho/2, cy: y + alto/2,
                     rx: ancho/2 - 10, ry: alto/2 - 8 });
        x += ancho;
      }
      y += alto;
    });
    for (const l of leads.values()) l.zona = zonas.find(z => z.nombre === l.repo);
  }

  /* ── replay: la sesión se reconstruye desde su transcript ── */
  function empezarReplay(datos, alCambiar){
    leads.clear(); agentes.clear(); pulsos = []; destellos = [];
    foco = '__replay__';
    const L = { id: datos.id, repo: datos.project, x: W/2, y: H/2, vx:0, vy:0, r:30,
                fase: 0, esLead: true, estado: 'working', vivo: true,
                accion: '', rama: '', acts: 0, toks: 0, up: 0, lat: 0, colgando: 0 };
    leads.set(datos.id, L);
    zonas = [{ nombre: datos.project + ' · replay', cx: W/2, cy: H/2, rx: W/2-10, ry: H/2-10 }];
    L.zona = zonas[0];
    replay = { datos, t: 0, playing: true, vel: Math.max(20, datos.duracion / 90), idx: 0, alCambiar };
    return replay;
  }
  function pararReplay(){ replay = null; foco = null; leads.clear(); agentes.clear(); repartirZonas(); }

  function pasoReplay(dt){
    if (!replay || !replay.playing) return;
    const { datos } = replay;
    replay.t += dt * replay.vel;
    if (replay.t >= datos.duracion){ replay.t = datos.duracion; replay.playing = false; }

    const L = leads.get(datos.id);
    // agentes que ya han nacido y aún no se han retirado
    for (const a of datos.agentes){
      const k = datos.id + '|' + a.n;
      const dentro = replay.t >= a.born;
      if (dentro && !agentes.has(k)){
        const etiqueta = a.titulo || a.n;
        const fam = familia(etiqueta + ' ' + (a.tipo || ''));
        const ang = Math.random()*Math.PI*2, d = 70 + Math.random()*40;
        agentes.set(k, { k, leadId: datos.id, etiqueta, fam, tipo: a.tipo || '',
          color: FAM[fam].color || PAL[agentes.size % PAL.length],
          x: L.x + Math.cos(ang)*d, y: L.y + Math.sin(ang)*d, vx:0, vy:0, r:14,
          fase: Math.random()*6.28, ini:'??', acts:0, toks:0, retirado:false, vivo:true, accion:'' });
        recalcIniciales(datos.id);
      }
      const A = agentes.get(k);
      if (A) A.retirado = replay.t > a.died + 90;
    }

    while (replay.idx < datos.eventos.length && datos.eventos[replay.idx].t <= replay.t){
      const e = datos.eventos[replay.idx++];
      const k = datos.id + '|' + e.a;
      const A = agentes.get(k);
      if (e.k === 'tool'){
        if (A){ A.acts++; A.accion = `${e.n} ${e.d || ''}`.trim(); A.ultimo = replay.t; }
        else if (e.a === 'team-lead'){ L.acts++; L.accion = `${e.n} ${e.d || ''}`.trim(); L.ultimo = replay.t; }
      } else if (e.k === 'msg'){
        const de = e.a === 'team-lead' ? L : agentes.get(datos.id + '|' + e.a);
        const ha = e.to === 'team-lead' ? L : agentes.get(datos.id + '|' + e.to);
        const lateral = de !== L && ha !== L;
        lateral ? L.lat++ : L.up++;
        if (de && ha && de !== ha) pulsos.push({ a: de, b: ha, t: 0, lateral });
      }
    }
    // late quien haya hecho algo en los últimos segundos de la reproducción
    const margen = replay.vel * 2.5;
    L.vivo = (replay.t - (L.ultimo || -1e9)) < margen;
    for (const A of agentes.values()) A.vivo = !A.retirado && (replay.t - (A.ultimo || -1e9)) < margen;
    replay.alCambiar?.(replay);
  }

  /* ── entrada de datos ── */
  function sync(sesiones, now){
    if (replay) return;   // en replay mandan los datos del transcript, no el vivo
    const vivasIds = new Set(sesiones.map(s => s.id));
    for (const id of [...leads.keys()]) if (!vivasIds.has(id)) leads.delete(id);
    for (const [k, a] of agentes) if (!vivasIds.has(a.leadId)) agentes.delete(k);

    let cambioZonas = false;
    const antes = agentes.size;
    for (const s of sesiones){
      let L = leads.get(s.id);
      if (!L){
        L = { id:s.id, repo:s.project, x:W/2, y:H/2, vx:0, vy:0, r: foco ? 30 : 21,
              fase: leads.size * 1.7, esLead:true };
        leads.set(s.id, L);
        cambioZonas = true;
      }
      if (L.repo !== s.project){ L.repo = s.project; cambioZonas = true; }
      L.estado = s.status;
      L.idle = s.idle; L.idleLider = s.idleLider;
      L.accion = s.lead?.last || '';
      L.vivo = (now - (s.lead?.lastAt || 0)) < WORKING;
      // lo que antes llevaba la tarjeta y hacía falta de un vistazo
      L.rama = s.branch || ''; L.equipo = s.hasTeam; L.git = s.git;
      L.doc = s.doc; L.colgando = s.colgando || 0;
      L.acts = s.acts; L.toks = s.toks; L.up = s.up; L.lat = s.lat;
      L.desde = s.startedAt;

      const suyosAhora = new Set();
      for (const a of s.agents){
        const k = s.id + '|' + a.name;
        suyosAhora.add(k);
        let A = agentes.get(k);
        const etiqueta = a.title || a.name;
        if (!A){
          const ang = Math.random() * Math.PI * 2, d = 62 + Math.random()*38;
          const fam = familia(etiqueta + ' ' + (a.type || ''));
          A = { k, leadId:s.id, etiqueta, fam,
                color: FAM[fam].color || PAL[agentes.size % PAL.length],
                x: L.x + Math.cos(ang)*d, y: L.y + Math.sin(ang)*d,
                vx:0, vy:0, r: foco ? 14 : 10.5, fase: Math.random()*6.28, ini:'??' };
          agentes.set(k, A);
          recalcIniciales(s.id);
        }
        A.etiqueta = etiqueta; A.tipo = a.type || '';
        A.retirado = a.retired; A.acts = a.acts; A.toks = a.toks;
        A.accion = `${a.tool || ''} ${a.action || ''}`.trim();
        A.vivo = (now - a.last) < WORKING;
      }
      for (const [k, a] of agentes) if (a.leadId === s.id && !suyosAhora.has(k)) agentes.delete(k);

      // mensajes nuevos desde el último refresco -> partículas
      const previo = vistos.get(s.id) || 0;
      let ultimoT = previo;
      for (const m of (s.messages || [])){
        if (m.t <= previo) continue;
        ultimoT = Math.max(ultimoT, m.t);
        const de = m.from === 'team-lead' ? L : agentes.get(s.id + '|' + m.from);
        const a  = m.to   === 'team-lead' ? L : agentes.get(s.id + '|' + m.to);
        if (de && a && de !== a) pulsos.push({ a:de, b:a, t:0, lateral: !!m.lateral });
      }
      vistos.set(s.id, ultimoT);
    }
    // el tamaño de cada zona depende de cuántos agentes tiene, así que nacer o
    // retirarse también reordena el reparto
    if (cambioZonas || agentes.size !== antes) repartirZonas();
  }

  /** En foco solo existe una sesión; en el mapa, todas. */
  const enJuego = () => foco && leads.has(foco)
    ? { listaL: [leads.get(foco)], listaA: [...agentes.values()].filter(a => a.leadId === foco) }
    : { listaL: [...leads.values()], listaA: [...agentes.values()] };

  /* ── física ── */
  function paso(dt){
    const { listaA, listaL } = enJuego();
    for (const a of listaA){
      const L = leads.get(a.leadId); if (!L) continue;
      const dx = L.x - a.x, dy = L.y - a.y, d = Math.hypot(dx,dy) || 1;
      const hermanos = a.nHermanos || 1;
      // en foco hay lienzo entero para una sola sesión: el pulpo se abre
      const abre = foco ? 2.1 : 1;
      const reposo = (a.retirado ? 96 : 72 + (hermanos > 8 ? 26 : 0)) * abre;
      const k = a.retirado ? 0.008 : 0.014;
      a.vx += (dx/d)*(d-reposo)*k; a.vy += (dy/d)*(d-reposo)*k;
      a.vx += Math.cos(t*0.55 + a.fase)*0.055;
      a.vy += Math.sin(t*0.45 + a.fase)*0.055;
      // un agente pertenece a la zona de su repo: sin esto se escapan al de al
      // lado y parece que trabajan donde no es
      const z = L.zona;
      if (z){
        // el pie de la zona también es zona muerta para los nodos
        const x0 = z.cx-z.rx+14, x1 = z.cx+z.rx-14, y0 = z.cy-z.ry+44, y1 = z.cy+z.ry-28;
        if (a.x < x0) a.vx += (x0-a.x)*0.025;
        if (a.x > x1) a.vx -= (a.x-x1)*0.025;
        if (a.y < y0) a.vy += (y0-a.y)*0.025;
        if (a.y > y1) a.vy -= (a.y-y1)*0.025;
      }
    }
    for (let i = 0; i < listaA.length; i++){
      for (let j = i+1; j < listaA.length; j++){
        const a = listaA[i], b = listaA[j];
        const dx = b.x-a.x, dy = b.y-a.y, d2 = dx*dx+dy*dy;
        if (d2 > (foco ? 26000 : 9000)) continue;
        const d = Math.sqrt(d2) || 1, f = Math.min(2.4, (foco ? 900 : 330)/(d2+40));
        a.vx -= dx/d*f; a.vy -= dy/d*f; b.vx += dx/d*f; b.vy += dy/d*f;
      }
    }
    for (const a of listaA){
      for (const L of listaL){
        if (L.id === a.leadId) continue;
        const dx = a.x-L.x, dy = a.y-L.y, d = Math.hypot(dx,dy) || 1;
        if (d < 92){ const f = (92-d)*0.05; a.vx += dx/d*f; a.vy += dy/d*f; }
      }
    }
    for (const L of listaL){
      const z = L.zona; if (!z) continue;
      const hermanos = listaL.filter(o => o.repo === L.repo);
      const n = hermanos.length;
      const idx = hermanos.indexOf(L);
      // Reparto en ELIPSE, no en círculo: las zonas son anchas y bajas, así que
      // repartir por un círculo apilaba las cabezas una encima de otra y
      // desperdiciaba todo el ancho. Con dos, una a cada lado.
      const ang = (idx / n) * Math.PI * 2 + (n === 2 ? 0 : -Math.PI / 2);
      const sepX = n > 1 ? z.rx * 0.46 : 0;
      const sepY = n > 2 ? z.ry * 0.34 : 0;
      const tx = z.cx + Math.cos(ang)*sepX, ty = z.cy + Math.sin(ang)*sepY;
      const k = hermanos.length > 1 ? 0.02 : 0.03;
      L.vx += (tx-L.x)*k; L.vy += (ty-L.y)*k;
      L.vx += Math.cos(t*0.3 + L.fase)*0.09; L.vy += Math.sin(t*0.26 + L.fase)*0.09;
      for (const O of listaL){
        if (O === L) continue;
        const dx = L.x-O.x, dy = L.y-O.y, d = Math.hypot(dx,dy) || 1;
        if (d < 200){ const f = (200-d)*0.012; L.vx += dx/d*f; L.vy += dy/d*f; }
      }
      // y la cabeza tampoco se sale de su caja, que la repulsión entre sesiones
      // del mismo repo la empujaba fuera
      const bx0 = z.cx-z.rx+38, bx1 = z.cx+z.rx-38, by0 = z.cy-z.ry+66, by1 = z.cy+z.ry-56;
      if (L.x < bx0) L.vx += (bx0-L.x)*0.035;
      if (L.x > bx1) L.vx -= (L.x-bx1)*0.035;
      if (L.y < by0) L.vy += (by0-L.y)*0.035;
      if (L.y > by1) L.vy -= (L.y-by1)*0.035;
    }
    for (const n of [...listaL, ...listaA]){
      if (n === arrastrando?.nodo || n.fijo){ n.vx = n.vy = 0; continue; }
      n.vx *= 0.9; n.vy *= 0.9;
      n.x += n.vx; n.y += n.vy;
      const m = n.r + 6;
      if (n.x < m){ n.x = m; n.vx = Math.abs(n.vx)*0.4; }
      if (n.x > W-m){ n.x = W-m; n.vx = -Math.abs(n.vx)*0.4; }
      if (n.y < m){ n.y = m; n.vy = Math.abs(n.vy)*0.4; }
      if (n.y > H-m){ n.y = H-m; n.vy = -Math.abs(n.vy)*0.4; }
    }
    const porLead = {};
    for (const a of listaA) porLead[a.leadId] = (porLead[a.leadId]||0)+1;
    for (const a of listaA) a.nHermanos = porLead[a.leadId];
  }

  /* ── cables ── */
  const ctrlTent = (L,a) => {
    const mx=(L.x+a.x)/2, my=(L.y+a.y)/2, nx=-(a.y-L.y), ny=(a.x-L.x);
    const nl=Math.hypot(nx,ny)||1, amp=Math.sin(t*1.1+a.fase)*13;
    return { x:mx+nx/nl*amp, y:my+ny/nl*amp };
  };
  const ctrlLat = (a,b) => {
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, nx=-(b.y-a.y), ny=(b.x-a.x);
    const nl=Math.hypot(nx,ny)||1, amp=30+Math.sin(t*0.9)*6;
    return { x:mx+nx/nl*amp, y:my+ny/nl*amp };
  };
  function curva(p){
    if (p.lateral) return { p0:p.a, c:ctrlLat(p.a,p.b), p1:p.b };
    const ag = p.a.esLead ? p.b : p.a, L = p.a.esLead ? p.a : p.b;
    return { p0:p.a, c:ctrlTent(L,ag), p1:p.b };
  }
  const enCurva = (cv,u) => {
    const k = 1-u;
    return { x:k*k*cv.p0.x + 2*k*u*cv.c.x + u*u*cv.p1.x,
             y:k*k*cv.p0.y + 2*k*u*cv.c.y + u*u*cv.p1.y };
  };

  function forma(x,y,r,f){
    ctx.beginPath();
    if (f === 'circulo'){ ctx.arc(x,y,r,0,6.29); return; }
    if (f === 'rombo'){ ctx.moveTo(x,y-r*1.18); ctx.lineTo(x+r*1.18,y); ctx.lineTo(x,y+r*1.18); ctx.lineTo(x-r*1.18,y); ctx.closePath(); return; }
    if (f === 'tri'){ const R=r*1.28; ctx.moveTo(x,y-R); ctx.lineTo(x+R*0.87,y+R*0.5); ctx.lineTo(x-R*0.87,y+R*0.5); ctx.closePath(); return; }
    for (let i=0;i<6;i++){ const a=Math.PI/6+i*Math.PI/3, px=x+Math.cos(a)*r*1.12, py=y+Math.sin(a)*r*1.12; i?ctx.lineTo(px,py):ctx.moveTo(px,py); }
    ctx.closePath();
  }

  /* ── dibujo ── */
  function dibujar(){
    ctx.clearRect(0,0,W,H);
    const { listaA, listaL } = enJuego();

    for (const z of zonas){
      const x = z.cx-z.rx, y = z.cy-z.ry, an = z.rx*2, al = z.ry*2;
      ctx.save();
      // superficie propia: el repo tiene que leerse como un recinto, no como
      // cuatro rayas sueltas
      ctx.beginPath(); ctx.roundRect(x, y, an, al, 12);
      ctx.fillStyle = '#191920'; ctx.fill();
      ctx.strokeStyle = '#33303d'; ctx.lineWidth = 1.2; ctx.stroke();
      // franja de cabecera
      ctx.save();
      ctx.clip();
      ctx.fillStyle = '#1f1d27'; ctx.fillRect(x, y, an, 30);
      ctx.restore();
      ctx.beginPath(); ctx.moveTo(x, y+30); ctx.lineTo(x+an, y+30);
      ctx.strokeStyle = '#2b2833'; ctx.lineWidth = 1; ctx.stroke();

      // el semáforo que el propio proyecto se puso en su _state.md
      const doc = listaL.find(l => l.repo === z.nombre && l.doc)?.doc;
      let tx = x + 13;
      if (doc?.semaforo){
        ctx.font = '11px ui-sans-serif,system-ui'; ctx.textAlign = 'left';
        ctx.fillText(doc.semaforo, tx, y+19);
        tx += 17;
      }
      ctx.fillStyle = '#8b8797'; ctx.font = '700 11.5px ui-sans-serif,system-ui'; ctx.textAlign = 'left';
      ctx.fillText(z.nombre, tx, y+19);
      // una sesión cerrada NO es una sesión abierta: contarlas juntas hacía
      // creer que había dos del CRM cuando una llevaba 24 min muerta
      const suyasZona = listaL.filter(l => l.repo === z.nombre);
      const abiertas = suyasZona.filter(l => l.estado !== 'closed').length;
      const cerradas = suyasZona.length - abiertas;
      const vivos = listaA.filter(a => leads.get(a.leadId)?.repo === z.nombre && !a.retirado).length;
      const partesCab = [];
      if (abiertas) partesCab.push(`${abiertas} ${abiertas === 1 ? 'sesión' : 'sesiones'}`);
      if (cerradas) partesCab.push(`${cerradas} cerrada${cerradas > 1 ? 's' : ''}`);
      if (vivos) partesCab.push(`${vivos} agentes`);
      ctx.fillStyle = '#5a5666'; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'right';
      ctx.fillText(partesCab.join(' · ') || 'sin sesiones', x+an-13, y+19);

      // pie: el total del repo sumando sus sesiones
      const suyas = listaL.filter(l => l.repo === z.nombre);
      const acts = suyas.reduce((s,l) => s + (l.acts||0), 0);
      const toks = suyas.reduce((s,l) => s + (l.toks||0), 0);
      const lat  = suyas.reduce((s,l) => s + (l.lat||0), 0);
      const ramas = [...new Set(suyas.map(l => l.rama).filter(Boolean))];
      ctx.textAlign = 'left'; ctx.font = '9.5px ui-monospace,monospace'; ctx.fillStyle = '#4a4656';
      const base = `${miles(acts)} acciones · ${tk(toks)} tokens`;
      ctx.fillText(base, x+13, y+al-11);
      let cursor = x + 13 + ctx.measureText(base).width + 12;
      if (lat){
        ctx.fillStyle = '#E60076';
        const t2 = `${lat} laterales`;
        ctx.fillText(t2, cursor, y+al-11);
        cursor += ctx.measureText(t2).width + 12;
      }
      // tareas que alguna sesión de este repo dejó a medias
      const colg = suyas.reduce((s2,l) => s2 + (l.colgando||0), 0);
      if (colg){
        ctx.fillStyle = '#c084fc';
        const t4 = `${colg} ${colg === 1 ? 'tarea' : 'tareas'} sin cerrar`;
        ctx.fillText(t4, cursor, y+al-11);
        cursor += ctx.measureText(t4).width + 12;
      }

      // trabajo sin guardar: lo que el panel sabía y no decía
      const g = suyas.find(l => l.git)?.git;
      if (g && (g.sucios || g.sinSubir)){
        const viejo = g.ultimoCommit && (Date.now()/1000 - g.ultimoCommit) > 86400;
        const partes = [];
        if (g.sucios) partes.push(`${g.sucios} sin commitear`);
        if (g.sinSubir) partes.push(`${g.sinSubir} sin subir`);
        const t3 = '⚠ ' + partes.join(' · ') + (viejo ? ` · último commit hace ${rato(Date.now()/1000 - g.ultimoCommit)}` : '');
        ctx.fillStyle = g.sucios ? (viejo ? '#FFB547' : '#8a7a4a') : '#5a6675';
        ctx.fillText(t3, cursor, y+al-11);
      }
      if (ramas.length){
        ctx.textAlign = 'right'; ctx.fillStyle = '#45414f';
        ctx.fillText(ramas.length === 1 ? ramas[0] : ramas.length + ' ramas', x+an-13, y+al-11);
      }
      ctx.restore();
    }

    for (const a of listaA){
      const L = leads.get(a.leadId); if (!L) continue;
      const g = ctx.createLinearGradient(L.x,L.y,a.x,a.y);
      g.addColorStop(0, (COL[L.estado]||'#5A5766') + '55');
      g.addColorStop(1, (a.retirado ? '#2b2b34' : a.color) + (a.retirado ? '33' : 'cc'));
      const viaja = pulsos.some(p => !p.lateral && (p.a===a || p.b===a));
      ctx.strokeStyle = viaja ? '#c084fc' : g;
      ctx.lineWidth = a.retirado ? 1 : (viaja ? 2.6 : 1.5);
      const c0 = ctrlTent(L,a);
      ctx.beginPath(); ctx.moveTo(L.x,L.y); ctx.quadraticCurveTo(c0.x,c0.y,a.x,a.y); ctx.stroke();
    }

    for (const p of pulsos){
      if (!p.lateral) continue;
      const cv = curva(p);
      ctx.strokeStyle='#E60076'; ctx.lineWidth=1.6; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(cv.p0.x,cv.p0.y); ctx.quadraticCurveTo(cv.c.x,cv.c.y,cv.p1.x,cv.p1.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* Sitios que una etiqueta no puede pisar. Se siembra con las cabezas y con
       su cartel de estado: se dibujan después, pero ya sabemos dónde van a caer. */
    const ocupado = [];
    for (const L of listaL){
      ocupado.push({ x0: L.x-L.r-6, x1: L.x+L.r+6, y0: L.y-L.r-6, y1: L.y+L.r+6 });
      ocupado.push({ x0: L.x-70,    x1: L.x+70,    y0: L.y+L.r+6, y1: L.y+L.r+34 });
    }

    for (const a of listaA){
      const f = FAM[a.fam].forma, pulso = a.vivo && !a.retirado ? 1+Math.sin(t*2.4+a.fase)*0.06 : 1;
      if (a.vivo && !a.retirado){ forma(a.x,a.y,a.r*pulso+7,f); ctx.fillStyle = a.color+'18'; ctx.fill(); }
      forma(a.x,a.y,a.r*pulso,f);
      ctx.fillStyle = a.retirado ? '#191920' : '#1c1c23'; ctx.fill();
      ctx.strokeStyle = a.retirado ? '#2b2b34' : a.color; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = a.retirado ? '#4c4956' : a.color;
      ctx.font = '700 8.5px ui-monospace,monospace'; ctx.textAlign = 'center';
      ctx.fillText(a.ini, a.x, a.y + (f==='tri'?6:3));
      if (!a.retirado || foco){
        /* Las etiquetas se estorban entre ellas, y en foco más que en ningún
           sitio: ahí son casi el doble de largas y con más cuerpo. Antes se
           daban por buenas sin mirar ("en foco hay sitio de sobra") y salían
           nombres pisados unos encima de otros. Ahora cada una mide su caja de
           verdad y busca hueco: primero a la derecha del nodo, si no cabe a la
           izquierda, y si tampoco, no se dibuja. No se pierde nada: las
           iniciales siguen dentro del círculo y el nombre entero sale al pasar
           el ratón. */
        ctx.font = (foco ? '600 10.5px ' : '600 9px ') + 'ui-sans-serif,system-ui';
        const tope = foco ? 30 : 16;
        const n = a.etiqueta.length > tope ? a.etiqueta.slice(0,tope-1)+'…' : a.etiqueta;
        const an = ctx.measureText(n).width, alto = foco ? 14 : 12;
        const y0 = a.y+3-alto/2, y1 = a.y+3+alto/2;
        const donde = [
          { align:'left',  x: a.x+a.r+7, x0: a.x+a.r+7,    x1: a.x+a.r+7+an },
          { align:'right', x: a.x-a.r-7, x0: a.x-a.r-7-an, x1: a.x-a.r-7    },
        ];
        const choca = (s) =>
          ocupado.some((c) => c.x0 < s.x1 && c.x1 > s.x0 && c.y0 < y1 && c.y1 > y0) ||
          listaA.some((o) => o !== a &&
            o.x+o.r > s.x0 && o.x-o.r < s.x1 && o.y+o.r > y0 && o.y-o.r < y1);
        const sitio = donde.find((s) => !choca(s));
        if (sitio){
          ocupado.push({ x0: sitio.x0, x1: sitio.x1, y0, y1 });
          ctx.fillStyle = foco ? '#9d98ac' : '#78748a';
          ctx.textAlign = sitio.align;
          ctx.fillText(n, sitio.x, a.y+3);
        }
      }
    }

    for (const L of listaL){
      const col = COL[L.estado] || '#5A5766';
      const pulso = L.vivo ? 1+Math.sin(t*2.1+L.fase)*0.05 : 1;
      ctx.beginPath(); ctx.arc(L.x,L.y,L.r*pulso+10,0,6.29); ctx.fillStyle = col+'14'; ctx.fill();
      ctx.beginPath(); ctx.arc(L.x,L.y,L.r*pulso+5,0,6.29); ctx.strokeStyle = col+'66'; ctx.lineWidth=1.4; ctx.stroke();
      ctx.beginPath(); ctx.arc(L.x,L.y,L.r*pulso,0,6.29); ctx.fillStyle='#202027'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle='#F8FAFC'; ctx.font='700 9px ui-monospace,monospace'; ctx.textAlign='center';
      ctx.fillText('LEAD', L.x, L.y+3);
      // debajo va lo que de verdad importa de un vistazo: el estado y cuánto
      // lleva así. El id, más pequeño y en gris, por si hace falta buscarla
      let est = ESTADO[L.estado] || '';
      if (L.estado === 'waiting') est += ' · ' + rato(L.idle);
      else if (L.estado === 'agents') est += ' · líder ' + rato(L.idleLider);
      // con fondo: si no, los tentáculos de los vecinos las cruzan y no se leen
      // si la zona es baja no cabe la segunda línea: mejor una que media
      const z = L.zona;
      const sitio = z ? (z.cy + z.ry) - (L.y + L.r) : 999;
      const dosLineas = sitio > 44;
      const idTxt = L.id.slice(0,8) + (L.equipo ? ' · equipo' : '');
      ctx.font = '700 10px ui-monospace,monospace';
      const w1 = ctx.measureText(est).width;
      ctx.font = '9px ui-monospace,monospace';
      const w2 = dosLineas ? ctx.measureText(idTxt).width : 0;
      const w = Math.max(w1, w2) + 12;
      ctx.fillStyle = 'rgba(22,22,27,.86)';
      ctx.beginPath();
      ctx.roundRect(L.x - w/2, L.y+L.r+6, w, dosLineas ? 27 : 16, 5);
      ctx.fill();
      ctx.fillStyle = col; ctx.font = '700 10px ui-monospace,monospace';
      ctx.fillText(est, L.x, L.y+L.r+18);
      if (dosLineas){
        ctx.fillStyle = '#5f5b6c'; ctx.font = '9px ui-monospace,monospace';
        ctx.fillText(idTxt, L.x, L.y+L.r+30);
      }
    }

    ctx.save(); ctx.setLineDash([2,4]); ctx.lineWidth=1.2; ctx.strokeStyle='#F8FAFC88';
    for (const n of [...listaL, ...listaA]){
      if (!n.fijo) continue;
      ctx.beginPath(); ctx.arc(n.x,n.y,n.r+(n.esLead?15:11),0,6.29); ctx.stroke();
    }
    ctx.restore();

    for (const f of destellos){
      ctx.beginPath(); ctx.arc(f.x,f.y,10+f.t*26,0,6.29);
      ctx.strokeStyle = f.color + Math.round((1-f.t)*200).toString(16).padStart(2,'0');
      ctx.lineWidth = 2.2*(1-f.t); ctx.stroke();
    }

    for (const p of pulsos){
      const cv = curva(p), col = p.lateral ? '#E60076' : '#c084fc';
      for (let i=1;i<=6;i++){
        const u = p.t - i*0.045; if (u <= 0) break;
        const q = enCurva(cv,u);
        ctx.beginPath(); ctx.arc(q.x,q.y,3.6-i*0.42,0,6.29);
        ctx.fillStyle = col + Math.round(120-i*18).toString(16).padStart(2,'0'); ctx.fill();
      }
      const pt = enCurva(cv, Math.min(1,p.t));
      ctx.beginPath(); ctx.arc(pt.x,pt.y,11,0,6.29); ctx.fillStyle = col+'33'; ctx.fill();
      ctx.beginPath(); ctx.arc(pt.x,pt.y,5,0,6.29);  ctx.fillStyle = col;      ctx.fill();
      ctx.beginPath(); ctx.arc(pt.x,pt.y,2,0,6.29);  ctx.fillStyle = '#fff';   ctx.fill();
    }
  }

  /* ── bucle ── */
  function frame(ms){
    const dt = Math.min(0.05, (ms - ultimo) / 1000);
    ultimo = ms; t += dt;
    if (W && H){
      pasoReplay(dt);
      paso(dt);
      for (let i=pulsos.length-1;i>=0;i--){
        const p = pulsos[i]; p.t += dt*0.8;
        if (p.t >= 1){
          destellos.push({ x:p.b.x, y:p.b.y, t:0, color:p.lateral?'#E60076':'#c084fc' });
          pulsos.splice(i,1);
        }
      }
      for (let i=destellos.length-1;i>=0;i--){ destellos[i].t += dt*1.9; if (destellos[i].t>=1) destellos.splice(i,1); }
      dibujar();
    }
    requestAnimationFrame(frame);
  }

  /* ── ratón ── */
  const nodoEn = (mx,my) => {
    const { listaA, listaL } = enJuego();
    for (const n of [...listaA, ...listaL])
      if (Math.hypot(n.x-mx, n.y-my) < n.r+7) return n;
    return null;
  };
  const posRaton = (e) => { const r = c.getBoundingClientRect(); return { mx:e.clientX-r.left, my:e.clientY-r.top }; };

  function medir(){
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = c.getBoundingClientRect();
    W = r.width; H = r.height;
    c.width = W*dpr; c.height = H*dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    repartirZonas();
  }

  function init(canvas, cajaFicha, opts = {}){
    c = canvas; ctx = c.getContext('2d'); ficha = cajaFicha;
    alClicarLider = opts.alClicarLider || (() => {});

    c.addEventListener('mousedown', (e) => {
      const { mx,my } = posRaton(e); const n = nodoEn(mx,my);
      if (!n) return;
      arrastrando = { nodo:n, dx:n.x-mx, dy:n.y-my, movido:false };
      c.style.cursor = 'grabbing'; e.preventDefault();
    });
    window.addEventListener('mouseup', () => {
      if (!arrastrando) return;
      const { nodo, movido } = arrastrando;
      arrastrando = null; c.style.cursor = 'default';
      // arrastrar coloca y clava; el clic en una cabeza SIEMPRE entra, esté
      // clavada o no. Antes el clic liberaba primero y nunca llegabas al
      // detalle: colocabas la cabeza y al pulsarla se te volvía a su sitio.
      if (movido){ nodo.fijo = true; return; }
      if (nodo.esLead){ alClicarLider(nodo.id); return; }
      if (nodo.fijo) nodo.fijo = false;   // los agentes no tienen detalle: el clic los suelta
    });
    // para soltar una cabeza clavada, sin pelearse con el clic de entrar
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { mx, my } = posRaton(e);
      const n = nodoEn(mx, my);
      if (n) n.fijo = false;
    });
    c.addEventListener('mousemove', (e) => {
      const { mx,my } = posRaton(e);
      if (arrastrando){
        const n = arrastrando.nodo;
        if (Math.hypot(n.x-(mx+arrastrando.dx), n.y-(my+arrastrando.dy)) > 1.5) arrastrando.movido = true;
        n.x = Math.max(n.r+6, Math.min(W-n.r-6, mx+arrastrando.dx));
        n.y = Math.max(n.r+6, Math.min(H-n.r-6, my+arrastrando.dy));
        n.vx = n.vy = 0; ficha.style.opacity = 0; return;
      }
      hover = nodoEn(mx,my);
      c.style.cursor = hover ? (hover.esLead ? 'pointer' : 'grab') : 'default';
      if (!hover){ ficha.style.opacity = 0; return; }
      ficha.style.opacity = 1;
      ficha.style.left = Math.min(W-300, mx+16) + 'px';
      ficha.style.top = Math.max(6, my-10) + 'px';
      ficha.innerHTML = hover.esLead
        ? `<b>${hover.repo}</b><br>
           ${hover.doc ? `<span style="color:var(--txt-2)">${hover.doc.semaforo} ${hover.doc.texto}</span><br>` : ''}
           ${hover.colgando ? `<span class="l">tareas sin cerrar</span> <span style="color:#c084fc">${hover.colgando}</span><br>` : ''}
           <span class="l">sesión</span> ${hover.id.slice(0,8)} · ${hover.rama || 'sin rama'}${hover.equipo ? ' · equipo' : ''}<br>
           <span class="l">estado</span> <span style="color:${COL[hover.estado]}">${ESTADO[hover.estado]}</span>
             ${hover.estado === 'waiting' ? 'desde hace ' + rato(hover.idle) : ''}<br>
           <span class="l">viva desde hace</span> ${rato((Date.now()/1000) - hover.desde)}<br>
           <span class="l">dónde lo dejaste</span><br>${(hover.accion||'—').slice(0,70)}<br>
           ${hover.git && (hover.git.sucios || hover.git.sinSubir)
             ? `<span class="l">sin guardar</span> <span style="color:#FFB547">${hover.git.sucios} ficheros${hover.git.sinSeguir ? ` (${hover.git.sinSeguir} nuevos)` : ''}</span>${hover.git.sinSubir ? ` · ${hover.git.sinSubir} commits sin subir` : ''}<br>` : ''}
           <span class="l">acciones</span> ${miles(hover.acts)} ·
           <span class="l">tokens</span> ${tk(hover.toks)} ·
           <span class="l">al líder</span> ${hover.up||0} ·
           <span class="l" style="color:${hover.lat ? '#ff9ec9' : ''}">laterales</span> ${hover.lat||0}<br>
           <span class="l" style="color:var(--accent-soft)">clic para ver el detalle</span>`
        : `<b>${hover.etiqueta}</b><br>
           <span class="l">familia</span> <span style="color:${FAM[hover.fam].color||'#7ee787'}">${FAM[hover.fam].txt}</span><br>
           ${hover.tipo ? `<span class="l">tipo</span> ${hover.tipo}<br>` : ''}
           <span class="l">estado</span> ${hover.retirado ? 'retirado' : (hover.vivo ? 'trabajando' : 'parado')}<br>
           <span class="l">ahora</span> ${(hover.accion||'—').slice(0,54)}<br>
           <span class="l">acciones</span> ${hover.acts||0} · ${((hover.toks||0)/1000).toFixed(0)}k tokens`;
    });
    c.addEventListener('mouseleave', () => { ficha.style.opacity = 0; hover = null; });
    window.addEventListener('resize', medir);

    medir(); ultimo = performance.now(); requestAnimationFrame(frame);
  }

  /** Modo foco: solo esa sesión, a lo grande. null vuelve al mapa entero. */
  function enfocar(id){
    foco = id;
    for (const L of leads.values()){ L.r = id ? 30 : 21; L.fijo = false; }
    for (const a of agentes.values()){ a.r = id ? 14 : 10.5; a.fijo = false; }
    repartirZonas();
  }

  return {
    init, sync, medir, enfocar, empezarReplay, pararReplay,
    replayEstado(){ return replay; },
    replayPausa(){ if (replay) replay.playing = !replay.playing; return replay?.playing; },
    replayVelocidad(v){ if (replay) replay.vel = v; },
    replaySaltar(frac){
      if (!replay) return;
      const destino = replay.datos.duracion * frac;
      if (destino < replay.t){   // hacia atrás: se rebobina desde cero
        replay.t = 0; replay.idx = 0;
        agentes.clear();
        const L = leads.get(replay.datos.id);
        if (L){ L.acts = 0; L.up = 0; L.lat = 0; }
      }
      // avanzar sin animar hasta el punto pedido
      const guarda = replay.playing; replay.playing = true;
      pasoReplay((destino - replay.t) / replay.vel);
      replay.playing = guarda;
      pulsos.length = 0;
    },
    soltarTodos(){ for (const n of [...leads.values(), ...agentes.values()]) n.fijo = false; },
  };
})();
