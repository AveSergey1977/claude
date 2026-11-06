#!/usr/bin/env python3
"""Collects the lawyers catalog from gulenkovalegal.ru/lawyers into an xlsx workbook.

The page embeds the catalog as JSON in <script data-km-catalog="1"> fragments
(data-km-part / data-km-total / data-km-updated). Each run reads them, compares
the result with the last data sheet and:
  - on the first run, writes the full list to a sheet named YYYYMMDD;
  - later, adds a new YYYYMMDD sheet only when something changed: the full current
    list with a status per row (новый / изменён / без изменений) plus the rows
    that disappeared (удалён);
  - always appends a line to the "Журнал" sheet (the last sheet).
A repeated run on the same day replaces that day's sheet.
"""

import argparse
import datetime as dt
import json
import sys
import urllib.request
import zoneinfo
from html.parser import HTMLParser

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

URL = "https://gulenkovalegal.ru/lawyers"
TZ = zoneinfo.ZoneInfo("Europe/Vilnius")
LOG_SHEET = "Журнал"

FIELDS = ["city", "name", "phone", "telegram", "courts", "tasks", "extra", "lat", "lng"]
HEADERS = ["№", "Город", "ФИО / наименование", "Телефон", "Telegram", "Тип суда",
           "Поручения", "Дополнительно", "Широта", "Долгота", "Статус", "Что изменилось"]
WIDTHS = [6, 18, 38, 18, 24, 30, 40, 60, 11, 11, 15, 30]
FIELD_LABELS = dict(zip(FIELDS, HEADERS[1:10]))
LOG_HEADERS = ["Дата и время проверки (Вильнюс)", "Ревизия каталога на сайте", "Записей",
               "Новых", "Изменённых", "Удалённых", "Результат"]

STATUS_FILL = {
    "новый": PatternFill("solid", fgColor="E2EFDA"),
    "изменён": PatternFill("solid", fgColor="FFF2CC"),
    "удалён": PatternFill("solid", fgColor="F8CBAD"),
}


