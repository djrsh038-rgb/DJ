#!/usr/bin/env python3
"""Refresh scripts/tickers.json watchlist into ../data.json using yfinance.

Runs in GitHub Actions (normal internet access), not in restricted sandboxes.
The site (index.html) fetches the resulting data.json same-origin - no CORS,
no API key, no browser-side calls needed for tickers covered by this file.
Tickers not in the watchlist still fall back to the backend/direct fetch
paths already built into index.html.
"""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

SCRIPT_DIR = Path(__file__).resolve().parent
TICKERS_PATH = SCRIPT_DIR / "tickers.json"
OUTPUT_PATH = SCRIPT_DIR.parent / "data.json"
RETRY_DELAY_SEC = 2
REQUEST_DELAY_SEC = 1


def yahoo_symbol(entry):
    if entry["market"] == "KR":
        return entry["ticker"].strip() + "." + entry.get("exchange", "KS")
    return entry["ticker"].strip().upper()


def fetch_one(symbol):
    """Return a dict of fields for one symbol, raising on total failure."""
    last_error = None
    for attempt in range(2):
        try:
            t = yf.Ticker(symbol)
            info = t.info or {}
            out = {}

            price = info.get("currentPrice") or info.get("regularMarketPrice")
            if isinstance(price, (int, float)):
                out["price"] = price

            per = info.get("trailingPE")
            if isinstance(per, (int, float)):
                out["per"] = per

            pbr = info.get("priceToBook")
            if isinstance(pbr, (int, float)):
                out["pbr"] = pbr

            payout = info.get("payoutRatio")
            if isinstance(payout, (int, float)):
                out["payoutRatio"] = payout * 100

            dps = info.get("dividendRate")
            if isinstance(dps, (int, float)):
                out["dps"] = dps

            debt_to_equity = info.get("debtToEquity")
            if isinstance(debt_to_equity, (int, float)):
                out["debtRatio"] = debt_to_equity

            try:
                bs = t.balance_sheet
                if bs is not None and not bs.empty and "Total Assets" in bs.index:
                    latest_col = bs.columns[0]
                    total_assets = bs.loc["Total Assets", latest_col]
                    if total_assets == total_assets:  # not NaN
                        out["totalAssets"] = float(total_assets)
            except Exception:
                pass  # total assets is best-effort; skip quietly

            if not out:
                raise ValueError("no usable fields returned")
            return out
        except Exception as e:  # noqa: BLE001 - want to retry on anything transient
            last_error = e
            if attempt == 0:
                time.sleep(RETRY_DELAY_SEC)
    raise RuntimeError(f"failed after retry: {last_error}")


def main():
    watchlist = json.loads(TICKERS_PATH.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc).isoformat()

    result = {}
    if OUTPUT_PATH.exists():
        try:
            result = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        except Exception:
            result = {}

    ok_count = 0
    fail_count = 0
    for entry in watchlist:
        symbol = yahoo_symbol(entry)
        try:
            data = fetch_one(symbol)
            data["updatedAt"] = now
            result[symbol] = data
            ok_count += 1
            print(f"OK   {symbol}: {data}")
        except Exception as e:  # noqa: BLE001
            fail_count += 1
            print(f"FAIL {symbol}: {e}", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SEC)

    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {OUTPUT_PATH} - {ok_count} ok, {fail_count} failed out of {len(watchlist)}")

    if ok_count == 0 and len(watchlist) > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
