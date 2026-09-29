#!/usr/bin/env python3
"""Fetch quotes for the portfolio page and decide when a refresh is due.

Subcommands:
  gate   print run=true/false (and append to $GITHUB_OUTPUT) according to the
         schedule: every 15 min while LSE or NYSE is in session, every 6 h otherwise.
  fetch  download quotes + FX rates and write the JSON consumed by site/index.html.

Standard library only, so the workflow needs no dependency install.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

SYMBOLS = ["GOOG", "AAPL", "NVDA", "MO", "VUSA.L", "UDVD.L"]

# Regular sessions (local time). Exchange holidays are not modelled: on a holiday
# the 15-minute schedule simply re-fetches unchanged prices.
SESSIONS = {
    "LSE": ("Europe/London", (8, 0), (16, 30)),
    "NYSE": ("America/New_York", (9, 30), (16, 0)),
}
# Keep the 15-minute cadence a little past the close to capture closing prints
# even when GitHub delays a scheduled run.
CLOSE_GRACE = timedelta(minutes=20)

# Must match the off-hours cron in .github/workflows/quotes.yml.
OFF_HOURS_CRON = "0 */6 * * *"

# Yahoo quotes some LSE lines in minor units (pence).
MINOR_UNITS = {"GBp": ("GBP", 100), "GBX": ("GBP", 100), "ZAc": ("ZAR", 100), "ILA": ("ILS", 100)}

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]


def market_status(now: datetime, grace: timedelta = timedelta(0)) -> dict[str, bool]:
    status = {}
    for name, (tz, (oh, om), (ch, cm)) in SESSIONS.items():
        local = now.astimezone(ZoneInfo(tz))
        opens = local.replace(hour=oh, minute=om, second=0, microsecond=0)
        closes = local.replace(hour=ch, minute=cm, second=0, microsecond=0) + grace
        status[name] = local.weekday() < 5 and opens <= local < closes
    return status


def should_run(event: str, schedule: str, now: datetime) -> tuple[bool, str]:
    if event != "schedule":
        return True, f"event={event}"
    in_session = any(market_status(now, CLOSE_GRACE).values())
    if schedule == OFF_HOURS_CRON:
        # During trading hours the 15-minute schedule already covers this slot.
        return (not in_session), f"off-hours cron, in_session={in_session}"
    return in_session, f"trading-hours cron, in_session={in_session}"


def http_json(url: str, timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def yahoo_chart(symbol: str) -> dict:
    """Return the `meta` block of Yahoo's chart endpoint, trying both hosts with backoff."""
    path = f"/v8/finance/chart/{urllib.parse.quote(symbol)}?range=1d&interval=1d"
    last_err: Exception | None = None
    for attempt in range(3):
        for host in YAHOO_HOSTS:
            try:
                data = http_json(f"https://{host}{path}")
                result = (data.get("chart") or {}).get("result") or []
                if not result:
                    raise ValueError(f"empty result: {(data.get('chart') or {}).get('error')}")
                return result[0]["meta"]
            except (urllib.error.URLError, ValueError, KeyError, TimeoutError) as e:
                last_err = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"{symbol}: {last_err}")


def parse_quote(symbol: str, meta: dict) -> dict:
    price = meta.get("regularMarketPrice")
    prev = meta.get("previousClose") or meta.get("chartPreviousClose")
    currency = meta.get("currency") or "USD"
    if price is None:
        raise ValueError(f"{symbol}: no regularMarketPrice")
    if currency in MINOR_UNITS:
        currency, divisor = MINOR_UNITS[currency]
        price = price / divisor
        prev = prev / divisor if prev is not None else None
    ts = meta.get("regularMarketTime")
    return {
        "symbol": symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "currency": currency,
        "price": price,
        "prev_close": prev,
        "change_pct": (price / prev - 1) * 100 if prev else None,
        "market_time": datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None,
    }


def fx_to_usd(currency: str) -> dict:
    if currency == "USD":
        return {"rate": 1.0, "source": "identity"}
    try:
        meta = yahoo_chart(f"{currency}USD=X")
        ts = meta.get("regularMarketTime")
        return {
            "rate": float(meta["regularMarketPrice"]),
            "source": "Yahoo Finance",
            "as_of": datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None,
        }
    except Exception as e:  # fall back to ECB reference rate (daily)
        print(f"warn: Yahoo FX {currency}USD failed ({e}); using Frankfurter/ECB", file=sys.stderr)
        data = http_json(f"https://api.frankfurter.app/latest?from={currency}&to=USD")
        return {"rate": float(data["rates"]["USD"]), "source": "ECB via Frankfurter", "as_of": data.get("date")}


def load_previous(url: str | None) -> dict:
    if not url:
        return {}
    try:
        return http_json(url)
    except Exception as e:
        print(f"warn: previous snapshot unavailable ({e})", file=sys.stderr)
        return {}


def build_snapshot(now: datetime, prev: dict, fetch_meta=yahoo_chart, fetch_fx=fx_to_usd) -> dict:
    prev_quotes = {q["symbol"]: q for q in prev.get("quotes", [])}
    prev_fx = prev.get("fx", {})
    quotes, errors = [], []
    for sym in SYMBOLS:
        try:
            q = parse_quote(sym, fetch_meta(sym))
            q["stale"] = False
        except Exception as e:
            errors.append(f"{sym}: {e}")
            if sym not in prev_quotes:
                quotes.append({"symbol": sym, "name": sym, "price": None, "currency": None, "stale": True})
                continue
            q = dict(prev_quotes[sym], stale=True)
        quotes.append(q)

    fx = {}
    for cur in sorted({q["currency"] for q in quotes if q.get("currency")}):
        try:
            fx[cur] = fetch_fx(cur)
            fx[cur]["stale"] = False
        except Exception as e:
            errors.append(f"FX {cur}: {e}")
            if cur in prev_fx:
                fx[cur] = dict(prev_fx[cur], stale=True)

    for q in quotes:
        rate = fx.get(q.get("currency") or "", {}).get("rate")
        q["price_usd"] = q["price"] * rate if q.get("price") is not None and rate else None

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "market": market_status(now),
        "source": "Yahoo Finance",
        "fx": fx,
        "quotes": quotes,
        "errors": errors,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("gate")
    f = sub.add_parser("fetch")
    f.add_argument("--out", required=True)
    f.add_argument("--prev-url")
    args = ap.parse_args()
    now = datetime.now(timezone.utc)

    if args.cmd == "gate":
        run, why = should_run(os.environ.get("EVENT", "workflow_dispatch"), os.environ.get("SCHEDULE", ""), now)
        print(f"run={str(run).lower()} ({why})")
        if out := os.environ.get("GITHUB_OUTPUT"):
            with open(out, "a") as fh:
                fh.write(f"run={str(run).lower()}\n")
        return 0

    snap = build_snapshot(now, load_previous(args.prev_url))
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(snap, fh, ensure_ascii=False, indent=1)
    for e in snap["errors"]:
        print(f"warn: {e}", file=sys.stderr)
    fresh = sum(1 for q in snap["quotes"] if not q["stale"])
    print(f"wrote {args.out}: {fresh}/{len(SYMBOLS)} fresh quotes")
    # Fail the run only if nothing at all could be fetched, so a partial outage
    # still publishes the rest and marks the gaps as stale.
    return 0 if fresh else 1


if __name__ == "__main__":
    sys.exit(main())
