# REGIME tab — a classifier whose every readout says what it is worth

**Files:** `regime.js` (pure classifier, no I/O), `server.js` (`fetchRegime` every 10 min → `/api/regime`, auth + subscription like every other route), `index.html` (the REGIME tab), `regime_events.json` (FOMC/NFP/CPI/PPI release days, 2026–27), `test/regime.test.js` (`npm test`, node ≥ 18, no new dependency).

**Data:** three ProjectX calls per symbol per cycle — 30-minute bars for ~65 sessions (premarket included), daily bars for ~260 sessions, and today's 1-minute RTH bars — plus the QQQ/SPY net-gamma label the GEX panel already holds. A 429 skips the cycle and keeps the last-good readout.

## What each panel computes, and what it is worth (measured on NQ 2010–2026, ~665 recorded tests)

The design decisions come from a research desk's record. **State is real, persistent and forecastable, and its value as a participate/skip gate measured zero against a matched-random control in every test but one.** So each panel prints its number *and* its measured decision value.

| panel | computes | worth |
|---|---|---|
| **Compression** | `pmv_pct` = trailing-60-session percentile of the 04:00–09:30 premarket range ÷ premarket close; `compress50` = ≤ 0.50, never tuned | **the only state classifier that ever beat a matched-random veto**: breakout Sharpe 1.327 vs random 0.611 ± 0.296 (p 0.006), win/loss 5.86 vs 0.73 (p 0.005), replicated on a second entry rule (p 0.000) and on ES (z +1.85). Mechanism is *whipsaw avoidance*: a quiet premarket predicts a **smaller** RTH range (205 vs 266 pts) and a **higher** 3R hit rate (17.4% vs 14.7%). "Compression predicts expansion" is false (killed twice). |
| **Calendar** | night into FOMC/NFP/CPI/PPI; release today; OPEX; quad witching; roll week | post-2021 the overnight premium exists **only on scheduled event nights**: +22.6 vs +8.8 pts (n = 290), long, exit at the 09:30 open, 200-day MA gate load-bearing for drawdown ($2,234 → $1,369). The release **second** is 11–54× friction and 48–85% done by t+5 s; direction after the spike was falsified on 993 events. Quad-witching close: 1.05× a normal day. |
| **Volatility state** | RTH range percentile vs trailing 60; causal HAR next-session range; ATR20 | a real forecast (HAR beats ATR-14 at DM t 7.21) **worth nothing as a gate**: inside a breakout engine, 455 vs 455 count-matched sessions, +5.97 vs +5.61 $/session, t −0.41. A *perfect* vol forecast is worth $0.00 (the apparent value was same-day leakage). Use it to size in ATR units. |
| **Dealer gamma** | sign from the GEX panel → next-session range expectation | **range only**: short gamma ⇒ 381 vs 257 pts (t +7.56). As a direction/participation gate: 194 configs × 50k permutations, every best filter below its null's mean; compress50 × gamma had the wrong sign (p 0.63). |
| **Jump risk** (proxy) | overnight gap in ATR20 + premarket realised vol vs its median | **inverted for breakout systems**: high-jump opens are their best days (+$68/trade @ 52% vs +$21 @ 37%); suppressing them cut holdout Sharpe 1.81 → 1.29–1.46. No post-2021 intraday mean-reversion edge to take the other side (91,755 trades, gross +0.069 pts vs a 1.30-pt cost floor). |
| **Balance / stand-down** | ≥ 45 min after the open ∧ ≥ 2 POC rotations ∧ developing range ÷ ATR14 ≤ 0.6 | real variance reduction, **matched by a random veto with the same skip count (p 0.65–0.89)** — discipline, not alpha. |
| **Trend** | 10-session efficiency ratio; 200-day MA | an observation, not a forecast: every hidden-state model fitted found a **volatility** state (log-rv separation 1.367 sd vs efficiency 0.120 sd, 11.4×); acceptance-vs-rejection at a break is undetectable until break + 15 min. |
| **Scale monitor** | any level you enter, in ATR20 units | every live absolute constant in the record drifted **−43% in ATR units** (ATR20 +68%); an absolute threshold is a date filter. |

**Honesty block** (bottom of the tab): friction 1.170 pts/RT on MNQ; the measured prior that a new regime idea is real is 3.5%, so an α = 0.05 pass is real ~37% of the time; the book's *outcome* was unconditionable across 1,980 cells while its participation, heat and excursion were; a random-control test validates a gate, not a stream.

*Numbers as of 2026-09-18; corrected in place with a dated banner if any moves.*
