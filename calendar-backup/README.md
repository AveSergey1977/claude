# Calendar Backup

Автоматическое резервное копирование календарей (Google, iCloud, любые CalDAV, ICS-ссылки, все календари Calendar.app на Mac) в локальную папку и на Google Drive. Управление — через локальную панель `http://127.0.0.1:8765`.

## Что делает

| Функция | Реализация |
|---|---|
| Расписание | По умолчанию каждые 6 ч; меняется в панели (от 15 мин до 7 дней) без перезапуска. Отсчёт по настенным часам: если Mac спал, просроченная копия создаётся сразу после пробуждения. После сбоя — повтор не позднее чем через 1 ч. |
| Копия | Один zip на запуск: `<источник>/<календарь>.ics` + `manifest.json`; для Google дополнительно `<календарь>.json` (полный ответ API без потерь). Архив проверяется (`testzip`) до публикации. |
| Этот компьютер | `~/CalendarBackups/calendar-backup-ГГГГММДД-ЧЧММССZ-<компьютер>.zip` (время UTC и метка создавшего компьютера); распакованная последняя копия — `~/CalendarBackups/latest/`. Хранится 120 последних (≈30 дней при 6 ч), настраивается. |
| Google Drive | Папка «Calendar Backups» в «Моём диске». Режим `api` (загрузка через Drive API, доступ только к файлам, созданным программой — scope `drive.file`) или `folder` (копирование в папку Google Drive для компьютера). Хранится 120 последних, настраивается. |
| Панель | Частота; сколько копий хранить; включение Drive и отдельных источников; размер последней копии (сжатый и несжатый); объём всех локальных копий; время, способ запуска, результат, размер, число календарей и записей, длительность и подробности последних 5 запусков; кнопка «Создать копию сейчас»; «Открыть папку». |
| Ошибки | Результат «Частично», если отказал один источник или Drive; «Ошибка», если данных нет (архив не создаётся, старые копии не затираются). Уведомление macOS при любом сбое. Журнал: `~/Library/Application Support/CalendarBackup/calbackup.log`. |

## Источники

| `type` | Что охватывает | Точность |
|---|---|---|
| `google` | Все календари из списка Google Calendar аккаунта (свои, общие, подписки), через Calendar API | Серии событий с правилами повтора, исключения, отменённые вхождения (EXDATE), участники, напоминания, ссылки Meet; плюс исходный JSON |
| `caldav` | iCloud (`https://caldav.icloud.com`), Fastmail, Яндекс, Nextcloud и др. Включая списки Напоминаний (VTODO) | Объекты сохраняются в том виде, в каком их отдаёт сервер |
| `ics` | Любой календарь, опубликованный ссылкой `.ics`/`webcal://`: «секретный адрес» Google, публикация Outlook/Office 365, подписки | Как опубликовано |
| `macos` | Все аккаунты, подключённые к Calendar.app на этом Mac (в т.ч. Exchange/Outlook, Yahoo, «Дни рождения») | Повторяющиеся события сохраняются развёрнутыми по вхождениям в окне −10…+5 лет. Резервный «сборщик всего остального» |

## Установка (macOS)

```bash
git clone https://github.com/avesergey1977/claude.git && cd claude/calendar-backup
./install-macos.sh
```

Скрипт создаёт виртуальное окружение в `~/Library/Application Support/CalendarBackup`, команду `~/.local/bin/calbackup` и LaunchAgent `com.calendar-backup.agent` (запуск при входе в систему, перезапуск при сбое). Повторный запуск обновляет программу, сохраняя настройки, токены и историю. Удаление: `./uninstall-macos.sh` (копии в `~/CalendarBackups` не удаляются).

Настройки: `~/Library/Application Support/CalendarBackup/config.json` (создаётся из `config.example.json`). После правки файла вручную: `launchctl kickstart -k gui/$(id -u)/com.calendar-backup.agent`.

## Подключение источников

### Google Calendar и Google Drive (режим `api`)

