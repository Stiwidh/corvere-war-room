# Comprueba de un vistazo que el War Room esta montado y vivo.
#
#   powershell -ExecutionPolicy Bypass -File windows\estado.ps1
#
# Cada linea responde a una pregunta distinta, y se leen en orden: si la tarea
# no existe no hay nada montado; si existe pero no escucha en el puerto, el
# servidor se cae al arrancar; si escucha pero no responde, acaba de arrancar.

$puerto = if ($env:WARROOM_PORT) { $env:WARROOM_PORT } else { 7777 }
$inicio = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\warroom-inicio.vbs'

$tarea = Get-ScheduledTask -TaskName 'WarRoom' -ErrorAction SilentlyContinue
$info = Get-ScheduledTaskInfo -TaskName 'WarRoom' -ErrorAction SilentlyContinue
$escucha = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue
$nodos = @(Get-Process node -ErrorAction SilentlyContinue)

Write-Output ('tarea WarRoom     : ' + $(if ($tarea) { $tarea.State } else { 'NO EXISTE, corre windows\instalar.ps1' }))

if ($tarea) {
  # La accion tiene que ser wscript.exe. Si aqui pone cmd, vuelve la ventana
  # negra cada cinco minutos: reinstala con windows\instalar.ps1.
  $ejec = $tarea.Actions[0].Execute
  $ok = $ejec -match 'wscript'
  Write-Output ('  accion          : ' + $ejec + $(if ($ok) { ' (correcto)' } else { '  <-- MAL, tiene que ser wscript.exe' }))
}

if ($info) {
  Write-Output ('  ultimo resultado: ' + $info.LastTaskResult + $(if ($info.LastTaskResult -eq 0) { ' (bien)' } else { ' (algo fallo)' }))
  Write-Output ('  ultima ejecucion: ' + $info.LastRunTime)
}

Write-Output ('procesos node     : ' + $nodos.Count)
Write-Output ("escuchando en $puerto" + ': ' + [bool]$escucha)
Write-Output ('ventana al inicio : ' + (Test-Path $inicio))

try {
  $r = Invoke-RestMethod "http://127.0.0.1:$puerto/api/state" -TimeoutSec 5
  Write-Output ('panel             : responde, ' + $r.sessions.Count + ' sesiones')
  if ($r.avisoCorto) { Write-Output ('aviso             : ' + $r.avisoCorto) }
} catch {
  Write-Output 'panel             : NO responde (si acaba de arrancar, dale un minuto)'
}
