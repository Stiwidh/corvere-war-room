# Avisos

El panel puede avisarte cuando algo lleva demasiado tiempo parado. **Están apagados
por defecto** y no se encienden solos: hace falta darle una URL y una clave tuyas.

El War Room no manda nada a ningún servicio nuestro ni de nadie. Manda un `POST` al
endpoint **que tú le digas**, y ahí cada uno decide qué hacer: Telegram, Slack, un
correo, una fila en una tabla o nada.

## Encenderlos

En `~/.config/warroom/env` (en Windows, `%USERPROFILE%\.config\warroom\env`):

```ini
WARROOM_ALERTAS=1
WARROOM_ALERT_URL=https://…/tu-endpoint
WARROOM_ALERT_KEY=una-clave-larga-tuya
```

Sin las tres cosas no se manda nada. El fichero vive fuera del repositorio y en
permisos 600, y `install.sh` lo crea vacío la primera vez.

## Los tres avisos

| Aviso | Cuándo salta | Severidad |
|---|---|---|
| `warroom_sesion_olvidada` | Una sesión lleva **3 h** esperándote | `warning` |
| `warroom_trabajo_sin_guardar` | Un repo lleva **24 h** con ficheros sueltos sin commitear | `warning` |
| `warroom_agente_atascado` | Un agente lleva **20 min** sin dar señales | `info` |

Los umbrales están en la constante `UMBRAL`, arriba de `server.mjs`.

## Qué recibe tu endpoint

Un `POST` con `content-type: application/json` y tu clave en la cabecera **`x-admin-key`**:

```json
{
  "source": "war-room",
  "notify": true,
  "severity": "warning",
  "event_type": "warroom_sesion_olvidada",
  "title": "Sesión olvidada en mi-proyecto",
  "message": "Lleva 4 h esperándote. Última acción: Edit",
  "metadata": { "sesion": "b7d2e8a1…", "proyecto": "mi-proyecto", "idle_s": 14400 }
}
```

`metadata` cambia según el aviso: el de trabajo sin guardar trae `sucios` con el número
de ficheros, y el de agente atascado identifica al agente.

## Y también los cierra

Esta es la parte que se olvida al montar el receptor. Cuando la condición **deja de
cumplirse** (guardaste el trabajo, retomaste la sesión), el panel manda el mismo evento
con un campo más:

```json
{ "source": "war-room", "event_type": "warroom_sesion_olvidada",
  "title": "Sesión olvidada en mi-proyecto", "resolve": true }
```

**El `title` es idéntico al de la emisión, y tiene que serlo.** Si tu receptor deduplica
o cierra por el título, un texto distinto cerraría otra cosa, o nada.

Si no te interesa cerrar nada, ignora los mensajes con `resolve: true` y ya está.

## No te va a inundar

Dos mecanismos, y los dos existen por haber fallado antes:

**Filtro de 6 h.** El mismo `event_type` sobre la misma sesión no se repite en 6 h. La
memoria vive en `~/.local/state/warroom/avisos-emitidos.json` y **sobrevive al reinicio**
del servicio, que es lo importante: cuando no lo hacía, un servicio que se reiniciaba
solo empezaba de cero cada vez.

**"No lo sé" no es "no".** Si `git` no contesta (timeout, un `index.lock` de otra sesión),
la condición queda en indeterminado y no se emite ni se cierra nada. Sin esto, git tardaba
un segundo de más, el aviso se daba por resuelto, se borraba la memoria, y al segundo
siguiente se emitía otra vez desde cero. Medido: **2.140 repeticiones del mismo aviso en
890 minutos**, con el hecho siendo cierto todo el rato. Lo roto era repetirlo.

## Un receptor mínimo que funciona

Antes de montar nada: el War Room ya corre en tu escritorio, así que el aviso más útil
suele ser el más tonto, **una notificación del sistema**. Sin cuenta, sin token, sin
internet y sin depender de que ningún servicio siga existiendo el año que viene.

Node, sin dependencias, en local:

```js
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const CLAVE = process.env.MI_CLAVE;

createServer((req, res) => {
  if (req.method !== 'POST' || req.headers['x-admin-key'] !== CLAVE) {
    res.writeHead(401).end(); return;
  }
  let cuerpo = '';
  req.on('data', (t) => { cuerpo += t; });
  req.on('end', () => {
    res.writeHead(200).end('ok');            // contesta rápido, siempre
    const e = JSON.parse(cuerpo);
    if (e.resolve) return;                   // aquí no nos interesan los cierres
    execFile('notify-send', [e.title, e.message]);   // Linux
  });
}).listen(8080, '127.0.0.1');
```

```ini
WARROOM_ALERTAS=1
WARROOM_ALERT_URL=http://127.0.0.1:8080
WARROOM_ALERT_KEY=lo-que-sea-si-solo-escucha-en-local
```

En macOS, cambia esa línea por `osascript -e 'display notification …'`. En Windows, por un
`New-BurntToastNotification` o un `msg`.

Para probar sin esperar tres horas, baja `UMBRAL.olvidada` en `server.mjs` a unos
segundos y reinicia.

**Solo salta al móvil si de verdad lo necesitas.** Si quieres el aviso fuera del
ordenador, cambia esa única línea por una llamada a lo que ya uses: un webhook de Slack o
Discord, un bot de Telegram, [ntfy](https://ntfy.sh). El resto del receptor no cambia.
Pero hazlo cuando lo eches en falta, no antes: montar infraestructura para avisarte de que
tienes una sesión parada es bastante más caro que la sesión parada.

## Montarte el tuyo con Claude

Si el de arriba no te encaja, este documento **es** la especificación del contrato, así
que lo más rápido es dársela a Claude Code y pedirle el receptor que te sirva:

> Lee `docs/ALERTAS.md` del War Room. Escríbeme un receptor que valide la cabecera
> `x-admin-key`, conteste 200 rápido y me avise por <tu destino>. Que los mensajes con
> `resolve: true` <cierren el aviso anterior / se ignoren>, y que no se caiga si el
> destino falla.

Dos cosas que conviene pedirle explícitamente porque son las que se olvidan: **contestar
antes de reenviar** (si tardas, el aviso se pierde) y **decidir qué haces con los cierres**.
Si tu destino sabe editar o borrar mensajes, aprovéchalos y el canal se limpia solo; si no,
ignóralos y no pasa nada.

## Qué NO hace

El panel **observa, no actúa**. No cierra sesiones, no hace commits, no toca tu código y
no escribe en `~/.claude`. Un aviso es un aviso: quien decide qué hacer eres tú.
