@echo off
REM Abre la ventana del War Room cuando el panel YA responde.
REM
REM Espera hasta 2 minutos a proposito: al arrancar hay que leer los
REM transcripts, que son de decenas de megas, asi que el servidor tarda en
REM escuchar. Sin la espera, la ventana se abre sobre un "no se puede acceder
REM a este sitio" y parece que el panel no funciona.
REM
REM Lo lanza warroom-inicio.vbs desde la carpeta de Inicio, para que no salga
REM consola. A mano tambien vale: windows\abrir.cmd

if "%WARROOM_PORT%"=="" set "WARROOM_PORT=7777"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u='http://127.0.0.1:%WARROOM_PORT%';" ^
  "for($i=0; $i -lt 60; $i++){ try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 2 } };" ^
  "$navegador = if (Get-Command msedge -EA 0) { 'msedge' } elseif (Get-Command chrome -EA 0) { 'chrome' } else { $null };" ^
  "if ($navegador) { Start-Process $navegador -ArgumentList ('--app=' + $u),'--window-size=1600,1000' } else { Start-Process $u }"
