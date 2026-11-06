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

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo
echo "Установлено. Панель: http://127.0.0.1:8765"
echo "Команда: $BIN/calbackup  (добавьте $BIN в PATH, если его там нет)"
echo "Настройки: $HOME_DIR/config.json — дальше по README, раздел «Подключение источников»."
