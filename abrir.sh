#!/usr/bin/env bash
# Abre el War Room en el monitor que le digas, con su propia instancia de Chrome.
#
#   ./abrir.sh                 → ventana encajada en el monitor de la IZQUIERDA
#   ./abrir.sh derecha         → en el de la derecha
#   ./abrir.sh centro          → en el del portátil
#   ./abrir.sh izquierda full  → modo kiosco, sin marco (se sale con Alt+F4)
#
# La ventana se ajusta al área ÚTIL del monitor, no a su borde físico: en el
# monitor izquierdo el dock de Ubuntu se come los primeros 71 px, y una ventana
# pegada a x=0 queda medio tapada por él.
#
# Usa un perfil aparte a propósito: si se lanza con el perfil normal y ya tienes
# Chrome abierto, la instancia existente se queda con la petición y IGNORA
# --window-position y --window-size, así que la ventana sale donde le apetece.
set -euo pipefail

DONDE="${1:-izquierda}"
MODO="${2:-app}"
URL="${WARROOM_URL:-http://127.0.0.1:7777}"
PERFIL="$HOME/.config/warroom-chrome"

NAVEGADOR="$(command -v google-chrome || command -v chromium || command -v brave-browser || true)"
[ -n "$NAVEGADOR" ] || { echo "No encuentro Chrome ni Chromium." >&2; exit 1; }

# Geometría real de cada monitor: "ancho alto x y nombre", ordenados de izquierda a derecha
MONITORES="$(xrandr --listmonitors | awk 'NR>1{
  split($3, a, "+"); split(a[1], b, "x"); split(b[1], c, "/"); split(b[2], d, "/");
  print c[1], d[1], a[2], a[3], $4
}' | sort -k3 -n)"

case "$DONDE" in
  izquierda|left)   LINEA="$(echo "$MONITORES" | head -1)" ;;
  derecha|right)    LINEA="$(echo "$MONITORES" | tail -1)" ;;
  centro|portatil)  LINEA="$(echo "$MONITORES" | sed -n '2p')" ;;
  *) echo "Monitor desconocido: $DONDE (usa izquierda, centro o derecha)" >&2; exit 1 ;;
esac
[ -n "$LINEA" ] || { echo "No he podido leer la geometría de los monitores." >&2; exit 1; }

read -r W H X Y NOMBRE <<< "$LINEA"

# Recortar contra el área útil (_NET_WORKAREA): descuenta el dock lateral y la
# barra superior de GNOME. Sin esto, en el monitor izquierdo el dock tapa los
# primeros 71 px de la ventana.
AREA="$(xprop -root _NET_WORKAREA 2>/dev/null | grep -o '[0-9]\+' | head -4 | tr '\n' ' ')"
if [ -n "$AREA" ]; then
  read -r AX AY AW AH <<< "$AREA"
  read -r X Y W H <<< "$(awk -v x="$X" -v y="$Y" -v w="$W" -v h="$H" \
    -v ax="$AX" -v ay="$AY" -v aw="$AW" -v ah="$AH" 'BEGIN{
      nx = (x > ax ? x : ax); ny = (y > ay ? y : ay);
      x2 = x + w; y2 = y + h; ax2 = ax + aw; ay2 = ay + ah;
      if (x2 > ax2) x2 = ax2; if (y2 > ay2) y2 = ay2;
      printf "%d %d %d %d", nx, ny, x2 - nx, y2 - ny }')"
fi

# Chrome interpreta --window-size en píxeles LÓGICOS y los multiplica por el
# factor de escala del escritorio (Xft.dpi / 96). Con Xft.dpi=120 pedir 1920
# crea una ventana de 2400 y el gestor la empuja fuera del monitor. Hay que
# pedir el tamaño ya dividido. El marco de la ventana se descuenta aparte.
DPI="$(xrdb -query 2>/dev/null | awk '/Xft.dpi/{print $2}')"
ESCALA="$(awk -v d="${DPI:-96}" 'BEGIN{ e=d/96; if (e<=0) e=1; printf "%.4f", e }')"
# La posición se escala igual que el tamaño: pedir x=3840 con escala 1,25 manda
# la ventana a 4800, que se sale del escritorio, y el gestor la reubica en la
# esquina del monitor izquierdo. También hay que dividirla.
MARCO=30
read -r WL HL XL YL <<< "$(awk -v w="$W" -v h="$H" -v x="$X" -v y="$Y" -v m="$MARCO" -v e="$ESCALA" \
  'BEGIN{ printf "%d %d %d %d", int(w/e), int((h-m)/e), int(x/e+0.999), int(y/e+0.999) }')"

# En el arranque de sesión esto se lanza antes de que el servicio esté listo, así
# que se espera en vez de fallar a la primera.
ESPERA=0
until curl -sf -o /dev/null --max-time 2 "$URL"; do
  ESPERA=$((ESPERA + 1))
  if [ "$ESPERA" -gt 20 ]; then
    echo "El servidor no responde en $URL tras 20 intentos." >&2
    echo "Míralo con:  systemctl --user status warroom" >&2
    exit 1
  fi
  sleep 1
done

echo "Abriendo en $NOMBRE (${W}x${H} en +${X}+${Y}) · escala ${ESCALA} → pido ${WL}x${HL} en +${XL}+${YL}"

# La posición elige el monitor; maximizar deja que el gestor encaje la ventana
# exacta. Si fijamos el tamaño a mano, el marco (14 px por lado) sobresale y la
# ventana asoma en el monitor de al lado.
ARGS=(--user-data-dir="$PERFIL" --no-first-run --no-default-browser-check
      --window-position="${XL},${YL}" --window-size="${WL},${HL}")
# --start-fullscreen se ignora cuando va junto a --app; el que sí funciona es --kiosk
[ "$MODO" = "full" ] && ARGS+=(--kiosk)

exec "$NAVEGADOR" "${ARGS[@]}" --app="$URL" >/dev/null 2>&1
