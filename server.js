const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
app.use(cors());
app.use(express.json());

const FRED_KEY     = process.env.FRED_API_KEY;
const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL      = process.env.APP_URL || 'http://localhost:3000';
const FLASHALPHA_KEY = process.env.FLASHALPHA_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const stripe   = new Stripe(STRIPE_KEY);

// ── Serve static frontend ─────────────────────────────────
app.use(express.static(__dirname));

// ══ AUTH HELPERS ══════════════════════════════════════════

// Verify Supabase JWT token from Authorization header
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });
  req.user = data.user;
  next();
}

// Check if user has active subscription
async function requireSubscription(req, res, next) {
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .single();
  if (!data) return res.status(403).json({ error: 'No active subscription' });
  req.subscription = data;
  next();
}

// ══ PROMO CODES ════════════════════════════════════════════

// Validate a promo code and return discount
app.post('/api/promo/validate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', code.toUpperCase().trim())
    .eq('active', true)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Invalid or expired code' });
  if (data.max_uses && data.uses_count >= data.max_uses)
    return res.status(400).json({ error: 'Code has reached maximum uses' });
  if (data.expires_at && new Date(data.expires_at) < new Date())
    return res.status(400).json({ error: 'Code has expired' });

  res.json({
    valid: true,
    code: data.code,
    discount_percent: data.discount_percent,
    discount_amount: data.discount_amount,
    description: data.description
  });
});

// ══ STRIPE CHECKOUT ════════════════════════════════════════

app.post('/api/checkout', requireAuth, async (req, res) => {
  const { promoCode } = req.body;
  const user = req.user;

  try {
    // Check if user already has a Stripe customer
    let { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id }
      });
      customerId = customer.id;
      await supabase.from('profiles').upsert({ id: user.id, stripe_customer_id: customerId });
    }

    // Build session params
    const sessionParams = {
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE, quantity: 1 }],
      success_url: `${APP_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/pricing`,
      metadata: { user_id: user.id }
    };

    // Apply promo code if provided
    if (promoCode) {
      const { data: promo } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode.toUpperCase().trim())
        .eq('active', true)
        .single();

      if (promo?.stripe_coupon_id) {
        sessionParams.discounts = [{ coupon: promo.stripe_coupon_id }];
        // Increment usage
        await supabase.from('promo_codes')
          .update({ uses_count: (promo.uses_count || 0) + 1 })
          .eq('id', promo.id);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    console.error('Checkout error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══ CHECKOUT SUCCESS (no webhook needed) ══════════════════

app.get('/api/checkout/success', requireAuth, async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status === 'unpaid') {
      return res.json({ active: false });
    }

    // Activate subscription in Supabase
    await supabase.from('subscriptions').upsert({
      user_id: req.user.id,
      stripe_subscription_id: session.subscription,
      stripe_customer_id: session.customer,
      status: 'active',
      created_at: new Date().toISOString()
    });

    // Also update profile with stripe customer id
    await supabase.from('profiles').upsert({
      id: req.user.id,
      stripe_customer_id: session.customer
    });

    res.json({ active: true });
  } catch (e) {
    console.error('Checkout success error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══ STRIPE WEBHOOK ═════════════════════════════════════════

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id;
    await supabase.from('subscriptions').upsert({
      user_id: userId,
      stripe_subscription_id: session.subscription,
      stripe_customer_id: session.customer,
      status: 'active',
      created_at: new Date().toISOString()
    });
  }

  if (event.type === 'customer.subscription.trial_will_end') {
    // Optional: send reminder email 3 days before trial ends
    console.log('Trial ending soon for subscription:', event.data.object.id);
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const status = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : 'inactive';
    await supabase.from('subscriptions')
      .update({ status })
      .eq('stripe_subscription_id', sub.id);
  }

  res.json({ received: true });
});

// ══ SUBSCRIPTION STATUS ════════════════════════════════════

app.get('/api/subscription', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .single();
  res.json({ active: !!data, subscription: data || null });
});

