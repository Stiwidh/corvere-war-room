#!/usr/bin/env bash
# Instala el War Room como servicio de usuario: arranca solo al iniciar sesión
# y se reinicia si se cae. Idempotente, se puede repetir sin miedo.
#
# El unit se GENERA aquí con la ruta real de esta copia. No se enlaza el del
# repositorio: llevaría dentro el directorio de quien lo escribió.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO="$HOME/.config/systemd/user"
UNIT="$DESTINO/warroom.service"
CONF="$HOME/.config/warroom/env"

# ── requisitos ──────────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "Hace falta Node 20 o más nuevo." >&2; exit 1; }
MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAYOR" -ge 20 ] || { echo "Node $MAYOR es demasiado viejo, hace falta 20+." >&2; exit 1; }

if [ "$(uname -s)" != "Linux" ]; then
  echo "Esto instala un servicio de systemd, que es cosa de Linux."
  echo "En $(uname -s) arráncalo a mano:  npm run warroom"
  exit 1
fi
command -v systemctl >/dev/null || {
  echo "No hay systemd aquí. Arráncalo a mano:  npm run warroom" >&2; exit 1; }

# ── configuración, fuera del repositorio ────────────────────────────────────
if [ ! -f "$CONF" ]; then
  mkdir -p "$(dirname "$CONF")"
  cat > "$CONF" <<'PLANTILLA'
# Configuración del War Room. Este fichero NO va en el repositorio.
# Los avisos son opcionales y están apagados salvo que los enciendas.
#WARROOM_ALERTAS=1
#WARROOM_ALERT_URL=https://ejemplo/mi-endpoint
#WARROOM_ALERT_KEY=
PLANTILLA
  chmod 600 "$CONF"
  echo "Creada la configuración en $CONF"
fi

# ── unit generado con la ruta real ──────────────────────────────────────────
mkdir -p "$DESTINO"
# si venía de una instalación por symlink, se sustituye por un fichero de verdad
# (sin `&&`: con `set -e` un test en falso abortaría el script)
if [ -L "$UNIT" ]; then rm -f "$UNIT"; fi
sed "s|__DIR__|$AQUI|g" "$AQUI/warroom.service.in" > "$UNIT"

systemctl --user daemon-reload
systemctl --user enable --now warroom.service
systemctl --user restart warroom.service

# ── la ventana, que se abre sola al iniciar sesión ──────────────────────────
#
# IMPACT-OK: bloque nuevo al final del script, no toca ninguna línea existente.
# Nadie importa este fichero: lo ejecuta una persona a mano. Verificado contra las
# DOS instalaciones reales, no contra el repo: en Linux el unit lleva 24 h activo
# y el autostart existía a mano en `~/.config/autostart/warroom.desktop` sin estar
# en el repositorio; en el Windows de referencia la pieza equivalente
# (`warroom-inicio.vbs` en la carpeta de Inicio) también estaba solo en la máquina.
# Esto porta la de Linux; la de Windows va en `windows/instalar.ps1`.
#
# El unit de arriba mantiene vivo el SERVIDOR; esto abre la VENTANA. Son dos
# cosas distintas y por eso van por caminos distintos: systemd no tiene sesión
# gráfica, así que la ventana la lanza el autostart del escritorio.
#
# El retardo de 10 s no es adorno: `abrir.sh` consulta xrandr y el área útil, y
# al iniciar sesión el escritorio todavía está colocando paneles y monitores.
#
# Para quitar la ventana automática sin desmontar el panel:
#   rm ~/.config/autostart/warroom.desktop
AUTOSTART="$HOME/.config/autostart"
mkdir -p "$AUTOSTART"
cat > "$AUTOSTART/warroom.desktop" <<ESCRITORIO
[Desktop Entry]
Type=Application
Name=War Room
Comment=Panel en vivo de la flota de agentes de Claude Code
Exec=$AQUI/abrir.sh
Icon=utilities-system-monitor
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=10
ESCRITORIO

sleep 2
if systemctl --user is-active --quiet warroom.service; then
  echo "War Room activo en http://127.0.0.1:7777"
  echo
  echo "Arranca con el sistema, no con Claude Code: el panel sigue vivo aunque"
  echo "no tengas ninguna sesión abierta, y la ventana se abre sola al entrar."
  echo
  echo "Abrir la ventana ya:  ./abrir.sh          (o ./abrir.sh derecha)"
  echo "Ver el log:           journalctl --user -u warroom -f"
  echo "Pararlo:              systemctl --user stop warroom"
  echo "Quitar la ventana:    rm ~/.config/autostart/warroom.desktop"
else
  echo "No ha arrancado. Mira el log:" >&2
  systemctl --user status warroom.service --no-pager || true
  exit 1
fi
