# War Room en Windows

Verificado en un Windows 11 real contra la app de escritorio de Claude Code, no deducido
de la documentación. Los transcripts viven en `%USERPROFILE%\.claude\projects\` con la
misma estructura que en Linux, subagentes incluidos, así que el panel los lee sin cambiar
una línea.

## Instalar

```powershell
powershell -ExecutionPolicy Bypass -File windows\instalar.ps1
```

Deja dos cosas montadas, que son distintas y conviene no confundir:

| | Qué mantiene | Cómo |
|---|---|---|
| **El servidor** | Que el panel esté vivo | Tarea programada `WarRoom` |
| **La ventana** | Que se abra sola al entrar | `warroom-inicio.vbs` en la carpeta de Inicio |

**Arranca con el sistema, no con Claude Code.** El panel sigue vivo aunque no tengas
ninguna sesión abierta, y eso es justo lo que le permite avisarte de que hay una
esperándote desde hace tres horas.

Para arrancarlo sin cerrar sesión: `Start-ScheduledTask -TaskName WarRoom`.

## Sin instalar Node: la vía portable

Si no quieres tocar la máquina, no hace falta instalar Node. Descarga el zip de Windows
x64 de [nodejs.org](https://nodejs.org/en/download) y descomprímelo **al lado del
repositorio**, dejando la carpeta `node-v22.x.x-win-x64` tal cual. `arrancar.cmd` la
encuentra sola y la usa antes que cualquier Node del sistema.

Es lo que corre en la máquina de referencia: cero cambios en el PATH del usuario y cero
permisos de administrador.

## Comprobar que está bien

```powershell
powershell -ExecutionPolicy Bypass -File windows\estado.ps1
```

Responde por orden a las preguntas que importan: existe la tarea, la acción es la
correcta, cómo acabó la última ejecución, hay procesos `node`, alguien escucha en el
puerto, está la ventana en el inicio, y contesta el panel.

## Las cuatro trampas, todas medidas en una máquina real

### 1. La ventana negra cada cinco minutos

**Síntoma:** una consola negra que aparece sola cada poco, y que sigue apareciendo después
de cerrar el War Room.

Ese último detalle es la pista: cerrarla era exactamente lo que la traía de vuelta. La
tarea corre con `LogonType InteractiveToken`, así que poner `arrancar.cmd` como acción
abre una consola **visible**. Al cerrarla muere el servidor (la tarea acaba con
`0xC000013A`, salida por cierre de consola), la tarea se marca caída, y el latido de los
cinco minutos abre otra. Bucle perpetuo, con el panel muerto todo el rato.

**Por eso la acción de la tarea apunta a `wscript.exe arrancar-oculto.vbs` y nunca al
`.cmd`.** El `0` del `Run` de ese VBS es lo único que separa una cosa de la otra. Si
tocas la tarea a mano, respétalo: `estado.ps1` te avisa si la acción deja de ser correcta.

### 2. La tarea que no arranca, o que muere a los tres días

`schtasks` nace con tres ajustes que matan un servicio, y `instalar.ps1` los desactiva:

- **No arrancar con batería.** En un portátil, eso es la mitad del tiempo.
- **Parar al pasar a batería.** Desenchufas y se apaga.
- **Límite de ejecución de 72 h.** A los tres días, muerto sin explicación.

Además, `MultipleInstances: IgnoreNew` es lo que permite que el latido de cinco minutos
sea inofensivo: si el panel ya vive, el disparo no hace nada; si se cayó, lo levanta.

### 3. Los procesos de git parpadeando

Si ves ventanas que aparecen y desaparecen sin parar, es `git` sin `windowsHide`. El panel
lanza cuatro procesos git por repositorio cada 20 segundos, y sin esa opción cada uno abre
su ventana. Ya está corregido en `server.mjs`; si tocas ahí, mantenlo.

### 4. `spawn EINVAL` al detectar sesiones

Node se niega a lanzar un `.cmd` sin shell desde CVE-2024-27980, y lo lanza como
**excepción**, no por callback. Al llamar a `claude.cmd` eso tumbaba el barrido entero y
dejaba el panel en cero sesiones. Ya está resuelto; se menciona porque el síntoma (panel
vacío, sin errores visibles) no apunta en absoluto a su causa.

## Qué se puede saber de la app de escritorio

Poco, y basta. La app **no abre un proceso por sesión**: es una sola aplicación Electron
con más de una docena de procesos, ninguno con el directorio de trabajo de una sesión
concreta. `sessions\` y `session-env\<uuid>\` están vacíos. Y `claude agents --json`, con
la app abierta y seis sesiones vivas, **devuelve una lista vacía**: el CLI y la app no se
ven entre ellos.

Lo único que se puede saber es si la app está corriendo, y resulta que es justo lo que
hace falta: una sesión del sidebar no muere al cerrar una terminal, vive mientras viva la
app. Así que mientras corra, ninguna de sus sesiones se marca como cerrada, y el panel lo
dice en la barra en vez de callárselo.

Con el **CLI** instalado la detección es exacta, vía `claude agents --json`.

## WSL2

Funciona, con una condición que es el error más fácil de cometer: Claude Code tiene que
correr **también dentro de WSL**. Son kernels distintos, así que desde WSL no se ven los
procesos de Windows. Si tu Claude Code corre en Windows y el panel en WSL, leerás los
transcripts pero todas las sesiones saldrán como cerradas.

## Si algo no cuadra en tu máquina

Aquí no hay nada que construir: el instalador viene hecho. Pero Windows tiene muchas
variantes (sin Edge ni Chrome, con políticas de empresa que bloquean tareas, con otro
gestor de arranque), y este documento explica **por qué** cada pieza es como es.

Si te toca adaptarlo, dale a Claude Code este fichero junto con la salida de
`estado.ps1`, que es justo el diagnóstico que hace falta para saber dónde se rompe la
cadena. Lo único que conviene decirle que no toque es la regla de la trampa 1: **la acción
de la tarea apunta a `wscript.exe` y a un `.vbs`, nunca a un `.cmd`.** Ese es el detalle
que parece un rodeo y no lo es.

## Desinstalar

```powershell
Unregister-ScheduledTask -TaskName WarRoom -Confirm:$false
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\warroom-inicio.vbs"
```

Para quitar solo la ventana automática y dejar el panel corriendo, borra únicamente el
segundo.