// ══ CUSTOMER PORTAL (manage/cancel) ═══════════════════════

app.post('/api/portal', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', req.user.id)
    .single();
  if (!profile?.stripe_customer_id)
    return res.status(400).json({ error: 'No Stripe customer found' });
  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${APP_URL}/dashboard`
  });
  res.json({ url: session.url });
});

// ══ MACRO DATA — Yahoo Finance + FRED for HY only ══════════

const macroCache = { data: null, updatedAt: null };

async function fetchYahoo(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
    const d = await r.json();
    return d.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch (e) {
    console.warn(`Yahoo ${symbol} error:`, e.message);
    return null;
  }
}

async function fetchFredSeries(seriesId) {
  if (!FRED_KEY) return null;
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=3`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).find(o => o.value !== '.');
    return obs ? parseFloat(obs.value) : null;
  } catch(e) { return null; }
}

async function fetchMacro() {
  try {
    const [vix, t10raw, t2raw, dxy, hy, indpro, cpi] = await Promise.all([
      fetchYahoo('^VIX'),
      fetchYahoo('^TNX'),
      fetchYahoo('^IRX'),
      fetchYahoo('DX-Y.NYB'),
      fetchFredSeries('BAMLH0A0HYM2'),  // HY Spreads
      fetchFredSeries('INDPRO'),         // Industrial Production (Growth proxy)
      fetchFredSeries('CPIAUCSL'),       // CPI (Inflation proxy)
    ]);

    const t10 = t10raw ? +(t10raw).toFixed(3) : null;
    const t2  = t2raw  ? +(t2raw / 10).toFixed(3) : null;
    const yc  = (t10 && t2) ? +(t10 - t2).toFixed(3) : null;

    // 4 Macro Regime Detection
    // Growth: INDPRO YoY change > 0 = expanding, < 0 = contracting
    // Inflation: CPI > 2.5% = elevated, < 2.5% = low
    // We use absolute levels as proxies since we only have latest value
    let macroRegime4 = 'NEUTRAL';
    let regimeDesc = '';
    let sessionRegime = 'MIXED';

    if (indpro !== null && cpi !== null) {
      // INDPRO: above 100 = expansion, below = contraction (base year 2017=100)
      const growthExpanding = indpro > 98;
      // CPI: above 3.0 = elevated inflation
      const inflationElevated = cpi > 3.0;

      if (growthExpanding && !inflationElevated) {
        macroRegime4 = 'GOLDILOCKS';
        regimeDesc = 'Growth expanding, inflation contained — best environment for ES/NQ longs';
      } else if (growthExpanding && inflationElevated) {
        macroRegime4 = 'REFLATION';
        regimeDesc = 'Growth expanding with elevated inflation — momentum strategies favored';
      } else if (!growthExpanding && inflationElevated) {
        macroRegime4 = 'STAGFLATION';
        regimeDesc = 'Growth contracting with elevated inflation — worst environment, reduce risk';
      } else {
        macroRegime4 = 'DEFLATION';
        regimeDesc = 'Growth contracting, inflation low — defensive positioning, bonds rally';
      }
    }

    macroCache.data = { vix, t10, t2, yc, dxy, hy, indpro, cpi, macroRegime4, regimeDesc, timestamp: new Date().toISOString() };
    macroCache.updatedAt = new Date().toISOString();
    console.log(`Macro updated: VIX=${vix} 10Y=${t10} DXY=${dxy} HY=${hy} INDPRO=${indpro} CPI=${cpi} Regime=${macroRegime4}`);
  } catch (e) {
    console.warn('Macro fetch error:', e.message);
  }
}

// Fetch every 5 minutes
fetchMacro();
setInterval(fetchMacro, 5 * 60 * 1000);

app.get('/api/macro', requireAuth, requireSubscription, (req, res) => {
  if (!macroCache.data) {
    return res.json({ vix: null, t10: null, t2: null, yc: null, dxy: null, hy: null, loading: true, timestamp: new Date().toISOString() });
  }
  res.json(macroCache.data);
});

