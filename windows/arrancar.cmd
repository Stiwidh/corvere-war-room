@echo off
REM Arranca el servidor del War Room. Lo llama la tarea programada a traves de
REM arrancar-oculto.vbs, nunca directamente (ver ese fichero para el porque).
REM
REM %~dp0 es el directorio de este .cmd con la barra final, asi que ..\ es la
REM raiz del repositorio, que es donde vive server.mjs.

cd /d "%~dp0.."

REM Node portable primero, si alguien lo dejo junto al repositorio. Evita tener
REM que instalar Node en la maquina: se descomprime el zip oficial de nodejs.org
REM al lado del repo y funciona sin tocar el sistema ni el PATH del usuario.
for /d %%N in ("%~dp0..\node-v*-win-x64") do set "NODEDIR=%%~fN"

if defined NODEDIR (
  set "PATH=%NODEDIR%;%PATH%"
  "%NODEDIR%\node.exe" server.mjs
) else (
  node server.mjs
)