1. [Google Cloud Console](https://console.cloud.google.com/) → создать проект.
2. APIs & Services → Library → включить **Google Calendar API** и **Google Drive API**.
3. OAuth consent screen → User type **Internal** (доступен для аккаунтов Google Workspace). При типе External в статусе Testing refresh-токен истекает через 7 дней и копирование Google будет прекращаться еженедельно ([Google: Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).
4. Credentials → Create credentials → OAuth client ID → **Desktop app** → скачать JSON и сохранить как
   `~/Library/Application Support/CalendarBackup/google_client_secret.json`.
5. `calbackup auth-google` — откроется браузер; разрешения: чтение календарей и доступ к файлам, созданным приложением.

Ограничить набор календарей: `calendar_ids` (только перечисленные) или `exclude_ids`.

### iCloud

1. [account.apple.com](https://account.apple.com) → Вход и безопасность → Пароли приложений → создать ([Apple: app-specific passwords](https://support.apple.com/en-us/102654)).
2. В `config.json` у источника `icloud` указать `username` (Apple ID).
3. `calbackup set-secret icloud` — ввести пароль приложения; он хранится в Связке ключей macOS, не в `config.json`.

Другие CalDAV-серверы — по образцу `icloud` со своим `url`, `username` и именем секрета.

### Все календари Mac (`macos`)

1. В `config.json` поставить `"enabled": true` у источника `mac`.
2. `calbackup grant-macos` — macOS запросит доступ к Календарю и выведет список найденных календарей. Если запроса нет: Системные настройки → Конфиденциальность и безопасность → Календари.
3. Исключить аккаунты, уже охваченные `google`/`caldav`: `"exclude_accounts": ["iCloud", "you@example.com"]` (имена — из вывода шага 2).

### Ссылки ICS

Секретные адреса содержат токен доступа; храните их в Связке ключей: `calbackup set-secret outlook-ics`, в конфиге — `{"keyring": "outlook-ics"}`. Открытую ссылку можно указать строкой.

### Вариант без Google Cloud

`"drive": {"mode": "folder"}` — копирование в папку Google Drive для компьютера (определяется автоматически в `~/Library/CloudStorage/GoogleDrive-*/My Drive`, иначе `folder_path`). Календари Google — источником `ics` по «секретному адресу в формате iCal» ([Google: Share your calendar](https://support.google.com/calendar/answer/37648)). Ограничение: такой адрес не передаёт напоминания, и его нужно добавлять для каждого календаря отдельно.

## Сервер (копии, пока Mac выключен)

Схема: сервер создаёт копии по расписанию и загружает их на Google Drive; Mac при запуске, после пробуждения и каждые 30 мин скачивает недостающие архивы из Drive в `~/CalendarBackups`, а сам создаёт копию только если новейшая копия на Drive старше интервала + 30 мин (сервер недоступен). Оба используют один OAuth-клиент, поэтому Mac видит файлы сервера при праве `drive.file`.

### Установка на сервер (Debian/Ubuntu, Fedora/RHEL; от root)

```bash
git clone -b claude/youthful-knuth-yfumwh https://github.com/avesergey1977/claude.git /root/calendar-backup-src
cd /root/calendar-backup-src/calendar-backup && ./install-linux.sh
```

Создаются системный пользователь `calbackup` (без входа в систему), программа в `/opt/calendar-backup`, данные в `/var/lib/calendar-backup` (права 700), служба systemd `calendar-backup` с ограничениями (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`), команда `calbackup` (выполняется от имени `calbackup`). Обновление: `git pull` и повторный `./install-linux.sh`. Удаление: `./uninstall-linux.sh` (`--purge` — вместе с данными).

### Доступы на сервере

1. Токен Google — с Mac, одной командой (передаётся по SSH, на диск сервера пишется с правами 600):
   ```bash
   ssh root@СЕРВЕР calbackup import-google-token < "$HOME/Library/Application Support/CalendarBackup/google_token.json"
   ```
   Альтернатива — отдельный вход на сервере: скопировать `google_client_secret.json` в `/var/lib/calendar-backup/` и выполнить `calbackup auth-google --no-browser` (инструкция с SSH-туннелем выводится на экран).
2. iCloud: `ssh -t root@СЕРВЕР calbackup set-secret icloud`; в `/var/lib/calendar-backup/config.json` у источника `icloud` — Apple ID и `"enabled": true`; затем `systemctl restart calendar-backup`. Пароли на сервере хранятся в `/var/lib/calendar-backup/secrets.json` (права 600, только пользователь `calbackup`).
3. Проверка: `calbackup run` и `calbackup doctor` на сервере.

### Панель сервера

Слушает только `127.0.0.1` сервера. С Mac — через SSH-туннель:
```bash
ssh -N -L 8766:127.0.0.1:8765 root@СЕРВЕР
```
и `http://127.0.0.1:8766` в браузере.

### Mac в режиме зеркала

В панели Mac: «Этот компьютер создаёт копии» → **только если копия сервера запаздывает**; включить **Скачивать недостающие копии с Google Drive**; «Сохранить». Кнопка «Скачать с Drive» — проверка немедленно. В истории колонка «Где создана» показывает, какой компьютер создал копию; при задержке сервера панель показывает «Сервер запаздывает».

Источник `macos` (Exchange/Outlook и прочие аккаунты Calendar.app) на сервере недоступен; при необходимости Mac остаётся единственным, кто его копирует (режим «сам, по расписанию»).

## Команды

| Команда | Действие |
|---|---|
| `calbackup run` | Копия сейчас (не пересекается с запуском из панели) |
| `calbackup sync` | Скачать с Google Drive недостающие копии |
| `calbackup import-google-token` | Установить токен Google, поданный на stdin (на сервере) |
| `calbackup status` | Последние 5 запусков |
| `calbackup auth-google` | Авторизация Google |
| `calbackup set-secret ИМЯ` | Пароль: на Mac — в Связку ключей, на сервере — в `secrets.json` (600) |
| `calbackup grant-macos` | Доступ к Календарю macOS |
| `calbackup paths` | Пути к настройкам, токенам, журналу |
| `calbackup doctor` | Диагностика, если панель пишет «Нет связи»: служба, порт, конфигурация, последние строки журналов |
| `calbackup restart` | Перезапуск службы на Mac; на сервере — `systemctl restart calendar-backup` |

## Восстановление

Файл `.ics` из архива импортируется в Google Calendar (Настройки → Импорт и экспорт), Calendar.app (Файл → Импорт) или Outlook. Импорт добавляет события в выбранный календарь; при импорте в непустой календарь возможны дубликаты.

## Безопасность

- Панель слушает только `127.0.0.1`; изменяющие запросы требуют токен страницы; запросы с `Host`, отличным от `127.0.0.1`/`localhost`, отклоняются (любой порт — для SSH-туннеля).
- Скачанные с Drive архивы проверяются по MD5 и целостности zip до помещения в папку; распаковка в `latest/` отклоняет пути вне папки.
- На сервере календарные данные хранятся на диске VPS незашифрованными (провайдер имеет физический доступ к диску); доступ по SSH — только по ключу.
- Пароли и секретные ссылки — в Связке ключей; OAuth-токен Google и настройки — в файлах с правами `600`.
- Архивы не шифруются: на диске Mac их защищает FileVault, на Google Drive — доступ к аккаунту.

## Тесты

```bash
pip install -r requirements.txt && python3 -m unittest discover -s tests -t . -v
```