// ══ CFTC COT DATA — cached in background ══════════════════

const cotCache = { data: null, updatedAt: null };

async function fetchCOT() {
  // TFF Futures Only - correct Socrata endpoint for financial futures
  const url = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$where=report_date_as_yyyy_mm_dd>'2024-01-01' AND (cftc_contract_market_code='13874%2B' OR cftc_contract_market_code='209742')&$order=report_date_as_yyyy_mm_dd DESC&$limit=120`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error('CFTC HTTP ' + r.status);
    const rows = await r.json();

    const processInstrument = (code, name) => {
      const history = rows.filter(r => r.cftc_contract_market_code === code).slice(0, 52);
      if (!history.length) return null;
      const latest = history[0];
      const net = (l, s) => Math.round(parseFloat(latest[l] || 0) - parseFloat(latest[s] || 0));
      const cotIndex = (lf, sf) => {
        const vals = history.map(h => parseFloat(h[lf] || 0) - parseFloat(h[sf] || 0));
        const mn = Math.min(...vals), mx = Math.max(...vals), cur = vals[0];
        return mx === mn ? 50 : Math.round((cur - mn) / (mx - mn) * 100);
      };
      return {
        name, date: latest.report_date_as_yyyy_mm_dd,
        leveragedFunds: { net: net('noncomm_positions_long_all','noncomm_positions_short_all'), index: cotIndex('noncomm_positions_long_all','noncomm_positions_short_all') },
        assetManagers:  { net: net('comm_positions_long_all','comm_positions_short_all'),    index: cotIndex('comm_positions_long_all','comm_positions_short_all') },
        smallSpec:      { net: net('nonrept_positions_long_all','nonrept_positions_short_all'), index: cotIndex('nonrept_positions_long_all','nonrept_positions_short_all') }
      };
    };

    cotCache.data = {
      ES: processInstrument('13874+', 'S&P 500 E-mini'),
      NQ: processInstrument('209742', 'NASDAQ 100 E-mini'),
      timestamp: new Date().toISOString()
    };
    cotCache.updatedAt = new Date().toISOString();
    console.log('COT data updated:', cotCache.updatedAt);
  } catch (e) {
    console.warn('COT fetch error:', e.message);
  }
}

// Fetch COT on startup and every 6 hours
fetchCOT();
setInterval(fetchCOT, 6 * 60 * 60 * 1000);

app.get('/api/cot', requireAuth, requireSubscription, (req, res) => {
  if (!cotCache.data) {
    return res.json({ ES: null, NQ: null, loading: true, timestamp: new Date().toISOString() });
  }
  res.json(cotCache.data);
});

// ══ YAHOO FINANCE PRICE CACHE ══════════════════════════════

const priceCache = {
  ES: { price: null, high: null, low: null, prev_close: null, updatedAt: null },
  NQ: { price: null, high: null, low: null, prev_close: null, updatedAt: null }
};

async function fetchPrice(symbol, cacheKey) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No meta data');
    priceCache[cacheKey] = {
      price:      meta.regularMarketPrice,
      high:       meta.regularMarketDayHigh,
      low:        meta.regularMarketDayLow,
      prev_close: meta.previousClose,
      updatedAt:  new Date().toISOString()
    };
    console.log(`Price ${cacheKey} updated: ${priceCache[cacheKey].price}`);
  } catch (e) {
    console.warn(`Price ${cacheKey} error:`, e.message);
  }
}

async function fetchAllPrices() {
  await Promise.all([
    fetchPrice('ES=F', 'ES'),
    fetchPrice('NQ=F', 'NQ')
  ]);
}

// Refresh prices every 5 minutes always (market hours handled by Yahoo)
setInterval(async () => { await fetchAllPrices(); }, 5 * 60 * 1000);

// Fetch on startup immediately
(async () => { await fetchAllPrices(); })();

// ══ PRICE ENDPOINT ═════════════════════════════════════════

app.get('/api/prices', requireAuth, requireSubscription, (req, res) => {
  res.json({ ES: priceCache.ES, NQ: priceCache.NQ, timestamp: new Date().toISOString() });
});

// ══ SESSION DATA — Asia & London indicators ═══════════════

const sessionCache = {
  data: null,
  updatedAt: null
};

async function fetchSessionData() {
  try {
    // Asia: Nikkei + USDJPY
    // London: DAX + EURUSD
    // All via Yahoo Finance
    const [nikkei, usdjpy, dax, eurusd, gbpusd] = await Promise.all([
      fetchYahoo('^N225'),      // Nikkei 225
      fetchYahoo('USDJPY=X'),   // USD/JPY — risk proxy
      fetchYahoo('^GDAXI'),     // DAX
      fetchYahoo('EURUSD=X'),   // EUR/USD
      fetchYahoo('GBPUSD=X'),   // GBP/USD
    ]);

    const now = new Date();
    const utcH = now.getUTCHours();

    // Asia session: 00:00 - 08:00 UTC
    // London session: 07:00 - 15:30 UTC
    // NY session: 13:30 - 21:00 UTC

    // USDJPY: rising = risk-off (flight to USD), falling = risk-on
    // Nikkei: rising = risk-on for Asia
    // DAX: rising = risk-on for Europe
    // EURUSD: rising = USD weak = risk-on

    sessionCache.data = {
      asia: {
        nikkei,
        usdjpy,
        // Bias: Nikkei up + USDJPY falling = risk-on
        bias: nikkei && usdjpy ? (nikkei > 0 ? 'bullish' : 'bearish') : null
      },
      london: {
        dax,
        eurusd,
        gbpusd,
        bias: dax ? (dax > 0 ? 'bullish' : 'bearish') : null
      },
      updatedAt: new Date().toISOString()
    };

    // Get prev close for % change calculation
    const [nikkeiData, daxData] = await Promise.all([
      fetchYahooFull('^N225'),
      fetchYahooFull('^GDAXI'),
    ]);

    if (nikkeiData) {
      const chg = ((nikkeiData.price - nikkeiData.prevClose) / nikkeiData.prevClose * 100);
      sessionCache.data.asia.nikkeiChg = +chg.toFixed(2);
      sessionCache.data.asia.bias = chg > 0.3 ? 'bullish' : chg < -0.3 ? 'bearish' : 'neutral';
    }
    if (daxData) {
      const chg = ((daxData.price - daxData.prevClose) / daxData.prevClose * 100);
      sessionCache.data.london.daxChg = +chg.toFixed(2);
      sessionCache.data.london.bias = chg > 0.3 ? 'bullish' : chg < -0.3 ? 'bearish' : 'neutral';
    }

    sessionCache.updatedAt = new Date().toISOString();
    console.log(`Session data updated: Nikkei=${nikkei} DAX=${dax} USDJPY=${usdjpy}`);
  } catch(e) {
    console.warn('Session data error:', e.message);
  }
}

async function fetchYahooFull(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      price: meta.regularMarketPrice,
      prevClose: meta.previousClose || meta.chartPreviousClose
    };
  } catch(e) { return null; }
}

// Fetch session data every 15 minutes
fetchSessionData();
setInterval(fetchSessionData, 15 * 60 * 1000);

app.get('/api/session', requireAuth, requireSubscription, (req, res) => {
  res.json(sessionCache.data || { asia: null, london: null, updatedAt: null });
});

// ══ GEX CACHE (server-side, shared for all users) ══════════

const gexCache = {
  SPY: { data: null, updatedAt: null },
  QQQ: { data: null, updatedAt: null }
};

async function fetchGEX(symbol) {
  if (!FLASHALPHA_KEY) return null;
  try {
    const r = await fetch(`https://lab.flashalpha.com/v1/stock/${symbol.toLowerCase()}/summary`, {
      headers: { 'X-Api-Key': FLASHALPHA_KEY }
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn(`GEX ${symbol} failed: HTTP ${r.status} - ${JSON.stringify(err)}`);
      return null;
    }
    const d = await r.json();
    console.log(`GEX ${symbol} raw response:`, JSON.stringify(d).substring(0, 500));
    // Extract GEX data from summary response
    const exposure = d.exposure || d.exposures || {};
    const result = {
      net_gex:          exposure.net_gex ?? null,
      net_gex_label:    exposure.regime ?? d.regime ?? null,
      gamma_flip:       exposure.gamma_flip ?? d.gamma_flip ?? null,
      call_wall:        exposure.call_wall ?? d.call_wall ?? null,
      put_wall:         exposure.put_wall ?? d.put_wall ?? null,
      underlying_price: d.price?.last ?? d.underlying_price ?? null,
    };
    gexCache[symbol] = { data: result, updatedAt: new Date().toISOString() };
    console.log(`GEX ${symbol} updated: flip=${result.gamma_flip} regime=${result.net_gex_label}`);
    return result;
  } catch (e) {
    console.warn(`GEX ${symbol} error:`, e.message);
    return null;
  }
}

