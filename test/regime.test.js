'use strict';
// node --test test/   (node >= 18)
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../regime');

// deterministic PRNG
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
const etMs = (y, m, d, hh, mm) => {
  // build a UTC guess then correct to ET by reading back the parts
  let ms = Date.UTC(y, m - 1, d, hh + 4, mm);
  for (let i = 0; i < 3; i++) { const p = R.etParts(ms); ms += ((hh - p.hh) * 60 + (mm - p.mm)) * 60000; }
  return ms;
};

/** 30-min bars 04:00-16:00 ET for N weekday sessions; last premarket quiet or loud. */
function synth(sessions = 70, quietLast = true, seed = 1) {
  const r = rng(seed); const bars = [], daily = [];
  let price = 20000, day = new Date(Date.UTC(2026, 4, 4));
  for (let s = 0; s < sessions; s++) {
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const last = s === sessions - 1; let dO = null, dH = -1e9, dL = 1e9;
    for (let min = 240; min < 960; min += 30) {
      const pm = min < 570; let sd = pm ? 8 : 20; if (last && pm) sd = quietLast ? 1.5 : 40;
      const o = price, c = price + gauss(r) * sd, h = Math.max(o, c) + Math.abs(gauss(r)) * sd / 2, l = Math.min(o, c) - Math.abs(gauss(r)) * sd / 2;
      bars.push({ t: etMs(y, m, d, Math.floor(min / 60), min % 60), o, h, l, c, v: 100 + Math.floor(r() * 400) });
      if (dO == null) dO = o; dH = Math.max(dH, h); dL = Math.min(dL, l); price = c;
    }
    daily.push({ t: etMs(y, m, d, 12, 0), o: dO, h: dH, l: dL, c: price });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return { bars, daily, lastKey: daily[daily.length - 1] && R.sessionOf(daily[daily.length - 1].t) };
}

test('session rolls at 18:00 ET', () => {
  assert.equal(R.sessionOf(etMs(2026, 9, 13, 17, 59)), '2026-09-13');
  assert.equal(R.sessionOf(etMs(2026, 9, 13, 18, 0)), '2026-09-14');
});

test('compress50 fires on a quiet premarket and not on a loud one', () => {
  const q = R.classify({ bars30: synth(70, true).bars, daily: synth(70, true).daily, nowMs: etMs(2026, 8, 7, 9, 0) });
  const l = R.classify({ bars30: synth(70, false).bars, daily: synth(70, false).daily, nowMs: etMs(2026, 8, 7, 9, 0) });
  assert.equal(q.compression.compress50, true);
  assert.equal(l.compression.compress50, false);
  assert.ok(q.compression.pmv_pct < 0.5 && l.compression.pmv_pct > 0.5);
});

test('percentile needs 20 prior sessions and stays in [0,1]', () => {
  const pm = R.premarketPct(synth(30).bars);
  assert.ok(pm.slice(0, 20).every(x => x.pmv_pct == null));
  assert.ok(pm.slice(25).every(x => x.pmv_pct >= 0 && x.pmv_pct <= 1));
});

test('calendar: event night is the night INTO a release; quad/opex/roll on the third Friday', () => {
  const ev = { CPI: ['2026-09-18'], FOMC: ['2026-10-28'] };
  const k = R.calendarState('2026-09-17', ev);
  assert.deepEqual(k.event_night_tonight, ['CPI']);
  assert.equal(k.overnight_premium_pts, R.C.EVENT_NIGHT_PTS);
  const k2 = R.calendarState('2026-09-18', ev);
  assert.deepEqual(k2.release_today, ['CPI']); assert.deepEqual(k2.event_night_tonight, []);
  assert.ok(k2.quad_witch && k2.opex && k2.roll_week);
  assert.equal(R.thirdFriday(2026, 9), '2026-09-18');
});

test('gamma only moves the range expectation', () => {
  assert.ok(R.gammaState('negative').next_range_expectation_pts > R.gammaState('positive').next_range_expectation_pts);
  assert.match(R.gammaState('negative').decision_value, /null/);
  assert.equal(R.gammaState(null).sign, null);
});

test('HAR forecast is positive and refuses short history', () => {
  const d = R.enrichDaily(synth(90).daily.map(b => ({ key: R.sessionOf(b.t), o: b.o, h: b.h, l: b.l, c: b.c })));
  assert.ok(R.harForecast(d) > 0);
  assert.equal(R.harForecast(d.slice(-40)), null);
});

test('stand-down needs all three conditions and is labelled discipline', () => {
  const s = R.standdownState([], 100, etMs(2026, 6, 12, 9, 40));
  assert.equal(s.in_balance, false);
  const bars = Array.from({ length: 12 }, (_, i) => ({ t: etMs(2026, 6, 12, 9, 30 + i), o: 100, h: 101, l: 99, c: 100, v: 10 }));
  const e = R.standdownState(bars, 100, etMs(2026, 6, 12, 9, 42));
  assert.equal(e.minutes_after_open, 12);
  assert.match(e.decision_value, /random veto/);
});

test('readout carries every panel and the honesty block', () => {
  const s = synth(70);
  const r = R.classify({ bars30: s.bars, daily: s.daily, gexLabel: 'negative', events: {}, nowMs: etMs(2026, 8, 7, 9, 0) });
  for (const k of ['compression', 'volatility', 'trend_observation', 'calendar', 'gamma', 'jump_risk', 'balance', 'scale', 'honesty']) assert.ok(k in r, k);
  assert.equal(r.honesty.length, 4);
  assert.equal(r.gamma.sign, 'short');
});

test('module has no I/O', () => {
  const src = require('fs').readFileSync(require.resolve('../regime'), 'utf8');
  for (const bad of ['require(\'fs\')', 'require("fs")', 'fetch(', 'http', 'process.env']) assert.ok(!src.includes(bad), bad);
});
