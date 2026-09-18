'use strict';
/**
 * Regime classifier — every readout carries the number that says what it is
 * worth as a DECISION, measured on NQ 2010-2026 (~665 recorded tests).
 *
 * Design rules, each from a recorded result (see REGIME.md):
 *  1. The only state classifier that ever beat a matched-random veto is a
 *     PERCENTILE rule on the premarket range (`compress50`). Percentile, never a level.
 *  2. Every hidden-state model fitted found a VOLATILITY state, not a trend state
 *     (log-rv separation 1.367 sd vs efficiency 0.120 sd). Trend is an observation.
 *  3. The forecastable part of volatility is worth $0 as a gate (HAR beats ATR at
 *     DM t 7.21 and changes nothing inside the engine, t -0.41). HAR = range sizing only.
 *  4. Post-2021 the overnight premium exists ONLY on scheduled event nights
 *     (+22.6 vs +8.8 pts, n=290). The calendar is a first-class input.
 *  5. Dealer gamma predicts next-session RANGE (381 vs 257 pts, t +7.56), nothing
 *     directional (194 configs x 50k permutations, all below the null mean).
 *  6. High jump-risk opens are a breakout book's BEST days (+$68 vs +$21/trade).
 *  7. Absolute thresholds are date filters (every live constant drifted -43% in ATR
 *     units). Everything here is in ATR units or percentiles.
 *  8. A balance detector reduces variance exactly as well as a random veto with the
 *     same skip count (p 0.65-0.89). Discipline, never alpha.
 *
 * Pure functions over bar arrays [{t(ms), o, h, l, c, v}]. No I/O.
 */

const ET = 'America/New_York';
const C = {
  COMPRESS_PCTL: 0.50, COMPRESS_LOOKBACK: 60,
  FRICTION_PTS: 1.170, MIN_GROSS_PTS: 2.5,
  EVENT_NIGHT_PTS: 22.6, PLAIN_NIGHT_PTS: 8.8,
  GAMMA_RANGE: { short: 381.2, long: 257.1 },
  STANDDOWN_MIN: 45, STANDDOWN_RANGE_ATR: 0.6, STANDDOWN_POC_ROT: 2,
  EVENT_FAMILIES: ['FOMC', 'NFP', 'CPI', 'PPI'],
};