// Schedule GEX updates — 5 calls total during NY session
// All times UTC (Zürich CEST = UTC+2)
// 13:30 UTC = 15:30 CEST → NY Open → SPY + QQQ (2 calls)
// 15:00 UTC = 17:00 CEST → Mid Session → SPY + QQQ (2 calls)
// 17:30 UTC = 19:30 CEST → Late Session → QQQ only (1 call)

// GEX Schedule (UTC times = CEST-2):
// 13:30 UTC = 15:30 CEST → NY Open → SPY + QQQ
// 15:00 UTC = 17:00 CEST → Mid Session → SPY + QQQ
// 17:30 UTC = 19:30 CEST → Late Session → QQQ only

function scheduleGEX() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (!isWeekday) return;

  if      (h === 13 && m === 30) { fetchGEX('SPY'); fetchGEX('QQQ'); }
  else if (h === 15 && m === 0)  { fetchGEX('SPY'); fetchGEX('QQQ'); }
  else if (h === 17 && m === 30) { fetchGEX('QQQ'); }
}

// Check every minute for scheduled times
setInterval(scheduleGEX, 60 * 1000);
console.log('GEX scheduler active: 15:30, 17:00, 19:30 CEST on weekdays');

// ══ GEX ENDPOINT (serves cached data) ═════════════════════

