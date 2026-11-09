#!/bin/bash
# Installs Calendar Backup as a per-user LaunchAgent (starts at login, restarts on failure).
# Re-running the script updates the installation and keeps config, tokens and history.
set -euo pipefail

LABEL="com.calendar-backup.agent"
SRC="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/Library/Application Support/CalendarBackup"
APP="$HOME_DIR/app"
VENV="$HOME_DIR/venv"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HOME/.local/bin"

[ "$(uname)" = "Darwin" ] || { echo "Скрипт предназначен для macOS"; exit 1; }

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [ -x "$c" ] && { PY="$c"; break; }
  done
fi
[ -n "$PY" ] || { echo "Не найден python3. Установите: xcode-select --install или brew install python"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
  || { echo "Нужен Python 3.9+, найден: $("$PY" -V)"; exit 1; }
echo "Python: $PY ($("$PY" -V))"

mkdir -p "$HOME_DIR" "$BIN" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME_DIR"
rm -rf "$APP"
mkdir -p "$APP"
cp -R "$SRC/calbackup" "$SRC/config.example.json" "$SRC/requirements.txt" "$APP/"

[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$APP/requirements.txt"

cat > "$BIN/calbackup" <<EOF
#!/bin/bash
cd "$APP" && exec "$VENV/bin/python" -m calbackup "\$@"
EOF
chmod +x "$BIN/calbackup"

"$BIN/calbackup" init

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/python</string><string>-m</string><string>calbackup</string><string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/launchd.err.log</string>
</dict>
</plist>
EOF

# Restart the agent. bootout is asynchronous: an immediate bootstrap fails with
# "Bootstrap failed: 5: Input/output error", so wait for the old job to go away and retry.
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 1 30); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true  # a disabled job refuses bootstrap
loaded=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then loaded=1; break; fi
  sleep 2
done
if [ "$loaded" != 1 ] && ! launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null; then
  echo "Не удалось запустить службу $LABEL. Повторите: ./install-macos.sh"
  exit 1
fi

PORT="$("$VENV/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("panel_port", 8765))' "$HOME_DIR/config.json" 2>/dev/null || echo 8765)"
up=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then up=1; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "Служба запущена, но панель не отвечает. Диагностика:"
  "$BIN/calbackup" doctor || true
  exit 1
fi

echo
echo "Установлено. Панель: http://127.0.0.1:$PORT"
echo "Команда: $BIN/calbackup  (добавьте $BIN в PATH, если его там нет)"
echo "Настройки: $HOME_DIR/config.json — дальше по README, раздел «Подключение источников»."