// ───────────────────────── time helpers (ET) ─────────────────────────
const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
});
function etParts(ms) {
  const p = {};
  for (const { type, value } of _fmt.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, wd: p.weekday };
}
const dateKey = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function weekdayOf(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
/** Session = ET date; a bar at/after 18:00 ET belongs to the NEXT session. */
function sessionOf(ms) {
  const p = etParts(ms);
  const k = dateKey(p.y, p.m, p.d);
  return p.hh >= 18 ? addDays(k, 1) : k;
}
const minuteOfDay = (p) => p.hh * 60 + p.mm;
const inPremarket = (p) => minuteOfDay(p) >= 240 && minuteOfDay(p) < 570;   // 04:00-09:30
const inRTH = (p) => minuteOfDay(p) >= 570 && minuteOfDay(p) < 960;          // 09:30-16:00

// ───────────────────────── per-session aggregation ─────────────────────────
function bySession(bars, pred) {
  const out = new Map();
  for (const b of bars) {
    const p = etParts(b.t);
    if (pred && !pred(p)) continue;
    const k = sessionOf(b.t);
    let s = out.get(k);
    if (!s) { s = { key: k, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, closes: [] }; out.set(k, s); }
    s.h = Math.max(s.h, b.h); s.l = Math.min(s.l, b.l); s.c = b.c; s.v += (b.v || 0); s.closes.push(b.c);
  }
  return [...out.values()].sort((a, b) => a.key < b.key ? -1 : 1);
}
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (x, n = 3) => (x == null || Number.isNaN(x)) ? null : +x.toFixed(n);

// ───────────────────────── 1. compress50 ─────────────────────────
/** pmv_pct: trailing-60-session percentile of (04:00-09:30 range / premarket close),
 *  today excluded from its own reference. Exactly the deployed rule. */
function premarketPct(bars) {
  const pm = bySession(bars, inPremarket).map(s => ({ key: s.key, rng: (s.h - s.l) / s.c }));
  return pm.map((s, i) => {
    const ref = pm.slice(Math.max(0, i - C.COMPRESS_LOOKBACK), i).map(x => x.rng);
    const pct = ref.length >= 20 ? mean(ref.map(r => r <= s.rng ? 1 : 0)) : null;
    return { key: s.key, pm_rng: s.rng, pmv_pct: pct, compress50: pct != null ? pct <= C.COMPRESS_PCTL : null };
  });
}

// ───────────────────────── 2. volatility ─────────────────────────
/** daily: array of {key, o, h, l, c} (any source). Adds range, atr14, atr20, ma200. */
function enrichDaily(daily) {
  const out = daily.map(d => ({ ...d, range: d.h - d.l }));
  for (let i = 0; i < out.length; i++) {
    const tr = (j) => j === 0 ? out[j].range : Math.max(out[j].range, Math.abs(out[j].h - out[j - 1].c), Math.abs(out[j].l - out[j - 1].c));
    const win = (n) => i + 1 >= n ? mean(Array.from({ length: n }, (_, k) => tr(i - k))) : null;
    out[i].atr14 = win(14); out[i].atr20 = win(20);
    out[i].ma200 = i + 1 >= 200 ? mean(out.slice(i - 199, i + 1).map(x => x.c)) : null;
  }
  return out;
}
/** HAR on log daily range, fitted causally on the trailing window. Next-session range in pts. */
function harForecast(daily, window = 250) {
  const lr = daily.map(d => d.range > 0 ? Math.log(d.range) : null).filter(x => x != null);
  if (lr.length < 60) return null;
  const rows = [];
  for (let i = 22; i < lr.length; i++) {
    const x1 = lr[i - 1], x5 = mean(lr.slice(i - 5, i)), x22 = mean(lr.slice(i - 22, i));
    rows.push([1, x1, x5, x22, lr[i]]);
  }
  const R = rows.slice(-window);
  // normal equations (4x4) — tiny, closed form via Gaussian elimination
  const A = Array.from({ length: 4 }, () => new Array(5).fill(0));
  for (const r of R) for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += r[i] * r[j]; A[i][4] += r[i] * r[4]; }
  for (let i = 0; i < 4; i++) {
    let piv = i; for (let k = i + 1; k < 4; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    [A[i], A[piv]] = [A[piv], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let k = 0; k < 4; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j < 5; j++) A[k][j] -= f * A[i][j]; }
  }
  const beta = A.map((row, i) => row[4] / row[i]);
  const n = lr.length;
  const last = [1, lr[n - 1], mean(lr.slice(n - 5)), mean(lr.slice(n - 22))];
  return Math.exp(last.reduce((s, x, i) => s + x * beta[i], 0));
}
function volState(rthDaily, daily) {
  const r = rthDaily.map(d => d.h - d.l);
  if (r.length < 30) return { state: 'unknown' };
  const ref = r.slice(-61, -1), last = r[r.length - 1];
  const pct = mean(ref.map(x => x <= last ? 1 : 0));
  const dl = daily[daily.length - 1] || {};
  return {
    state: pct >= 0.5 ? 'HIGH' : 'LOW', pct: round(pct), last_range_pts: round(last, 2),
    har_next_range_pts: round(harForecast(daily), 1), atr20_pts: round(dl.atr20, 2),
    decision_value: 'none as a gate -- HAR beats ATR at DM t 7.21 and changes nothing inside a breakout engine (t -0.41); size stops/targets in ATR units, do not skip days on it',
  };
}