// SPY to ES multiplier (~10x) and QQQ to NQ (~40x approx)
function spyToES(price) { return price ? +(price * 10).toFixed(2) : null; }
function qqqToNQ(price) { return price ? +(price * 40.5).toFixed(2) : null; }

app.get('/api/gex', requireAuth, requireSubscription, (req, res) => {
  const formatGex = (cache, symbol, convertFn) => {
    if (!cache.data) return null;
    const d = cache.data;
    return {
      symbol,
      net_gex:           d.net_gex ?? null,
      net_gex_label:     d.net_gex_label ?? null,
      gamma_flip:        convertFn(d.gamma_flip),
      call_wall:         convertFn(d.call_wall?.strike ?? d.call_wall),
      put_wall:          convertFn(d.put_wall?.strike ?? d.put_wall),
      underlying_price:  convertFn(d.underlying_price),
      updatedAt:         cache.updatedAt
    };
  };

  const spyGex = formatGex(gexCache.SPY, 'ES (via SPY)', spyToES);
  const qqqGex = formatGex(gexCache.QQQ, 'NQ (via QQQ)', qqqToNQ);

  // Session Regime — combines GEX + VIX
  const vix = macroCache.data?.vix;
  const esPrice = priceCache.ES?.price;
  let sessionRegime = 'MIXED';
  let sessionRegimeDesc = '';

  if (spyGex && vix) {
    const gexPositive = (spyGex.net_gex_label || '').toLowerCase().includes('positive');
    const aboveFlip = spyGex.gamma_flip && esPrice ? esPrice > spyGex.gamma_flip : null;
    const betweenWalls = spyGex.call_wall && spyGex.put_wall && esPrice
      ? esPrice < spyGex.call_wall && esPrice > spyGex.put_wall : false;

    if (vix < 15 && gexPositive && betweenWalls) {
      sessionRegime = 'MEAN REVERSION';
      sessionRegimeDesc = 'Low VIX + Positive GEX + Price pinned between walls — fade extremes, buy dips sell highs, avoid breakouts';
    } else if (vix < 18 && gexPositive) {
      sessionRegime = 'MEAN REVERSION';
      sessionRegimeDesc = 'Low VIX + Positive GEX — range-bound environment, reversals favored over breakouts';
    } else if (vix > 25 || (!gexPositive && !betweenWalls)) {
      sessionRegime = 'TRENDING';
      sessionRegimeDesc = 'Elevated VIX or Negative GEX — momentum and trend following favored, avoid fading moves';
    } else if (vix > 20) {
      sessionRegime = 'HIGH VOL';
      sessionRegimeDesc = 'Elevated volatility — widen stops, reduce position size, trend following only';
    } else if (aboveFlip === false) {
      sessionRegime = 'CAUTION';
      sessionRegimeDesc = 'Price below gamma flip — dealer hedging amplifies moves, avoid mean reversion trades';
    } else {
      sessionRegime = 'MIXED';
      sessionRegimeDesc = 'Mixed signals — trade smaller, wait for cleaner setups';
    }
  }

  res.json({
    SPY: spyGex,
    QQQ: qqqGex,
    sessionRegime,
    sessionRegimeDesc,
    timestamp: new Date().toISOString()
  });
});

