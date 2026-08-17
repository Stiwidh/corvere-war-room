# Instala el War Room en Windows para que arranque solo al iniciar sesion y NO
# se caiga. Idempotente: se puede repetir sin miedo.
#
#   powershell -ExecutionPolicy Bypass -File windows\instalar.ps1
#
# Deja tres cosas montadas:
#   1. La tarea programada \WarRoom, que mantiene vivo el SERVIDOR.
#   2. warroom-inicio.vbs en la carpeta de Inicio, que abre la VENTANA.
#   3. Nada mas. No instala dependencias porque el panel no tiene ninguna.
#
# Arranca con el SISTEMA, no con Claude Code: el panel esta vivo aunque no
# tengas ninguna sesion abierta, que es justo lo que le permite avisarte de que
# hay uno esperandote desde hace tres horas.

$ErrorActionPreference = 'Stop'

$aqui = $PSScriptRoot                      # ...\windows
$raiz = Split-Path $aqui -Parent           # raiz del repositorio

# ── requisitos ───────────────────────────────────────────────────────────────
# Node portable junto al repositorio, o Node instalado en el sistema. El
# portable evita tocar la maquina: se descomprime el zip oficial de nodejs.org
# al lado del repo y arrancar.cmd lo encuentra solo.
$portable = Get-ChildItem -Path $raiz -Directory -Filter 'node-v*-win-x64' -EA 0 | Select-Object -First 1
$delSistema = Get-Command node -EA 0

if (-not $portable -and -not $delSistema) {
  Write-Error @"
No hay Node. Dos opciones:
  a) Instalarlo:  https://nodejs.org  (hace falta 20.11 o mas nuevo)
  b) Portable, sin instalar nada: descarga el zip de Windows x64 de
     https://nodejs.org/en/download y descomprimelo AL LADO de este
     repositorio, dejando la carpeta node-v22.x.x-win-x64 tal cual.
"@
}

# 20.11 y no 20 a secas: `import.meta.dirname`, que el servidor usa para localizar
# `public/`, llego en 20.11.0 y 21.2.0. Con un 20.5 el panel arranca y falla con un
# TypeError que no dice nada. Mirar solo la major dejaba pasar justo ese caso.
if ($delSistema -and -not $portable) {
  $v = (node -p 'process.versions.node') 2>$null
  if ($v) {
    $p = $v.Split('.')
    $mayor = [int]$p[0]; $menor = [int]$p[1]
    $ok = ($mayor -gt 21) -or ($mayor -eq 21 -and $menor -ge 2) -or ($mayor -eq 20 -and $menor -ge 11)
    if (-not $ok) {
      Write-Error "Node $v es demasiado viejo, hace falta 20.11 o mas nuevo (o 21.2+)."
    }
  }
}

# ── la tarea, que mantiene vivo el servidor ──────────────────────────────────
# Dos disparadores a proposito:
#   - al iniciar sesion, para tenerlo desde el primer minuto
#   - cada 5 minutos como latido. Con MultipleInstances=IgnoreNew, si el panel
#     ya esta vivo el disparo no hace nada; si se cayo, lo levanta. Es lo que
#     convierte esto en algo que se queda, en vez de algo que hay que arrancar.
#
# 🚨 La accion apunta a arrancar-oculto.vbs y NUNCA a arrancar.cmd. La tarea
# corre con token interactivo: un .cmd como accion abre una consola visible,
# cerrarla mata el servidor y el latido abre otra cinco minutos despues. Bucle
# perpetuo con el panel muerto. Medido en una maquina real (2026-08-05).
$accion = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "`"$aqui\arrancar-oculto.vbs`""

$alEntrar = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
$latido = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)

# Los tres ajustes con los que schtasks nace y que matan un servicio: no
# arrancar a bateria (en un portatil, la mitad del tiempo), pararlo al pasar a
# bateria, y un limite de ejecucion de 72 h.
$ajustes = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

Register-ScheduledTask -TaskName 'WarRoom' -Action $accion `
  -Trigger @($alEntrar, $latido) -Settings $ajustes `
  -Description 'Panel en vivo de la flota de agentes de Claude Code' -Force | Out-Null

# ── la ventana, que se abre sola al iniciar sesion ───────────────────────────
$inicio = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
Copy-Item (Join-Path $aqui 'warroom-inicio.vbs') $inicio -Force

# ── comprobacion ─────────────────────────────────────────────────────────────
$t = Get-ScheduledTask -TaskName 'WarRoom'
$puerto = if ($env:WARROOM_PORT) { $env:WARROOM_PORT } else { '7777' }

Write-Output 'tarea WarRoom registrada'
Write-Output ('  node                : ' + $(if ($portable) { $portable.Name + ' (portable)' } else { 'del sistema' }))
Write-Output ('  disparadores        : ' + $t.Triggers.Count + ' (inicio de sesion + latido de 5 min)')
Write-Output ('  accion              : ' + $t.Actions[0].Execute + ' (tiene que ser wscript.exe)')
Write-Output ('  bateria no la frena : ' + (-not $t.Settings.DisallowStartIfOnBatteries))
Write-Output ('  sin limite de tiempo: ' + ($t.Settings.ExecutionTimeLimit -eq 'PT0S'))
Write-Output ('  instancias          : ' + $t.Settings.MultipleInstances)
Write-Output ('  ventana al inicio   : ' + (Test-Path (Join-Path $inicio 'warroom-inicio.vbs')))
Write-Output ''
Write-Output "War Room en http://127.0.0.1:$puerto"
Write-Output '  Arrancarlo ya sin reiniciar sesion:  Start-ScheduledTask -TaskName WarRoom'
Write-Output '  Ver como esta:                       powershell -File windows\estado.ps1'
