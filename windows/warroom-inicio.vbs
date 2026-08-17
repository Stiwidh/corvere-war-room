' Lanza abrir.cmd SIN ventana de consola. Va en la carpeta de Inicio del
' usuario, asi que se ejecuta solo al iniciar sesion.
'
' El 0 del Run evita que aparezca una consola negra durante los hasta dos
' minutos que abrir.cmd puede pasar esperando a que el servidor escuche.
'
' Lo copia ahi instalar.ps1. Para quitar la ventana automatica sin desmontar
' el panel, basta con borrar este fichero de la carpeta de Inicio:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\warroom-inicio.vbs

CreateObject("Wscript.Shell").Run "cmd /c """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\abrir.cmd""", 0, False
