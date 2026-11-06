#!/bin/bash
# Removes the LaunchAgent and the program. Settings, tokens and backups are kept
# unless --purge is given (backups in ~/CalendarBackups are never deleted).
set -euo pipefail
LABEL="com.calendar-backup.agent"
HOME_DIR="$HOME/Library/Application Support/CalendarBackup"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/.local/bin/calbackup"
rm -rf "$HOME_DIR/app" "$HOME_DIR/venv"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME_DIR"
  echo "Удалены программа, настройки и токены. Пароли в Связке ключей (сервис calendar-backup) удалите вручную."
else
  echo "Программа удалена. Настройки и токены: $HOME_DIR"
fi
echo "Резервные копии не тронуты: ~/CalendarBackups"
