# Moot Portfolio

Static page with live quotes for a list of securities, a quantity field per position, position values and the portfolio total in USD.

Live page: https://avesergey1977.github.io/claude/

## How it works

| Part | File | Role |
|---|---|---|
| Page | `site/index.html` | Quotes table, quantities, totals in USD, adding and removing securities. Quantities are stored in the browser's `localStorage` and never leave it. Data is re-read every 5 minutes (every 30 s while an edit is pending) and when the tab regains focus. |
| Security list | `site/symbols.json` | Yahoo Finance tickers in the portfolio. The page edits this file through the GitHub API; the commit triggers a fresh fetch and deploy. |
| Fetcher | `scripts/fetch_quotes.py` | Fetches quotes and FX rates to USD (GBP and EUR always, plus any other currency held) from Yahoo Finance (through `curl_cffi` with browser impersonation; plain clients get HTTP 429), with the ECB rate via Frankfurter as the FX fallback. Writes `site/data/quotes.json`. Prices quoted in pence (GBp) are converted to GBP. A security that fails keeps its last price, marked stale; an unknown ticker is shown as "no data". |
| Schedule | `.github/workflows/quotes.yml` | GitHub Actions: every 15 minutes while the LSE (08:00–16:30 London) or NYSE (09:30–16:00 New York) is open, plus 20 minutes after the close; every 6 hours otherwise (00/06/12/18 UTC). Publishes to GitHub Pages. A newer run cancels an older one still in progress. |

## Adding and removing securities

1. Enter a Yahoo Finance ticker under **Add a security** (e.g. `MSFT`, `VOD.L`, `SAP.DE`), or click **×** on a row and confirm.
2. The first time, the page asks for a GitHub fine-grained token: repository access limited to this repository, permission **Contents: Read and write**. The token is kept in that browser's `localStorage` and sent only to `api.github.com`; **Disconnect** in the footer removes it.
3. The page commits the updated `site/symbols.json`; the workflow fetches quotes and redeploys within 1–2 minutes.

The token is stored per browser origin. Every GitHub Pages project of the same account shares the origin `https://avesergey1977.github.io`, so another Pages site of this account could read it. Use a token scoped to this repository only, with an expiry.

## Setup

1. The workflow must be on the default branch: scheduled runs and deploys to the `github-pages` environment work only from it. The default branch is currently `claude/stock-portfolio-tracker-c5bit1`.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Actions → Quotes → **Run workflow** for the first deploy.

## Limitations

- The schedule follows LSE and NYSE hours only. Securities on other exchanges are refreshed on the same schedule, so during their own session outside these hours they update only every 6 hours.
- Exchange holidays are not modelled; GitHub may start scheduled runs a few minutes late.
- Yahoo Finance is an unofficial API without an SLA.

## Local run

```sh
pip install curl_cffi
python3 scripts/fetch_quotes.py fetch --out site/data/quotes.json
python3 -m http.server -d site 8000
```

## Legal templates

`legal-templates/` is a copy of [General-Legal/legal-templates](https://github.com/General-Legal/legal-templates) (CC0 1.0): 12 templates in Markdown (`templates/*/template.md`) and the original `.docx` files (`docx-originals/`). The upstream commit is recorded in `legal-templates/UPSTREAM_COMMIT`. The folder is outside `site/` and `scripts/`, so it does not trigger the Quotes workflow.