class CatalogParser(HTMLParser):
    """Collects the text of <script data-km-catalog="1"> fragments."""

    def __init__(self):
        super().__init__()
        self.fragments = []
        self._current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("data-km-catalog") == "1":
            self._current = {"attrs": attrs, "text": []}

    def handle_data(self, data):
        if self._current is not None:
            self._current["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._current is not None:
            self.fragments.append(self._current)
            self._current = None


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (lawyers-catalog-snapshot)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def parse(html):
    """Returns (revision, records). Applies the same consistency checks as the page itself."""
    parser = CatalogParser()
    parser.feed(html)
    frags = parser.fragments
    if not frags:
        raise ValueError("на странице не найдены блоки данных каталога (data-km-catalog)")
    total = int(frags[0]["attrs"].get("data-km-total", -1))
    revision = frags[0]["attrs"].get("data-km-updated")
    for i, f in enumerate(frags):
        a = f["attrs"]
        if (len(frags) != total or int(a.get("data-km-part", -1)) != i
                or int(a.get("data-km-total", -1)) != total or a.get("data-km-updated") != revision):
            raise ValueError("блоки данных каталога несогласованы (part/total/updated)")
    records = []
    for f in frags:
        for city in json.loads("".join(f["text"])):
            for p in city["people"]:
                records.append({
                    "city": city["name"],
                    "name": p.get("name", ""),
                    "phone": p.get("phone", ""),
                    "telegram": p.get("telegram", ""),
                    "courts": ", ".join(p.get("courts", [])),
                    "tasks": ", ".join(p.get("tasks", [])),
                    "extra": p.get("extra", ""),
                    "lat": city.get("lat"),
                    "lng": city.get("lng"),
                })
    return revision, records


def revision_text(revision):
    try:
        ts = dt.datetime.fromtimestamp(int(revision) / 1000, TZ)
        return f"{revision} ({ts:%Y-%m-%d %H:%M})"
    except (TypeError, ValueError):
        return str(revision)


def key(r):
    return (r["city"], r["name"])


def as_tuple(r):
    return tuple("" if r[f] is None else str(r[f]) for f in FIELDS)


def group(records):
    groups = {}
    for r in records:
        groups.setdefault(key(r), []).append(r)
    return groups


def diff(prev, cur):
    """Returns rows [(record, status, changes)] and counts. Records are matched by (город, ФИО)."""
    pg, cg = group(prev), group(cur)
    rows, counts = [], {"новый": 0, "изменён": 0, "удалён": 0}
    for k, recs in cg.items():
        old = pg.get(k)
        if old is None:
            status, changes = "новый", ""
        elif sorted(map(as_tuple, old)) == sorted(map(as_tuple, recs)):
            status, changes = "без изменений", ""
        else:
            status = "изменён"
            if len(old) == 1 and len(recs) == 1:
                changes = ", ".join(FIELD_LABELS[f] for f in FIELDS
                                    if str(old[0][f] or "") != str(recs[0][f] or ""))
            else:
                changes = "изменён состав записей с этим ФИО в городе"
        if status in counts:
            counts[status] += len(recs)
        rows += [(r, status, changes) for r in recs]
    for k, recs in pg.items():
        if k not in cg:
            counts["удалён"] += len(recs)
            rows += [(r, "удалён", "") for r in recs]
    return rows, counts


def read_sheet(ws):
    """Reads records from a data sheet, skipping rows marked as removed."""
    records = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or row[1] is None:
            continue
        if row[10] == "удалён":
            continue
        records.append(dict(zip(FIELDS, ["" if v is None else v for v in row[1:10]])))
    return records


def write_sheet(ws, rows):
    ws.append(HEADERS)
    for c in ws[1]:
        c.font = Font(bold=True)
        c.alignment = Alignment(vertical="top", wrap_text=True)
    for i, (r, status, changes) in enumerate(rows, 1):
        ws.append([i] + [r[f] for f in FIELDS] + [status, changes])
        fill = STATUS_FILL.get(status)
        for c in ws[ws.max_row]:
            c.alignment = Alignment(vertical="top", wrap_text=True)
            if fill:
                c.fill = fill
        # Phones and Telegram stay text so Excel does not turn them into numbers.
        for col in (4, 5):
            ws.cell(ws.max_row, col).number_format = "@"
    for i, w in enumerate(WIDTHS, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{ws.max_row}"


def log(wb, values):
    if LOG_SHEET not in wb.sheetnames:
        ws = wb.create_sheet(LOG_SHEET)
        ws.append(LOG_HEADERS)
        for c in ws[1]:
            c.font = Font(bold=True)
        for i, w in enumerate([30, 30, 10, 10, 12, 12, 70], 1):
            ws.column_dimensions[get_column_letter(i)].width = w
    ws = wb[LOG_SHEET]
    ws.append(values)
    # The log stays the last sheet.
    wb.move_sheet(ws, offset=len(wb.sheetnames) - 1 - wb.sheetnames.index(LOG_SHEET))


def run(out, html_file=None):
    now = dt.datetime.now(TZ)
    sheet_name = now.strftime("%Y%m%d")
    stamp = now.strftime("%Y-%m-%d %H:%M")
    try:
        wb = load_workbook(out)
    except FileNotFoundError:
        wb = Workbook()
        wb.remove(wb.active)

    try:
        html = open(html_file, encoding="utf-8").read() if html_file else fetch(URL)
        revision, records = parse(html)
    except Exception as e:  # noqa: BLE001 - the error goes to the log and the exit code
        log(wb, [stamp, "", "", "", "", "", f"ОШИБКА: {e}"])
        wb.save(out)
        print(f"error: {e}", file=sys.stderr)
        return 1

    data_sheets = [s for s in wb.sheetnames if s != LOG_SHEET and s != sheet_name]
    if not data_sheets:
        rows = [(r, "", "") for r in records]
        counts = {"новый": len(records), "изменён": 0, "удалён": 0}
        changed, result = True, "первичная выгрузка"
    else:
        rows, counts = diff(read_sheet(wb[data_sheets[-1]]), records)
        changed = any(counts.values())
        result = (f"изменения относительно листа {data_sheets[-1]}" if changed
                  else f"изменений нет относительно листа {data_sheets[-1]}, лист не создан")

    if sheet_name in wb.sheetnames:
        wb.remove(wb[sheet_name])
    if changed:
        ws = wb.create_sheet(sheet_name)
        write_sheet(ws, rows)
        if LOG_SHEET in wb.sheetnames:
            wb.move_sheet(ws, offset=wb.sheetnames.index(LOG_SHEET) - wb.sheetnames.index(sheet_name))
        result += f"; лист {sheet_name}"
    log(wb, [stamp, revision_text(revision), len(records),
             counts["новый"], counts["изменён"], counts["удалён"], result])
    wb.save(out)
    print(f"{stamp}: записей {len(records)}, новых {counts['новый']}, изменённых {counts['изменён']}, "
          f"удалённых {counts['удалён']}; {result}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="lawyers/lawyers.xlsx")
    ap.add_argument("--html", help="read a saved page instead of fetching it (for tests)")
    args = ap.parse_args()
    sys.exit(run(args.out, args.html))
