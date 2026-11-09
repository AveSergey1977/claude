#!/bin/bash
# Installs Calendar Backup on a Linux server (Debian/Ubuntu, or Fedora/RHEL family) as a
# systemd service running under its own system user. Run as root:  sudo ./install-linux.sh
# Re-running updates the program and keeps config, tokens, secrets, history and backups.
set -euo pipefail

SVC_USER="calbackup"
UNIT="calendar-backup"
SRC="$(cd "$(dirname "$0")" && pwd)"
OPT="/opt/calendar-backup"
APP="$OPT/app"
VENV="$OPT/venv"
DATA="/var/lib/calendar-backup"
WRAPPER="/usr/local/bin/calbackup"

[ "$(uname)" = "Linux" ] || { echo "Скрипт для Linux-сервера; на Mac используйте install-macos.sh"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo $0"; exit 1; }

if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 python3-venv python3-pip curl ca-certificates >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q python3 python3-pip curl ca-certificates >/dev/null
else
  echo "Неизвестный пакетный менеджер. Установите вручную python3 (3.9+, с модулем venv) и curl, затем повторите."
  command -v python3 >/dev/null || exit 1
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
  || { echo "Нужен Python 3.9+, найден: $(python3 -V)"; exit 1; }

id -u "$SVC_USER" >/dev/null 2>&1 || \
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA"
install -d -m 755 "$OPT"

rm -rf "$APP"
install -d -m 755 "$APP"
cp -R "$SRC/calbackup" "$SRC/config.server.example.json" "$SRC/config.example.json" "$SRC/requirements.txt" "$APP/"
find "$APP" -name __pycache__ -prune -exec rm -rf {} +
chmod -R a+rX,go-w "$APP"

[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$APP/requirements.txt"
chmod -R a+rX,go-w "$VENV"

cat > "$WRAPPER" <<EOF
#!/bin/bash
# Runs calbackup as the service user, so its files keep the right owner and mode.
export CALBACKUP_HOME="$DATA" PYTHONPATH="$APP"
cd "$APP"
if [ "\$(id -un)" = "$SVC_USER" ]; then
  exec "$VENV/bin/python" -m calbackup "\$@"
fi
if [ "\$(id -u)" = 0 ]; then  # root: runuser is always present (sudo may be absent on minimal images)
  exec runuser -u "$SVC_USER" -- env CALBACKUP_HOME="$DATA" PYTHONPATH="$APP" "$VENV/bin/python" -m calbackup "\$@"
fi
exec sudo -u "$SVC_USER" CALBACKUP_HOME="$DATA" PYTHONPATH="$APP" "$VENV/bin/python" -m calbackup "\$@"
EOF
chmod 755 "$WRAPPER"

[ -f "$DATA/config.json" ] || "$WRAPPER" init --server

cat > "/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=Calendar Backup (calendars to Google Drive)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
Environment=CALBACKUP_HOME=$DATA
Environment=PYTHONPATH=$APP
WorkingDirectory=$APP
ExecStart=$VENV/bin/python -m calbackup serve
Restart=always
RestartSec=30
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF

if [ "${SKIP_SYSTEMD:-}" = 1 ]; then
  echo "SKIP_SYSTEMD=1: служба не запускалась"
  exit 0
fi
systemctl daemon-reload
systemctl enable --quiet "$UNIT"
systemctl restart "$UNIT"

PORT="$("$VENV/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("panel_port", 8765))' "$DATA/config.json" 2>/dev/null || echo 8765)"
up=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/status"; then up=1; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "Служба не отвечает. Диагностика:"
  "$WRAPPER" doctor || true
  journalctl -u "$UNIT" -n 30 --no-pager || true
  exit 1
fi

echo
echo "Установлено. Служба: $UNIT (systemctl status $UNIT), данные: $DATA"
echo "Панель на сервере доступна только локально. С Mac: ssh -N -L 8766:127.0.0.1:$PORT <пользователь>@<сервер>,"
echo "затем откройте http://127.0.0.1:8766"
echo "Дальше: передать токен Google с Mac (README, раздел «Сервер»)."
