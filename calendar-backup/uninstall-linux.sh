#!/bin/bash
# Removes the service and the program. Config, tokens, secrets and backups in
# /var/lib/calendar-backup are kept unless --purge is given.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo $0"; exit 1; }
UNIT="calendar-backup"
systemctl disable --now "$UNIT" 2>/dev/null || true
rm -f "/etc/systemd/system/$UNIT.service" /usr/local/bin/calbackup
systemctl daemon-reload || true
rm -rf /opt/calendar-backup
if [ "${1:-}" = "--purge" ]; then
  rm -rf /var/lib/calendar-backup
  userdel calbackup 2>/dev/null || true
  echo "Удалены программа, настройки, токены, пароли и копии на сервере."
else
  echo "Программа удалена. Настройки, токены и копии: /var/lib/calendar-backup"
fi