// ══ SUPPORT EMAIL via Resend ════════════════════════════════

app.post('/api/support', async (req, res) => {
  const { username, email, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'Email and message required' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    console.error('RESEND_API_KEY not set');
    return res.status(500).json({ error: 'Email service not configured' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Bias Terminal <onboarding@resend.dev>',
        to: ['support@alpha-bias.com'],
        reply_to: email,
        subject: `Support Request from ${username || email}`,
        html: `
          <div style="font-family:monospace;background:#0a0c0f;color:#e0e0e0;padding:24px;border-radius:8px;">
            <h2 style="color:#4a9eff;margin-bottom:16px;">New Support Request</h2>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="color:#778;padding:6px 0;width:120px;">Username</td><td style="color:#e0e0e0;">${username || '—'}</td></tr>
              <tr><td style="color:#778;padding:6px 0;">Email</td><td style="color:#e0e0e0;"><a href="mailto:${email}" style="color:#4a9eff;">${email}</a></td></tr>
              <tr><td style="color:#778;padding:6px 0;vertical-align:top;">Message</td><td style="color:#e0e0e0;white-space:pre-wrap;">${message}</td></tr>
              <tr><td style="color:#778;padding:6px 0;">Sent at</td><td style="color:#e0e0e0;">${new Date().toUTCString()}</td></tr>
            </table>
          </div>
        `
      })
    });

    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.message || 'Resend error');
    }

    res.json({ ok: true });
  } catch(e) {
    console.error('Support email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══ HEALTH ════════════════════════════════════════════════

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ══ CATCH-ALL → frontend ══════════════════════════════════

app.get('*', (req, res) => {
  const fs = require('fs');
  const p1 = path.join(__dirname, 'public', 'index.html');
  const p2 = path.join(__dirname, 'index.html');
  if (fs.existsSync(p1)) res.sendFile(p1);
  else if (fs.existsSync(p2)) res.sendFile(p2);
  else res.status(404).send('Not found. __dirname=' + __dirname + ' files=' + fs.readdirSync(__dirname).join(','));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bias Terminal v2 running on port ${PORT}`));
