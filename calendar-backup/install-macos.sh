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

# restic for the second copy: Homebrew's if present, otherwise the pinned official release,
# checked against the SHA256SUMS file of that release. A failure here does not stop the
# installation: only the second copy needs restic.
RESTIC_VERSION="0.19.1"
install_restic() {
  if [ -x /opt/homebrew/bin/restic ] || [ -x /usr/local/bin/restic ]; then
    echo "restic: используется Homebrew"; return 0
  fi
  if [ -x "$HOME_DIR/bin/restic" ] && "$HOME_DIR/bin/restic" version 2>/dev/null | grep -q "restic $RESTIC_VERSION "; then
    echo "restic $RESTIC_VERSION уже установлен"; return 0
  fi
  local arch; case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=amd64 ;; *) echo "restic: неизвестная архитектура"; return 1 ;; esac
  local name="restic_${RESTIC_VERSION}_darwin_${arch}.bz2"
  local url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/$name" "$url/$name" && curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$url/SHA256SUMS" \
    || { rm -rf "$tmp"; echo "restic: загрузка не удалась"; return 1; }
  local want got
  want="$(awk -v n="$name" '$2 == n {print $1}' "$tmp/SHA256SUMS")"
  got="$(shasum -a 256 "$tmp/$name" | awk '{print $1}')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    rm -rf "$tmp"; echo "restic: контрольная сумма не совпала, файл не установлен"; return 1
  fi
  mkdir -p "$HOME_DIR/bin"
  bunzip2 -c "$tmp/$name" > "$HOME_DIR/bin/restic.new" && chmod 755 "$HOME_DIR/bin/restic.new" \
    && mv "$HOME_DIR/bin/restic.new" "$HOME_DIR/bin/restic"
  rm -rf "$tmp"
  echo "restic: $("$HOME_DIR/bin/restic" version)"
}
install_restic || echo "ВНИМАНИЕ: вторая копия не будет работать без restic. Установите: brew install restic — и запустите скрипт снова."

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
