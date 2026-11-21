# Gold Signal Bot

The cloud part of Gold Signal Desk: a practice-money bot for gold (XAU/USD) that runs on GitHub every 15 minutes.

- **Strategy:** 4-hour breakout. Buy when a 4-hour candle closes above the highest high of the previous 20;
  sell when one closes below the lowest low. Stop 2 ATR away, then trailed to the opposite extreme of the last
  10 four-hour candles. No fixed target. 1% risk per trade.
- **Money:** virtual only. The practice account lives in `bot/data/state.json`; `bot/data/status.json` is
  what the phone app reads.
- **Prices:** public PAX Gold prices (Binance, with Coinbase as backup). Weekend prices are ignored.

Tested on 2011–2018 XAUUSD and 2023–2026 gold. It has long losing stretches. Not financial advice.