// ───────────────────────── 3. trend observation ─────────────────────────
function efficiencyRatio(daily, n = 10) {
  const c = daily.map(d => d.c);
  if (c.length <= n) return null;
  const net = Math.abs(c[c.length - 1] - c[c.length - 1 - n]);
  let path = 0; for (let i = c.length - n; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
  return path > 0 ? round(net / path) : null;
}

// ───────────────────────── 4. calendar ─────────────────────────
function thirdFriday(y, m) {
  const d15 = new Date(Date.UTC(y, m - 1, 15));
  const off = (5 - d15.getUTCDay() + 7) % 7;
  return dateKey(y, m, 15 + off);
}
/** events: {FOMC:[iso...], NFP:[...], CPI:[...], PPI:[...]} — release DAYS (ET). */
function calendarState(todayKey, events) {
  const ev = {}; for (const k of Object.keys(events || {})) ev[k] = new Set(events[k]);
  let next = addDays(todayKey, 1); while (weekdayOf(next) === 0 || weekdayOf(next) === 6) next = addDays(next, 1);
  const tonight = C.EVENT_FAMILIES.filter(f => ev[f]?.has(next));
  const today = C.EVENT_FAMILIES.filter(f => ev[f]?.has(todayKey));
  const [y, m] = todayKey.split('-').map(Number);
  const tf = thirdFriday(y, m), quarterly = [3, 6, 9, 12].includes(m);
  const rollWeek = quarterly && todayKey >= addDays(tf, -4) && todayKey <= tf;
  const notes = [];
  notes.push(tonight.length
    ? 'event night: overnight premium +22.6 vs +8.8 pts (n=290), long only, exit at the 09:30 open, above the 200-day MA (that gate is load-bearing for drawdown)'
    : 'no scheduled premium tonight: unconditional overnight drift is dead post-2021');
  if (today.length) notes.push('release second: 48-85% of the 5-min move is done by t+5s; direction after the spike was falsified on 993 events');
  if (todayKey === tf && quarterly) notes.push('quad witching close travels 1.05x an ordinary day (n=41) -- nothing extra to trade');
  if (rollWeek) notes.push('roll week: a system that cached its contract at startup fails every order after the broker rolls, silently');
  return { event_night_tonight: tonight, release_today: today,
    overnight_premium_pts: tonight.length ? C.EVENT_NIGHT_PTS : C.PLAIN_NIGHT_PTS,
    opex: todayKey === tf, quad_witch: todayKey === tf && quarterly, roll_week: rollWeek, notes };
}

// ───────────────────────── 5. gamma ─────────────────────────
/** label: free-flow net_gex_label 'positive' (dealers long gamma) | 'negative' (short) */
function gammaState(label) {
  const sign = label === 'positive' ? 'long' : label === 'negative' ? 'short' : null;
  if (!sign) return { sign: null, next_range_expectation_pts: null, decision_value: 'not available' };
  return { sign, next_range_expectation_pts: C.GAMMA_RANGE[sign],
    decision_value: 'RANGE only (short gamma 381 vs 257 pts, t +7.56). As a directional or participation gate: null on 194 configs x 50k permutations; the compress50 x gamma interaction had the wrong sign (p 0.63)' };
}

// ───────────────────────── 6. jump-risk proxy ─────────────────────────
function jumpProxy(daily, pmSessions) {
  const dl = daily[daily.length - 1], prev = daily[daily.length - 2];
  if (!dl || !prev || !dl.atr20) return { level: 'unknown' };
  const gapAtr = Math.abs(dl.o - prev.c) / dl.atr20;
  const rv = pmSessions.map(s => { let a = 0; for (let i = 1; i < s.closes.length; i++) a += Math.abs(Math.log(s.closes[i] / s.closes[i - 1])); return a; });
  const med = median(rv.slice(-61, -1));
  const ratio = rv.length > 30 && med > 0 ? rv[rv.length - 1] / med : null;
  const score = gapAtr + (ratio ? Math.max(ratio - 1, 0) : 0);
  return { level: score >= 0.6 ? 'HIGH' : 'LOW', gap_atr20: round(gapAtr), premarket_rv_vs_median: round(ratio, 2),
    for_breakout_systems: 'HIGH is FAVOURABLE, not dangerous: suppressing high-jump opens cut holdout Sharpe 1.81 -> 1.29-1.46 (+$68/trade @ 52% win vs +$21 @ 37%)',
    for_mean_reversion: 'no post-2021 intraday MR edge on this instrument (91,755 trades, gross +0.069 pts vs a 1.30-pt cost floor)' };
}

// ───────────────────────── 8. balance / stand-down ─────────────────────────
function pocRotations(rth1m, atr14, bins = 40) {
  if (!rth1m.length || !atr14) return 0;
  const lo = Math.min(...rth1m.map(b => b.l)), hi = Math.max(...rth1m.map(b => b.h));
  if (hi <= lo) return 0;
  const vol = new Array(bins).fill(0); let last = null, rot = 0;
  for (const b of rth1m) {
    const i = Math.min(Math.floor((b.c - lo) / (hi - lo) * bins), bins - 1);
    vol[i] += b.v || 0;
    let am = 0; for (let k = 1; k < bins; k++) if (vol[k] > vol[am]) am = k;
    const poc = lo + (am + 0.5) * (hi - lo) / bins;
    if (last != null && Math.abs(poc - last) >= 0.1 * atr14) rot++;
    last = poc;
  }
  return rot;
}
function standdownState(rth1m, atr14, nowMs) {
  if (!rth1m.length) return { in_balance: false, reason: 'no RTH bars yet' };
  const p = etParts(nowMs || rth1m[rth1m.length - 1].t);
  const mins = minuteOfDay(p) - 570;
  const dev = Math.max(...rth1m.map(b => b.h)) - Math.min(...rth1m.map(b => b.l));
  const rot = pocRotations(rth1m, atr14);
  const cond = mins >= C.STANDDOWN_MIN && atr14 && dev / atr14 <= C.STANDDOWN_RANGE_ATR && rot >= C.STANDDOWN_POC_ROT;
  return { in_balance: !!cond, minutes_after_open: mins, developing_range_atr14: atr14 ? round(dev / atr14) : null, poc_rotations: rot,
    decision_value: 'variance reduction ONLY -- a random veto with the same skip count smooths the equity curve equally (p 0.65-0.89). Discipline, not alpha.' };
}

// ───────────────────────── the readout ─────────────────────────
/**
 * @param {object} inp
 *   bars30   : 30-min (or finer) bars covering >= 65 sessions incl. 04:00-09:30 ET premarket
 *   daily    : daily bars [{t,o,h,l,c}] >= 60 (250 for the 200-day MA)
 *   rth1m    : today's 1-min bars since 09:30 ET (may be empty pre-open)
 *   events   : {FOMC:[...],NFP:[...],CPI:[...],PPI:[...]}
 *   gexLabel : 'positive' | 'negative' | null
 *   nowMs    : clock
 */
function classify(inp) {
  const nowMs = inp.nowMs || Date.now();
  const pm = premarketPct(inp.bars30 || []);
  const pmSessions = bySession(inp.bars30 || [], inPremarket);
  const rthDaily = bySession(inp.bars30 || [], inRTH);
  const daily = enrichDaily((inp.daily || []).map(b => ({ key: sessionOf(b.t), o: b.o, h: b.h, l: b.l, c: b.c })));
  const todayKey = sessionOf(nowMs);
  const last = pm[pm.length - 1] || null;
  const dl = daily[daily.length - 1] || {};
  const above200 = dl.ma200 ? dl.c > dl.ma200 : null;
  const compression = {
    session: last?.key || null, pmv_pct: round(last?.pmv_pct), compress50: last?.compress50 ?? null,
    reading: last?.compress50
      ? 'QUIET premarket: whipsaw-avoidance state -- expect a SMALLER RTH range (median 205 vs 266 pts) but cleaner follow-through (3R hit 17.4% vs 14.7%)'
      : last?.compress50 === false ? 'LOUD premarket: false breaks that reverse are the modal outcome' : 'insufficient history (needs 20 prior sessions with a premarket)',
    decision_value: 'the only state classifier that ever beat a matched-random veto (ORB p 0.006, VC p 0.000; W/L 5.86 vs 0.73); removes ~48% of breakout trades and raises expectancy $10.69 -> $22.83',
  };
  const cal = calendarState(todayKey, inp.events);
  if (cal.event_night_tonight.length && above200 === false) cal.notes.push('below the 200-day MA: the event-night cell\'s drawdown gate is OFF');
  return {
    session: todayKey, generated_at: new Date(nowMs).toISOString(),
    compression,
    volatility: volState(rthDaily, daily),
    trend_observation: { efficiency_ratio_10d: efficiencyRatio(daily), above_200dma: above200,
      reading: 'an OBSERVATION of the last 10 sessions, not a forecast: every hidden-state model fitted here found a volatility state, not a trend state (11.4x), and acceptance-vs-rejection at a break is not detectable until break+15 min' },
    calendar: cal,
    gamma: gammaState(inp.gexLabel),
    jump_risk: jumpProxy(daily, pmSessions),
    balance: standdownState(inp.rth1m || [], dl.atr14, nowMs),
    scale: { atr20_pts: round(dl.atr20, 2), rule: 'an absolute threshold is a date filter (every live constant drifted -43% in ATR units); keep the ATR-unit twin, not the level' },
    honesty: [
      `friction ${C.FRICTION_PTS} pts/RT on MNQ; anything under ${C.MIN_GROSS_PTS} pts gross is dead before testing`,
      'prior that a new regime idea is real: 3.5%; an alpha=0.05 pass is real ~37% of the time',
      'the book\'s outcome is unconditionable (0 of 1,980 cells on pnl/win); its participation, heat and excursion are',
      'a random-control test validates a GATE, not a STREAM',
    ],
  };
}

module.exports = { C, etParts, sessionOf, bySession, premarketPct, enrichDaily, harForecast, volState,
  efficiencyRatio, thirdFriday, calendarState, gammaState, jumpProxy, pocRotations, standdownState, classify };
