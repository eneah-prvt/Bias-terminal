/* Alpha-Bias marketing page - exhibits (inline SVG drawn from window.LANDING_DATA), FAQ accordion, entrance fade.
 * No dependencies. All colours come from CSS classes in landing.css (c-*, t-*, s-*). */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, text) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function svg(w, h, label) {
    return el("svg", { viewBox: "0 0 " + w + " " + h, role: "img", "aria-label": label, preserveAspectRatio: "xMidYMid meet" });
  }
  function add(p, c) { p.appendChild(c); return c; }
  function fmt(v, d) { return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function signed(v, d) { return (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d); }
  function tone(v) { return v > 0 ? "bull" : v < 0 ? "bear" : "neutral"; }

  /* ---------- Exhibit 1: directional bias panel ---------- */
  function biasPanel(d) {
    var b = d.bias, s = svg(560, 456, "Directional bias panel for " + d.instrument + ": score " + b.score + " of 100, " + b.label +
      ", consensus " + signed(b.consensus, 1) + " percent, regime " + b.regime + ", with the score of each factor group.");
    // score ring
    var cx = 92, cy = 96, r = 66, circ = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, b.score / 100));
    add(s, el("circle", { cx: cx, cy: cy, r: r, fill: "none", "class": "c-grid", "stroke-width": 10 }));
    add(s, el("circle", { cx: cx, cy: cy, r: r, fill: "none", "class": "s-" + (b.score >= 55 ? "bull" : b.score <= 45 ? "bear" : "neutral"),
      "stroke-width": 10, "stroke-dasharray": (circ * frac) + " " + circ, transform: "rotate(-90 " + cx + " " + cy + ")" }));
    add(s, el("text", { x: cx, y: cy + 10, "text-anchor": "middle", "class": "t-big", "font-size": 40 }, String(b.score)));
    add(s, el("text", { x: cx, y: cy + 32, "text-anchor": "middle", "class": "t-num-muted" }, "of 100"));
    // read-out
    var x0 = 196;
    add(s, el("text", { x: x0, y: 52, "class": "t-muted" }, "Bias score · " + d.instrument));
    add(s, el("text", { x: x0, y: 86, "class": "t-big t-" + tone(b.score - 50), "font-size": 30 }, b.label));
    add(s, el("text", { x: x0, y: 122, "class": "t-muted" }, "Consensus"));
    add(s, el("text", { x: x0 + 92, y: 122, "class": "t-num" }, signed(b.consensus, 1) + "%"));
    add(s, el("text", { x: x0, y: 150, "class": "t-muted" }, "Regime"));
    add(s, el("rect", { x: x0 + 88, y: 135, width: 104, height: 22, rx: 2, fill: "none", "class": "s-neutral", "stroke-width": 1 }));
    add(s, el("text", { x: x0 + 140, y: 151, "text-anchor": "middle", "class": "t-num t-neutralc", "font-size": 12 }, b.regime));
    // composite bars
    add(s, el("line", { x1: 0, y1: 196, x2: 560, y2: 196, "class": "c-grid" }));
    add(s, el("text", { x: 0, y: 224, "class": "t-label", "font-weight": 600 }, "Factor groups"));
    add(s, el("text", { x: 560, y: 224, "text-anchor": "end", "class": "t-num-muted" }, "−1 … +1"));
    var top = 244, rowH = 30, mid = 352, half = 120;
    add(s, el("line", { x1: mid, y1: top - 6, x2: mid, y2: top + rowH * b.composite.length, "class": "c-axis" }));
    b.composite.forEach(function (c, i) {
      var y = top + i * rowH, w = Math.abs(c.score) * half;
      add(s, el("text", { x: 0, y: y + 17, "class": "t-label" }, c.name));
      add(s, el("rect", { x: mid - half, y: y + 6, width: half * 2, height: 14, "class": "c-track" }));
      add(s, el("rect", { x: c.score >= 0 ? mid : mid - w, y: y + 6, width: Math.max(1, w), height: 14, "class": "c-" + tone(c.score) }));
      add(s, el("text", { x: 560, y: y + 17, "text-anchor": "end", "class": "t-num t-" + tone(c.score) }, signed(c.score, 2)));
    });
    add(s, el("text", { x: 0, y: 450, "class": "t-note" }, "Bars show the score of each factor group."));
    return s;
  }

  /* ---------- Exhibit 2: signal constellation ---------- */
  function constellation(d) {
    var s = svg(560, 380, "Scatter of " + d.signals.length + " models: bias from minus 100 to plus 100 against conviction from 0 to 100. Consensus " +
      signed(d.bias.consensus, 1) + " percent, bias score " + d.bias.score + ".");
    var L = 52, R = 540, T = 20, B = 330;
    function X(v) { return L + (R - L) * v / 100; }
    function Y(v) { return T + (B - T) * (100 - v) / 200; }
    [-100, -50, 0, 50, 100].forEach(function (v) {
      add(s, el("line", { x1: L, y1: Y(v), x2: R, y2: Y(v), "class": v === 0 ? "c-dash" : "c-grid" }));
      add(s, el("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end", "class": "t-num-muted" }, (v > 0 ? "+" : "") + v));
    });
    [0, 25, 50, 75, 100].forEach(function (v) {
      add(s, el("line", { x1: X(v), y1: T, x2: X(v), y2: B, "class": "c-grid" }));
      add(s, el("text", { x: X(v), y: B + 18, "text-anchor": "middle", "class": "t-num-muted" }, String(v)));
    });
    add(s, el("line", { x1: L, y1: B, x2: R, y2: B, "class": "c-axis" }));
    add(s, el("text", { x: (L + R) / 2, y: B + 40, "text-anchor": "middle", "class": "t-muted" }, "Conviction (0–100)"));
    add(s, el("text", { x: 14, y: (T + B) / 2, "text-anchor": "middle", "class": "t-muted", transform: "rotate(-90 14 " + (T + B) / 2 + ")" }, "Bias"));
    d.signals.forEach(function (p) {                       // models are deliberately not named on the public page
      add(s, el("circle", { cx: X(p.conviction), cy: Y(p.bias), r: 4 + p.conviction / 25, "class": "c-" + tone(p.bias) }));
    });
    add(s, el("text", { x: R - 4, y: T + 16, "text-anchor": "end", "class": "t-note" }, "high-conviction bullish"));
    add(s, el("text", { x: L + 8, y: Y(0) - 8, "class": "t-note" }, "low-conviction noise"));
    return s;
  }

  /* ---------- Exhibit 3: regime quadrant + composite gauge ---------- */
  function regime(d) {
    var g = d.regime, s = svg(560, 400, "Macro regime quadrant from FRED growth and inflation: current reading " + g.quadrant +
      ". Weighted macro composite " + signed(g.composite, 2) + " on a scale from minus 1 to plus 1.");
    var L = 70, R = 490, T = 16, B = 276, cx = (L + R) / 2, cy = (T + B) / 2;
    add(s, el("rect", { x: L, y: T, width: R - L, height: B - T, fill: "none", "class": "c-axis" }));
    add(s, el("line", { x1: cx, y1: T, x2: cx, y2: B, "class": "c-dash" }));
    add(s, el("line", { x1: L, y1: cy, x2: R, y2: cy, "class": "c-dash" }));
    var q = [["Stagflation", L + 14, T + 26], ["Reflation", R - 14, T + 26], ["Deflation", L + 14, B - 14], ["Goldilocks", R - 14, B - 14]];
    q.forEach(function (a, i) {
      add(s, el("text", { x: a[1], y: a[2], "text-anchor": i % 2 ? "end" : "start", "class": "t-big", "font-size": 17,
        opacity: a[0] === g.quadrant ? 1 : 0.45 }, a[0]));
    });
    var px = cx + g.growth * (R - L) / 2, py = cy - g.inflation * (B - T) / 2;
    add(s, el("circle", { cx: px, cy: py, r: 7, "class": "c-navy" }));
    add(s, el("text", { x: px + 12, y: py + 4, "class": "t-note" }, "current reading"));
    add(s, el("text", { x: cx, y: B + 20, "text-anchor": "middle", "class": "t-muted" }, "Growth →"));
    add(s, el("text", { x: L - 12, y: cy, "text-anchor": "middle", "class": "t-muted", transform: "rotate(-90 " + (L - 12) + " " + cy + ")" }, "Inflation →"));
    // gauge
    var gy = 350, gL = 70, gR = 490; function GX(v) { return gL + (gR - gL) * (v + 1) / 2; }
    add(s, el("text", { x: gL, y: gy - 22, "class": "t-label", "font-weight": 600 }, "Weighted macro composite"));
    add(s, el("line", { x1: gL, y1: gy, x2: gR, y2: gy, "class": "c-axis" }));
    [-1, -0.5, 0, 0.5, 1].forEach(function (v) {
      add(s, el("line", { x1: GX(v), y1: gy - 4, x2: GX(v), y2: gy + 4, "class": "c-axis" }));
      add(s, el("text", { x: GX(v), y: gy + 22, "text-anchor": "middle", "class": "t-num-muted" }, (v > 0 ? "+" : "") + v.toFixed(1)));
    });
    [-0.2, 0.2].forEach(function (v) { add(s, el("line", { x1: GX(v), y1: gy - 14, x2: GX(v), y2: gy + 6, "class": "c-dash" })); });
    add(s, el("path", { d: "M" + GX(g.composite) + " " + (gy - 4) + " l-7 -12 h14 z", "class": "c-navy" }));
    add(s, el("text", { x: GX(g.composite) + 12, y: gy - 10, "class": "t-num" }, signed(g.composite, 2)));
    add(s, el("text", { x: gR + 8, y: gy + 4, "class": "t-note" }, "risk-on"));
    add(s, el("text", { x: gL - 8, y: gy + 4, "text-anchor": "end", "class": "t-note" }, "risk-off"));
    add(s, el("text", { x: gL, y: 396, "class": "t-note" }, "Dashed lines: neutral band (illustrative thresholds)."));
    return s;
  }

  /* ---------- Exhibit 4: dealer gamma by strike + walls ---------- */
  function greeks(d) {
    var k = d.greeks, s = svg(560, 400, "Dealer gamma exposure by strike for " + d.instrument + ". Call wall " + k.callWall + ", put wall " + k.putWall +
      ", gamma flip " + k.gammaFlip + ", last price " + fmt(k.price, 2) + ".");
    var stats = [["Net GEX", k.netGex], ["Net DEX", k.netDex], ["Vanna", k.vanna], ["Charm", k.charm]];
    stats.forEach(function (st, i) {
      var x = i * 140;
      add(s, el("text", { x: x, y: 16, "class": "t-muted" }, st[0]));
      add(s, el("text", { x: x, y: 38, "class": "t-num t-" + tone(st[1]), "font-size": 15 }, signed(st[1], 1) + " bn"));
    });
    add(s, el("line", { x1: 0, y1: 54, x2: 560, y2: 54, "class": "c-grid" }));
    var L = 56, R = 548, T = 84, B = 330, lo = k.bars[0].strike - 12.5, hi = k.bars[k.bars.length - 1].strike + 12.5;
    var mx = Math.max.apply(null, k.bars.map(function (b) { return Math.abs(b.gex); }));
    function X(v) { return L + (R - L) * (v - lo) / (hi - lo); }
    var zero = (T + B) / 2; function H(v) { return v / mx * (B - T) / 2; }
    [-1, 0, 1].forEach(function (f) {
      var y = zero - f * (B - T) / 2;
      add(s, el("line", { x1: L, y1: y, x2: R, y2: y, "class": f === 0 ? "c-axis" : "c-grid" }));
      add(s, el("text", { x: L - 8, y: y + 4, "text-anchor": "end", "class": "t-num-muted" }, f === 0 ? "0" : signed(f * mx, 1)));
    });
    var bw = (R - L) / k.bars.length * 0.62;
    k.bars.forEach(function (b) {
      var h = H(b.gex), x = X(b.strike) - bw / 2;
      add(s, el("rect", { x: x, y: h >= 0 ? zero - h : zero, width: bw, height: Math.abs(h), "class": b.gex >= 0 ? "c-navy" : "c-bear" }));
      add(s, el("text", { x: X(b.strike), y: B + 18, "text-anchor": "middle", "class": "t-num-muted" }, String(b.strike)));
    });
    [["Put wall", k.putWall], ["Gamma flip", k.gammaFlip], ["Call wall", k.callWall]].forEach(function (w) {
      add(s, el("line", { x1: X(w[1]), y1: T - 18, x2: X(w[1]), y2: B, "class": "c-dash" }));
      add(s, el("text", { x: X(w[1]), y: T - 22, "text-anchor": "middle", "class": "t-label", "font-size": 12 }, w[0]));
    });
    add(s, el("line", { x1: X(k.price), y1: T, x2: X(k.price), y2: B, "class": "c-navy-line" }));
    add(s, el("text", { x: X(k.price) + 6, y: B - 8, "class": "t-num", "font-size": 12 }, "last " + fmt(k.price, 2)));
    add(s, el("text", { x: L, y: 372, "class": "t-muted" }, "Strike (" + d.instrument + " points)  ·  bars: dealer gamma, $bn per 1% move"));
    add(s, el("text", { x: L, y: 394, "class": "t-note" }, "Positive gamma above the flip tends to pin price; below it, moves extend."));
    return s;
  }

  /* ---------- Exhibit 5: intraday level ladder ---------- */
  function levels(d) {
    var lv = d.levels, rows = lv.rows.slice().sort(function (a, b) { return b.price - a.price; });
    var s = svg(560, 420, "Intraday levels for " + d.instrument + " in native points with the distance from the last price " + fmt(lv.price, 2) + ".");
    add(s, el("text", { x: 0, y: 16, "class": "t-muted" }, "Level"));
    add(s, el("text", { x: 380, y: 16, "text-anchor": "end", "class": "t-muted" }, "Price"));
    add(s, el("text", { x: 560, y: 16, "text-anchor": "end", "class": "t-muted" }, "Distance (pts)"));
    add(s, el("line", { x1: 0, y1: 26, x2: 560, y2: 26, "class": "c-axis" }));
    var y = 52, inserted = false;
    rows.forEach(function (r) {
      if (!inserted && r.price < lv.price) {
        add(s, el("rect", { x: 0, y: y - 18, width: 560, height: 28, "class": "c-track" }));
        add(s, el("text", { x: 8, y: y + 1, "class": "t-label", "font-weight": 600 }, "Last price"));
        add(s, el("text", { x: 380, y: y + 1, "text-anchor": "end", "class": "t-num", "font-weight": 600 }, fmt(lv.price, 2)));
        y += 36; inserted = true;
      }
      var dist = r.price - lv.price;
      add(s, el("text", { x: 8, y: y, "class": "t-label" }, r.name));
      add(s, el("text", { x: 380, y: y, "text-anchor": "end", "class": "t-num" }, fmt(r.price, 2)));
      add(s, el("text", { x: 552, y: y, "text-anchor": "end", "class": "t-num t-" + tone(dist) }, signed(dist, 2)));
      add(s, el("line", { x1: 0, y1: y + 12, x2: 560, y2: y + 12, "class": "c-grid" }));
      y += 36;
    });
    add(s, el("text", { x: 0, y: 414, "class": "t-note" }, "Positive distance: level above the last price; negative: below."));
    return s;
  }

  /* ---------- Exhibit 6: full terminal overview with numbered callouts ---------- */
  function overview(d) {
    var s = svg(1100, 560, "Overview of the full Alpha-Bias terminal for " + d.instrument + " with five numbered panels: bias score, composite macro score, signal constellation, GEX levels and the tactical note.");
    function panel(x, y, w, h, title) {
      add(s, el("rect", { x: x, y: y, width: w, height: h, fill: "none", "class": "c-grid" }));
      add(s, el("text", { x: x + 16, y: y + 28, "class": "t-label", "font-size": 15, "font-weight": 600 }, title));
    }
    function badge(x, y, n) {
      add(s, el("circle", { cx: x, cy: y, r: 13, "class": "marker-dot" }));
      add(s, el("text", { x: x, y: y + 4.5, "text-anchor": "middle", "class": "marker-num", "font-size": 14 }, String(n)));
    }
    // top bar
    add(s, el("rect", { x: 0, y: 0, width: 1100, height: 44, "class": "c-track" }));
    add(s, el("text", { x: 16, y: 28, "class": "t-big", "font-size": 17 }, "ALPHA-BIAS"));
    ["MACRO BIAS", "SESSION CHECK", "INTRADAY LEVELS", "REGIME"].forEach(function (t, i) {
      add(s, el("text", { x: 220 + i * 150, y: 28, "class": i === 0 ? "t-label" : "t-muted", "font-size": 14, "font-weight": i === 0 ? 600 : 400 }, t));
    });
    add(s, el("text", { x: 1084, y: 28, "text-anchor": "end", "class": "t-num-muted", "font-size": 14 }, d.instrument + " · " + d.asOf));
    // 1 bias
    panel(0, 60, 340, 230, "Bias score");
    var b = d.bias, cx = 92, cy = 180, r = 52, circ = 2 * Math.PI * r;
    add(s, el("circle", { cx: cx, cy: cy, r: r, fill: "none", "class": "c-grid", "stroke-width": 9 }));
    add(s, el("circle", { cx: cx, cy: cy, r: r, fill: "none", "class": "s-bull", "stroke-width": 9, "stroke-dasharray": (circ * b.score / 100) + " " + circ, transform: "rotate(-90 " + cx + " " + cy + ")" }));
    add(s, el("text", { x: cx, y: cy + 11, "text-anchor": "middle", "class": "t-big", "font-size": 34 }, String(b.score)));
    add(s, el("text", { x: 172, y: 168, "class": "t-big t-bull", "font-size": 24 }, b.label));
    add(s, el("text", { x: 172, y: 196, "class": "t-num", "font-size": 15 }, "Consensus " + signed(b.consensus, 1) + "%"));
    add(s, el("text", { x: 172, y: 222, "class": "t-num t-neutralc", "font-size": 15 }, b.regime));
    badge(330, 60, 1);
    // 2 composite
    panel(356, 60, 384, 230, "Factor groups");
    b.composite.forEach(function (c, i) {
      var y = 108 + i * 32, mid = 600, half = 110, w = Math.abs(c.score) * half;
      add(s, el("text", { x: 372, y: y + 14, "class": "t-label", "font-size": 14 }, c.name));
      add(s, el("rect", { x: c.score >= 0 ? mid : mid - w, y: y + 3, width: Math.max(1, w), height: 14, "class": "c-" + tone(c.score) }));
      add(s, el("text", { x: 728, y: y + 14, "text-anchor": "end", "class": "t-num", "font-size": 14 }, signed(c.score, 2)));
    });
    add(s, el("line", { x1: 600, y1: 104, x2: 600, y2: 278, "class": "c-axis" }));
    badge(730, 60, 2);
    // 3 constellation
    panel(756, 60, 344, 230, "Signal constellation");
    var L = 780, R = 1080, T = 92, B = 274;
    add(s, el("line", { x1: L, y1: (T + B) / 2, x2: R, y2: (T + B) / 2, "class": "c-dash" }));
    add(s, el("line", { x1: L, y1: B, x2: R, y2: B, "class": "c-axis" }));
    d.signals.forEach(function (p) {
      add(s, el("circle", { cx: L + (R - L) * p.conviction / 100, cy: T + (B - T) * (100 - p.bias) / 200, r: 3 + p.conviction / 30, "class": "c-" + tone(p.bias) }));
    });
    badge(1090, 60, 3);
    // 4 levels
    panel(0, 306, 540, 254, "GEX levels · " + d.instrument);
    var lr = d.levels.rows.filter(function (r) { return r.kind === "wall" || r.kind === "flip" || r.name === "Prior-day close"; });
    lr.forEach(function (r, i) {
      var y = 362 + i * 44;
      add(s, el("text", { x: 16, y: y, "class": "t-label", "font-size": 15 }, r.name));
      add(s, el("text", { x: 330, y: y, "text-anchor": "end", "class": "t-num", "font-size": 15 }, fmt(r.price, 2)));
      add(s, el("text", { x: 520, y: y, "text-anchor": "end", "class": "t-num t-" + tone(r.price - d.levels.price), "font-size": 15 }, signed(r.price - d.levels.price, 2) + " pts"));
      add(s, el("line", { x1: 16, y1: y + 14, x2: 524, y2: y + 14, "class": "c-grid" }));
    });
    badge(530, 306, 4);
    // 5 tactical note
    panel(556, 306, 544, 254, "Tactical note");
    ["Positive gamma above the flip: expect mean reversion", "between the walls. Fade extensions into the call wall,", "do not chase strength above it. A break below the", "gamma flip changes the regime: moves extend,", "stops need more room."].forEach(function (t, i) {
      add(s, el("text", { x: 572, y: 366 + i * 30, "class": "t-label", "font-size": 15 }, t));
    });
    add(s, el("text", { x: 572, y: 530, "class": "t-note", "font-size": 14 }, "Illustrative wording; the terminal writes the note from live data."));
    badge(1090, 306, 5);
    return s;
  }

  /* ---------- mount ---------- */
  var BUILDERS = { bias: biasPanel, constellation: constellation, regime: regime, greeks: greeks, levels: levels, overview: overview };
  function render() {
    var d = window.LANDING_DATA; if (!d) return;
    document.querySelectorAll("[data-exhibit]").forEach(function (host) {
      var f = BUILDERS[host.getAttribute("data-exhibit")]; if (!f) return;
      host.textContent = "";
      var node = f(d); node.setAttribute("class", host.getAttribute("data-exhibit") === "overview" ? "w1100" : "w560");
      host.appendChild(node);
    });
    document.querySelectorAll("[data-asof]").forEach(function (n) { n.textContent = d.asOf; });
    document.querySelectorAll("[data-instrument]").forEach(function (n) { n.textContent = d.instrument; });
  }
  window.renderLandingExhibits = render;

  /* ---------- FAQ accordion ---------- */
  function faq() {
    document.querySelectorAll("#view-landing .faq-q").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var open = btn.getAttribute("aria-expanded") === "true", panel = document.getElementById(btn.getAttribute("aria-controls"));
        btn.setAttribute("aria-expanded", String(!open));
        btn.querySelector(".faq-sign").textContent = open ? "+" : "−";
        if (panel) panel.hidden = open;
      });
    });
  }

  /* ---------- entrance fade (150 ms, only if motion is allowed) ---------- */
  function fade() {
    var root = document.getElementById("view-landing");
    if (!root || !("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.classList.add("js-fade");
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -5% 0px" });
    root.querySelectorAll(".fade").forEach(function (n) { io.observe(n); });
    setTimeout(function () { root.querySelectorAll(".fade:not(.in)").forEach(function (n) { if (n.getBoundingClientRect().top < innerHeight) n.classList.add("in"); }); }, 800);
  }


  /* ---------- light / dark toggle (sun / moon), choice stored per browser ---------- */
  function themeToggle() {
    var root = document.documentElement;
    function apply(t) {
      if (t === "dark") root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
      document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
        b.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
        b.setAttribute("aria-pressed", String(t === "dark"));
      });
    }
    apply(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        apply(t);
        try { localStorage.setItem("ab-theme", t); } catch (e) {}
        document.dispatchEvent(new CustomEvent("ab-themechange", { detail: t }));
      });
    });
  }

  function init() { render(); faq(); fade(); themeToggle(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
