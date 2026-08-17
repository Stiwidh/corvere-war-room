' Arranca el War Room SIN ventana de consola. Es la accion de la tarea
' programada \WarRoom, que dispara al iniciar sesion y cada 5 minutos.
'
' El 0 del Run es lo unico que separa "panel que vive en segundo plano" de
' "ventana negra que aparece sola cada cinco minutos". La tarea corre con token
' interactivo, asi que poner el .cmd como accion abre una consola VISIBLE en
' mitad de la pantalla. Y como cerrar esa consola mata el servidor, el latido
' de los 5 minutos abria otra, para siempre, con el panel muerto todo el rato.
'
' Medido en una maquina real: la tarea acababa con 0xC000013A (salida por
' cierre de consola) y la usuaria veia una ventana negra cada cinco minutos.
' Si cambias la accion de la tarea, que apunte SIEMPRE a este .vbs.

CreateObject("Wscript.Shell").Run "cmd /c """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\arrancar.cmd""", 0, False
