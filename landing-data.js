/* Alpha-Bias marketing page - placeholder data for every exhibit, in one place.
 * Values are taken from current terminal screenshots and are ILLUSTRATIVE. Replace with live data later by
 * assigning a new object of the same shape to window.LANDING_DATA before landing.js runs (or re-calling
 * window.renderLandingExhibits()).
 *
 * @typedef {{name:string, weight:number, score:number}} CompositeRow      score in [-1, 1]
 * @typedef {{label:string, conviction:number, bias:number}} SignalPoint   conviction 0-100, bias -100..100
 * @typedef {{strike:number, gex:number}} GexBar                            gex in $bn per 1% move (sign = dealer gamma)
 * @typedef {{name:string, price:number, kind:("wall"|"flip"|"prior"|"overnight"|"vwap")}} Level
 * @typedef {{
 *   asOf:string, instrument:string,
 *   bias:{score:number, label:string, consensus:number, regime:string, composite:CompositeRow[]},
 *   signals:SignalPoint[],
 *   regime:{growth:number, inflation:number, composite:number, quadrant:string},
 *   greeks:{price:number, callWall:number, putWall:number, gammaFlip:number, netGex:number, netDex:number, vanna:number, charm:number, bars:GexBar[]},
 *   levels:{price:number, rows:Level[]}
 * }} LandingData
 */
window.LANDING_DATA = /** @type {LandingData} */ ({
  asOf: "2 Oct 2026",                      // TODO bind to the live timestamp
  instrument: "ES",

  bias: {
    score: 59,                             // 0-100 Bias Score
    label: "BULLISH",
    consensus: 18.2,                       // net consensus in %
    regime: "REFLATION",
    composite: [                           // weights as displayed in the terminal (see methodology for the nesting)
      { name: "Yield curve",    weight: 25, score:  0.42 },
      { name: "VIX",            weight: 18, score:  0.31 },
      { name: "DXY",            weight: 12, score: -0.12 },
      { name: "HY spread",      weight: 10, score:  0.48 },
      { name: "COT signal",     weight: 25, score:  0.20 },
      { name: "GEX+DEX+Vanna",  weight: 15, score:  0.36 }
    ]
  },

  signals: [                               // Signal Constellation
    { label: "COT-LS", conviction: 88, bias:  62 },
    { label: "YC",     conviction: 80, bias:  58 },
    { label: "VIX",    conviction: 72, bias:  52 },
    { label: "GEX",    conviction: 76, bias:  40 },
    { label: "CREDIT", conviction: 65, bias:  36 },
    { label: "DXY",    conviction: 62, bias: -34 },
    { label: "COT-AM", conviction: 55, bias:  30 },
    { label: "DEX",    conviction: 48, bias: -22 },
    { label: "VANNA",  conviction: 42, bias:  18 },
    { label: "CHARM",  conviction: 36, bias: -12 },
    { label: "INDPRO", conviction: 30, bias:  14 },
    { label: "CPI",    conviction: 28, bias: -18 }
  ],

  regime: {
    growth: 0.38,                          // FRED growth z-score proxy, -1..1
    inflation: 0.44,                       // FRED inflation z-score proxy, -1..1
    composite: 0.27,                       // weighted macro composite, -1..+1
    quadrant: "Reflation"
  },

  greeks: {
    price: 6012.5,
    callWall: 6075, putWall: 5925, gammaFlip: 5975,
    netGex: 2.4, netDex: -0.8, vanna: 1.1, charm: -0.3,       // $bn, illustrative
    bars: [
      { strike: 5900, gex: -1.6 }, { strike: 5925, gex: -2.3 }, { strike: 5950, gex: -1.1 }, { strike: 5975, gex: -0.2 },
      { strike: 6000, gex:  0.9 }, { strike: 6025, gex:  1.5 }, { strike: 6050, gex:  2.0 }, { strike: 6075, gex:  2.8 },
      { strike: 6100, gex:  1.4 }, { strike: 6125, gex:  0.6 }
    ]
  },

  levels: {
    price: 6012.5,
    rows: [
      { name: "Call wall",        price: 6075.0, kind: "wall" },
      { name: "Overnight high",   price: 6031.25, kind: "overnight" },
      { name: "Prior-day high",   price: 6024.5, kind: "prior" },
      { name: "VWAP +1σ",         price: 6019.0, kind: "vwap" },
      { name: "Prior-day close",  price: 6004.75, kind: "prior" },
      { name: "Gamma flip",       price: 5975.0, kind: "flip" },
      { name: "Overnight low",    price: 5968.5, kind: "overnight" },
      { name: "Prior-day low",    price: 5961.25, kind: "prior" },
      { name: "Put wall",         price: 5925.0, kind: "wall" }
    ]
  }
});
