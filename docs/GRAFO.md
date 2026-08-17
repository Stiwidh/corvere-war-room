# El grafo del código

El War Room puede dibujar, además de la flota, un **grafo de tu código**: cuántos módulos
hay, quién importa a quién, qué está más acoplado y qué se rompe si tocas un fichero.

**Es opcional y no viene incluido.** El panel funciona igual sin él: las secciones
sencillamente no aparecen.

## Por qué no viene incluido

Porque no existe un indexador que valga para todos los lenguajes ni para todas las formas
de organizar un repositorio. El nuestro entiende TypeScript, Astro, Python y Markdown, y no
te serviría tal cual.

Lo que el panel sí define es el **formato**. Si tu herramienta escribe un JSON con esa
forma, la vista se dibuja sola:

```ini
# ~/.config/warroom/env
WARROOM_GRAFO_JSON=/ruta/a/tu/grafo.json
```

El panel lo relee cada 20 segundos. Si el fichero desaparece, la sección se oculta y no
pasa nada más.

## El formato

Todas las claves son opcionales salvo `salud`: lo que falte, no se dibuja.

```jsonc
{
  "generado": "2026-08-17T09:00:00Z",

  // Tamaño del grafo. Es lo mínimo para que la sección aparezca.
  "salud": {
    "nodos_total": 34817,
    "aristas_total": 71979,
    "nodos":   { "fichero": 12000, "rpc": 210 },   // libre: {tipo: cuántos}
    "aristas": { "importa": 40000, "invoca": 900 },
    "indexaciones": [
      { "indexador": "codigo", "empezado": "2026-08-17T08:03:00Z",
        "duracion_ms": 61000, "nodos": 31305, "aristas": 65000 }
    ]
  },

  // Dibujos YA HECHOS. El panel no los calcula: los pinta tal cual, así que
  // aquí va SVG en crudo, como texto. Es lo que te deja usar el estilo que
  // quieras sin tocar una línea del panel.
  "vistas": {
    "treemap": "<svg …>…</svg>",       // el peso de cada módulo
    "matriz":  "<svg …>…</svg>",       // quién depende de quién
    "lado_matriz": 40,                  // nº de celdas por lado
    "stats": { "modulos": 60, "ficheros": 3100, "pares": 900, "ciclos": 4, "ms": 120 },
    "acoplamiento": { "src/lib/db.ts": 57 }   // {fichero: cuántos dependen de él}
  },

  // Cuántas veces se consulta el grafo. Sirve para saber si la herramienta se
  // usa de verdad o acabó siendo un adorno. Si no lo mides, quítalo entero.
  "uso": {
    "total": 4200, "ultimas_24h": 130, "desde_hooks": 3900,
    "por_sesion": { "<uuid-de-sesión>": 12 }   // cruza con las sesiones del panel
  },

  // Diferencias entre lo que el código invoca y lo que existe desplegado.
  "drift": { "rpc_fantasma": 0, "tabla_fantasma": 2 }
}
```

### El bloque de producción

Aparte y opcional. Dibuja el espacio que ocupan tus bases de datos y las alertas abiertas.

```jsonc
"produccion": {
  "instancias": [
    { "nombre": "mi-app", "ref": "abcdefgh", "mb": 391,
      "plan": "free", "techo_mb": 500, "pct": 78,
      "crons": 12, "crons_parados": 0 }
  ],
  // Con una sesión abierta, el panel enseña SOLO la instancia de ese proyecto.
  // La clave es el nombre de la carpeta del repositorio.
  "por_proyecto": { "mi-proyecto": "abcdefgh" },
  "alertas_48h": [
    { "tipo": "error_spike", "severidad": "error", "abiertas": 1, "total": 3,
      "ocurrencias": 3, "origen": "mi-app", "instancia": "abcdefgh",
      "proyecto": "mi-proyecto", "ultima": "2026-08-17T07:00:00Z",
      "muestras": [{ "title": "…", "mensaje": "…" }] }
  ],
  "alertas_abiertas": 1,
  "alertas_ocurrencias": 3
}
```

Dos detalles que salieron de usarlo:

- **`techo_mb` por instancia, no uno global.** Con un techo único, una instancia de pago
  salía en rojo al 84% estando al 5%, y esa alarma falsa tapaba la única de verdad.
- **`proyecto` en cada alerta.** Sin él, abrir la sesión de un producto y seguir viendo
  debajo las alertas de otro es el ruido que hace que un panel deje de leerse. Lo que no
  sepas clasificar, déjalo en `null`: eso se enseña siempre.

## El botón "explorar el grafo"

Abre una vista navegable a pantalla completa. Es un extra sobre lo anterior y necesita
que, **en la misma carpeta del JSON**, haya:

| Fichero | Qué es |
|---|---|
| `explorador.html` | La vista, HTML autocontenido. Se sirve tal cual |
| `graph.db` | Tu índice. Solo se mira su fecha, para saber si el dibujo está viejo |

Si `explorador.html` es más viejo que `graph.db`, el panel intenta regenerarlo llamando a
`python3 ../graph.py explorador` (un nivel por encima del JSON). Si no tienes ese script,
no pasa nada: se sirve el HTML que haya, y si no hay ninguno sale la página explicativa.

No va dentro del JSON principal a propósito: son megas de HTML, y el panel recarga ese
JSON cada pocos segundos.

## Montártelo con Claude

No hace falta que copies nuestro indexador. Este documento **es** la especificación, así
que lo más rápido es dársela a Claude Code dentro de tu propio repositorio:

> Lee `docs/GRAFO.md` del War Room. Escribe un indexador para este repositorio que recorra
> el código, extraiga los imports reales de cada fichero y escriba un JSON con ese formato.
> Empieza solo por `salud` y `vistas.acoplamiento`, que es lo que ya dibuja algo útil.
> Deja el treemap y la matriz para después.

Ese orden importa: `salud` y `acoplamiento` son un recorrido de ficheros y un contador, se
hacen en una tarde y ya responden a "qué se rompe si toco esto". Los SVG son la parte
vistosa y la que más tiempo come, y no aportan nada hasta que lo anterior es correcto.

Consejo por experiencia: extrae los imports del **AST** del lenguaje, no con expresiones
regulares. Un `grep` de `import` confunde comentarios, cadenas y rutas dinámicas, y un
grafo con aristas falsas es peor que no tener grafo, porque te hace confiar en él.
