// Server-side scoring. Moved out of index.html so the weights and thresholds are not
// shipped to the browser; the client only receives the finished read.
// The logic is a 1:1 port of the former client functions computeBias, renderStructureRead
// and renderCombinedPage, so the numbers are unchanged.

function fmt(v, d = 2) { return (v === null || v === undefined || isNaN(v)) ? '—' : parseFloat(v).toFixed(d); }

function fmtB(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

// ── Macro bias (Bias Score, composite, constellation, pills) ──
// m = macro cache, cot = COT for the instrument, gex = formatted SPY GEX, esPrice = ES last
function computeBias({ m, cot, gex, esPrice }) {
  const pts = [], pills = []; let macroScore = 0, components = [];

  if (m) {
    const norm = (v, lo, hi) => v === null ? 0 : Math.max(-1, Math.min(1, (v - (lo + hi) / 2) / ((hi - lo) / 2)));
    const yc_s = norm(m.yc, -1, 3), vix_s = norm(-(m.vix || 20), -40, -10), dxy_s = norm(-(m.dxy || 100), -110, -90), hy_s = norm(-(m.hy || 400), -900, -200);
    components = [
      { name: 'Yield Curve', score: yc_s, raw: m.yc !== null ? fmt(m.yc) + '%' : '—' },
      { name: 'VIX', score: vix_s, raw: m.vix !== null ? fmt(m.vix, 1) : '—' },
      { name: 'DXY', score: dxy_s, raw: m.dxy !== null ? fmt(m.dxy, 1) : '—' },
      { name: 'HY Spread', score: hy_s, raw: m.hy !== null ? fmt(m.hy, 0) + 'bp' : '—' },
    ];
    macroScore = 0.25 * yc_s + 0.18 * vix_s + 0.12 * dxy_s + 0.10 * hy_s;
    if (m.vix !== null) { const b = m.vix < 20; pts.push({ x: 72, y: b ? 55 : -50, bull: b, size: 10, label: 'VIX' }); pills.push({ t: 'VIX ' + (m.vix < 15 ? 'LOW' : m.vix < 25 ? 'NORMAL' : 'HIGH'), c: m.vix < 20 ? 'bull' : m.vix < 28 ? 'neut' : 'bear' }); }
    if (m.yc !== null) { const b = m.yc > 0.5; pts.push({ x: 80, y: b ? 60 : -40, bull: b, size: 9, label: 'YC' }); pills.push({ t: m.yc > 1.5 ? 'EXPANSION' : m.yc > 0 ? 'NORMAL YC' : m.yc > -0.5 ? 'FLAT YC' : 'INVERTED ', c: m.yc > 1 ? 'bull' : m.yc > 0 ? 'neut' : 'bear' }); }
    if (m.dxy !== null) { const b = m.dxy < 103; pts.push({ x: 62, y: b ? 45 : -35, bull: b, size: 8, label: 'DXY' }); pills.push({ t: 'DXY ' + (b ? 'WEAK' : 'STRONG'), c: b ? 'bull' : 'bear' }); }
    if (m.hy !== null) { const b = m.hy < 400; pts.push({ x: 65, y: b ? 38 : -42, bull: b, size: 8, label: 'CREDIT' }); pills.push({ t: m.hy < 300 ? 'CREDIT TIGHT' : m.hy < 500 ? 'CREDIT NORM' : 'CREDIT RISK', c: m.hy < 400 ? 'bull' : m.hy < 600 ? 'neut' : 'bear' }); }
  }

  if (cot) {
    const ls = cot.leveragedFunds, lsBull = ls.index < 20, lsBear = ls.index > 80;
    const cotScore = lsBull ? 0.3 : lsBear ? -0.3 : (ls.index - 50) / 50 * 0.2;
    macroScore = macroScore * 0.75 + cotScore * 0.25;
    components.push({ name: 'COT Signal', score: cotScore / 0.3, raw: ls.index + '/100' });
    pts.push({ x: 88, y: lsBull ? 72 : lsBear ? -72 : ls.net > 0 ? 25 : -25, bull: lsBull ? true : lsBear ? false : ls.net > 0, size: 12, label: 'COT-LS' });
    pts.push({ x: 55, y: cot.assetManagers.net > 0 ? 35 : -30, bull: cot.assetManagers.net > 0, size: 9, label: 'COT-AM' });
    pills.push(lsBull ? { t: 'COT BULL SIG', c: 'bull' } : lsBear ? { t: 'COT FADE SIG', c: 'bear' } : { t: 'COT NEUTRAL', c: 'neut' });
  }

  if (gex && esPrice) {
    const flip = gex.gamma_flip;
    const regime2 = (gex.net_gex_label || '').toLowerCase();
    const callWall = gex.call_wall, putWall = gex.put_wall;
    const netDex = gex.net_dex, netVanna = gex.net_vanna;
    const vix = m?.vix;
    let gexScore = 0;
    if (flip) gexScore += esPrice > flip ? 0.25 : -0.25;
    if (regime2.includes('positive')) gexScore += 0.1;
    else if (regime2.includes('negative')) gexScore -= 0.1;
    if (putWall) {
      if (esPrice < putWall) gexScore -= 0.2;
      else if (Math.abs(esPrice - putWall) <= 10) gexScore += 0.1;
    }
    if (callWall && esPrice > callWall) gexScore += 0.15;
    if (netDex !== null && netDex !== undefined) gexScore += netDex < 0 ? 0.15 : netDex > 0 ? -0.1 : 0;
    if (netVanna !== null && netVanna !== undefined && vix !== null) {
      const vannaPositive = netVanna > 0;
      if (vix < 15 && vannaPositive) gexScore += 0.15;
      else if (vix > 20 && !vannaPositive) gexScore -= 0.15;
      else if (vix < 18 && vannaPositive) gexScore += 0.08;
      else if (vix > 18 && !vannaPositive) gexScore -= 0.08;
    }
    gexScore = Math.max(-1, Math.min(1, gexScore));
    const gexLabel = gexScore > 0.2 ? 'GEX+DEX+V BULL' : gexScore < -0.2 ? 'GEX+DEX+V BEAR' : 'GEX NEUTRAL';
    const rawVal = `GEX:${regime2.includes('positive') ? 'POS' : 'NEG'} DEX:${netDex !== null ? (netDex < 0 ? '↑' : '↓') : '—'} V:${netVanna !== null ? (netVanna > 0 ? '+' : '-') : '—'}`;
    components.push({ name: 'GEX+DEX+Vanna', score: gexScore, raw: rawVal });
    pts.push({ x: 45, y: +(gexScore * 60).toFixed(0), bull: gexScore > 0, size: 9, label: 'GEX' });
    pills.push({ t: gexLabel, c: gexScore > 0.1 ? 'bull' : gexScore < -0.1 ? 'bear' : 'neut' });
    macroScore = macroScore * 0.85 + gexScore * 0.15;
  }

  const regime = macroScore > 0.4 ? 'RISK_ON' : macroScore < -0.4 ? 'RISK_OFF' : 'NEUTRAL';
  pills.push({ t: regime === 'RISK_ON' ? 'RISK-ON' : regime === 'RISK_OFF' ? 'RISK-OFF' : 'NEUTRAL', c: regime === 'RISK_ON' ? 'bull' : regime === 'RISK_OFF' ? 'bear' : 'neut' });
  pts.push({ x: 50, y: +(macroScore * 60).toFixed(0), bull: null, size: 11, label: 'CONS', consensus: true });
  const score = Math.max(0, Math.min(100, Math.round((macroScore + 1) / 2 * 100)));
  const consensus = (macroScore >= 0 ? '+' : '') + (macroScore * 100).toFixed(1) + '%';
  return { score, macroScore, regime, pts, pills, components, consensus };
}

// ── Structure Read (intraday context) ──
// gex = formatted GEX for the instrument, price = instrument last, nowUtcHour for the charm window
function computeStructure({ gex, price, nowUtcHour }) {
  if (!gex || !price) return null;
  const vwap = null; // VWAP disabled until the real futures feed is verified (same as before)
  const obs = [];
  let score = 0;

  const gexPos = gex.net_gex > 0;
  if (gex.net_gex != null) {
    obs.push(gexPos
      ? { t: `Net GEX ${fmtB(gex.net_gex)} positive — dealers long gamma, hedging dampens moves. Mean-reversion regime: fade extremes, expect range contraction.`, w: 0 }
      : { t: `Net GEX ${fmtB(gex.net_gex)} negative — dealers short gamma, hedging amplifies moves. Momentum regime: breakouts run, stops widen.`, w: 0 });
  }

  if (gex.gamma_flip) {
    const flipDist = ((price - gex.gamma_flip) / price * 100);
    if (price > gex.gamma_flip) {
      score += Math.min(30, flipDist * 30);
      obs.push({ t: `Price ${flipDist.toFixed(2)}% above gamma flip (${gex.gamma_flip.toFixed(2)}) — structurally supported. Flip acts as first support.`, w: +1 });
    } else {
      score -= Math.min(30, Math.abs(flipDist) * 30);
      obs.push({ t: `Price ${Math.abs(flipDist).toFixed(2)}% below gamma flip (${gex.gamma_flip.toFixed(2)}) — structurally weak. Reclaim of flip is the bull trigger.`, w: -1 });
    }
  }

  if (vwap && vwap.vwap) {
    const sigmaPos = vwap.sigma ? (price - vwap.vwap) / vwap.sigma : null;
    if (sigmaPos != null) {
      if (sigmaPos > 2) {
        score += gexPos ? -15 : +10;
        obs.push({ t: `Price at +${sigmaPos.toFixed(1)}σ above VWAP (${vwap.vwap.toFixed(2)}) — statistically stretched. ${gexPos ? 'In positive GEX this favors mean-reversion shorts back to +1σ/VWAP.' : 'In negative GEX overextension can extend — momentum carries.'}`, w: gexPos ? -1 : +1 });
      } else if (sigmaPos < -2) {
        score += gexPos ? +15 : -10;
        obs.push({ t: `Price at ${sigmaPos.toFixed(1)}σ below VWAP — statistically oversold. ${gexPos ? 'Positive GEX favors mean-reversion longs back toward VWAP.' : 'Negative GEX: falling knife risk, momentum can extend lower.'}`, w: gexPos ? +1 : -1 });
      } else if (sigmaPos > 0) {
        score += 10;
        obs.push({ t: `Price holding above VWAP (+${sigmaPos.toFixed(1)}σ) — intraday buyers in control. VWAP is the bull/bear line.`, w: +1 });
      } else {
        score -= 10;
        obs.push({ t: `Price below VWAP (${sigmaPos.toFixed(1)}σ) — intraday sellers in control. VWAP reclaim needed for long bias.`, w: -1 });
      }
    }
  }

  if (gex.net_dex != null) {
    if (gex.net_dex > 0) {
      score += 8;
      obs.push({ t: `Net DEX +${fmtB(gex.net_dex)} — dealer delta hedging adds passive bid into weakness.`, w: +1 });
    } else {
      score -= 8;
      obs.push({ t: `Net DEX ${fmtB(gex.net_dex)} — dealer hedging adds passive offer into strength.`, w: -1 });
    }
  }

  const confluences = [];
  if (vwap && gex) {
    const vLevels = [{ n: 'VWAP', v: vwap.vwap }, { n: '+1σ', v: vwap.sd1u }, { n: '−1σ', v: vwap.sd1l }, { n: '+2σ', v: vwap.sd2u }, { n: '−2σ', v: vwap.sd2l }];
    const gLevels = [{ n: 'Gamma Flip', v: gex.gamma_flip }, { n: 'Call Wall', v: gex.call_wall }, { n: 'Put Wall', v: gex.put_wall }, { n: 'Call OI Wall', v: gex.call_oi_wall }, { n: 'Put OI Wall', v: gex.put_oi_wall }];
    for (const vl of vLevels) for (const gl of gLevels) {
      if (vl.v && gl.v && Math.abs(vl.v - gl.v) / gl.v < 0.0015) confluences.push(`${vl.n} (${vl.v.toFixed(2)}) ≈ ${gl.n} (${gl.v.toFixed(2)})`);
    }
  }
  if (confluences.length) obs.push({ t: `CONFLUENCE ZONES: ${confluences.join(' · ')} — overlapping levels act as reinforced support/resistance, highest-probability reaction zones.`, w: 0 });

  if (gex.expected_move && price) {
    const emHigh = price + gex.expected_move, emLow = price - gex.expected_move;
    const parts = [];
    if (gex.call_wall) parts.push(gex.call_wall <= emHigh
      ? `Call wall (${gex.call_wall.toFixed(2)}) is INSIDE the expected move — a test today is statistically likely`
      : `Call wall (${gex.call_wall.toFixed(2)}) is OUTSIDE the expected move — unlikely to be reached without a vol event`);
    if (gex.put_wall) parts.push(gex.put_wall >= emLow
      ? `put wall (${gex.put_wall.toFixed(2)}) is INSIDE the expected move — downside test is in play`
      : `put wall (${gex.put_wall.toFixed(2)}) is OUTSIDE the expected move — strong statistical floor`);
    if (parts.length) obs.push({ t: `Options market prices ±${gex.expected_move.toFixed(1)} pts today (${emLow.toFixed(2)} – ${emHigh.toFixed(2)}). ${parts.join('; ')}.`, w: 0 });
  }

  if (gex.net_charm != null && gex.dte != null && gex.dte <= 1) {
    const late = nowUtcHour >= 18 && nowUtcHour < 20;
    const charmW = late ? 12 : 5;
    if (gex.net_charm > 0) {
      score += charmW;
      obs.push({ t: `Net charm positive (${fmtB(gex.net_charm)}) — pure time passage forces dealer buying${late ? '. FINAL 2H: charm is now the dominant flow, supportive drift into close likely' : ', strengthening into the close'}.`, w: +1 });
    } else {
      score -= charmW;
      obs.push({ t: `Net charm negative (${fmtB(gex.net_charm)}) — time passage forces dealer selling${late ? '. FINAL 2H: charm-driven supply dominates, fade late rallies' : ', pressure builds into the close'}.`, w: -1 });
    }
  }

  if (gex.iv_skew != null && gex.iv_skew > 3) {
    obs.push({ t: `IV skew at +${gex.iv_skew.toFixed(1)}% — unusually steep put skew signals heavy institutional downside hedging. Crash protection in demand, but heavy hedging often precedes squeezes higher (hedges unwind = vanna buying).`, w: 0 });
  }

  if (gex.dte === 0 && gex.call_oi_wall && gex.put_oi_wall && price > gex.put_oi_wall && price < gex.call_oi_wall) {
    obs.push({ t: `0DTE pin window: price trading between OI walls (${gex.put_oi_wall.toFixed(2)} – ${gex.call_oi_wall.toFixed(2)}). Charm decay into the close pulls price toward the dominant OI strike.`, w: 0 });
  }

  score = Math.max(-100, Math.min(100, Math.round(score)));
  const signal = score > 25 ? 1 : score < -25 ? -1 : 0;
  const lean = score > 25 ? 'BULLISH STRUCTURE' : score < -25 ? 'BEARISH STRUCTURE' : 'NEUTRAL / TWO-SIDED';
  return { score, signal, lean, obs };
}

// ── Combined read (macro / technical / fundamental) ──
function computeCombined({ macro, cot, gex, price, vwap }) {
  let m = 50, t = 50, f = 50;
  if (macro) {
    const vixS = macro.vix ? (macro.vix < 15 ? 70 : macro.vix < 20 ? 55 : macro.vix < 25 ? 40 : 25) : 50;
    const hyS = macro.hy ? (macro.hy < 2.5 ? 70 : macro.hy < 3.5 ? 55 : macro.hy < 5 ? 40 : 25) : 50;
    const ycS = (macro.t10 && macro.t2) ? ((macro.t10 - macro.t2) > 0.2 ? 65 : (macro.t10 - macro.t2) > -0.2 ? 50 : 35) : 50;
    const dxyS = macro.dxy ? (macro.dxy < 98 ? 65 : macro.dxy < 103 ? 50 : 35) : 50;
    m = Math.round((vixS + hyS + ycS + dxyS) / 4);
  }
  if (gex) {
    const gexS = gex.net_gex ? (gex.net_gex > 0 ? 65 : 35) : 50;
    const flipS = (gex.gamma_flip && price) ? (price > gex.gamma_flip ? 65 : 35) : 50;
    const vwapS = (vwap && price) ? (price > vwap.vwap ? 65 : 35) : 50;
    t = Math.round((gexS + flipS + vwapS) / 3);
  }
  if (cot) {
    const levS = cot.leveragedFunds ? (cot.leveragedFunds.index < 30 ? 70 : cot.leveragedFunds.index > 70 ? 30 : 50) : 50;
    const amS = cot.assetManagers ? (cot.assetManagers.index < 30 ? 70 : cot.assetManagers.index > 70 ? 30 : 50) : 50;
    f = Math.round((levS + amS) / 2);
  }
  const combined = Math.round(m * 0.45 + t * 0.35 + f * 0.20);
  const label = combined > 60 ? 'BULLISH' : combined < 40 ? 'BEARISH' : 'NEUTRAL';
  const cotLabel = cot?.leveragedFunds ? (cot.leveragedFunds.index < 30 ? 'leveraged funds at bullish extremes' : cot.leveragedFunds.index > 70 ? 'leveraged funds at bearish extremes' : 'leveraged funds neutral') : '';
  return { combined, label, macro: m, technical: t, fundamental: f, cotLabel };
}

module.exports = { computeBias, computeStructure, computeCombined };
