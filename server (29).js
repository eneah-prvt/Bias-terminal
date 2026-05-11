const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
app.use(cors());

// Webhook needs raw body — must be before express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook error:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.user_id;
    if (userId) {
      await supabase.from('subscriptions').upsert({
        user_id: userId,
        stripe_subscription_id: session.subscription,
        stripe_customer_id: session.customer,
        status: 'active',
        created_at: new Date().toISOString()
      });
      console.log('Subscription activated for user:', userId);
    }
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const status = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : 'inactive';
    await supabase.from('subscriptions').update({ status }).eq('stripe_subscription_id', sub.id);
  }

  res.json({ received: true });
});

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
      fetchFredSeries('DGS2'),   // 2-Year Treasury yield from FRED (^IRX is 13-week T-bill, not 2yr)
      fetchYahoo('DX-Y.NYB'),
      fetchFredSeries('BAMLH0A0HYM2'),  // HY Spreads
      fetchFredSeries('INDPRO'),         // Industrial Production (Growth proxy)
      fetchFredSeries('CPIAUCSL'),       // CPI (Inflation proxy)
    ]);

    const t10 = t10raw ? +(t10raw).toFixed(3) : null;
    const t2  = t2raw  ? +(t2raw).toFixed(3) : null;  // DGS2 from FRED is already in % — no /10 needed
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
  // TFF (Traders in Financial Futures) - Socrata dataset gpe5-46if
  // ES = 13874+ (encoded as 13874%2B in URL), NQ = 209742
  // TFF field names are DIFFERENT from Legacy COT — must use TFF-specific fields:
  //   Leveraged Funds:  lev_money_positions_long_all / lev_money_positions_short_all
  //   Asset Managers:   asset_mgr_positions_long_all / asset_mgr_positions_short_all
  //   Other Reportable: oth_rept_positions_long_all  / oth_rept_positions_short_all
  //   Non-Reportable (Small Spec): nonrept_positions_long_all / nonrept_positions_short_all
  const url = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$where=report_date_as_yyyy_mm_dd>'2024-01-01' AND (cftc_contract_market_code='13874%2B' OR cftc_contract_market_code='209742')&$order=report_date_as_yyyy_mm_dd DESC&$limit=120`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
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
        // CORRECT TFF field names (NOT Legacy COT fields):
        leveragedFunds: { net: net('lev_money_positions_long_all','lev_money_positions_short_all'),   index: cotIndex('lev_money_positions_long_all','lev_money_positions_short_all') },
        assetManagers:  { net: net('asset_mgr_positions_long_all','asset_mgr_positions_short_all'),   index: cotIndex('asset_mgr_positions_long_all','asset_mgr_positions_short_all') },
        smallSpec:      { net: net('nonrept_positions_long_all','nonrept_positions_short_all'),        index: cotIndex('nonrept_positions_long_all','nonrept_positions_short_all') }
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

const MASSIVE_KEY = process.env.MASSIVE_API_KEY;

const priceCache = {
  ES: { price: null, prev_close: null, updatedAt: null },
  NQ: { price: null, prev_close: null, updatedAt: null }
};

// Yahoo Finance for ES/NQ futures fallback
async function fetchYahooFutures(symbol, cacheKey) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return;
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return;
    priceCache[cacheKey] = {
      price: meta.regularMarketPrice,
      prev_close: meta.previousClose,
      updatedAt: new Date().toISOString()
    };
    console.log(`Yahoo futures ${cacheKey}: ${priceCache[cacheKey].price}`);
  } catch(e) { console.warn(`Yahoo ${cacheKey} error:`, e.message); }
}

// Get active ES/NQ contract ticker (e.g. ESM5, NQM5)
function getActiveFuturesTicker(base) {
  const now = new Date();
  const month = now.getUTCMonth(); // 0-11
  const year = now.getUTCFullYear().toString().slice(-2); // 2-digit year: ESM25 not ESM5
  // Quarterly contracts: H(Mar=2), M(Jun=5), U(Sep=8), Z(Dec=11)
  let code;
  if (month < 3) code = 'H';
  else if (month < 6) code = 'M';
  else if (month < 9) code = 'U';
  else code = 'Z';
  return base + code + year; // e.g. ESM25
}

async function fetchMassiveFutures(base, cacheKey) {
  if (!MASSIVE_KEY) return false;
  try {
    const ticker = getActiveFuturesTicker(base);
    const url = `https://api.massive.com/v1/futures/snapshots/${ticker}`;
    const r = await fetch(url, { headers: { 'X-API-Key': MASSIVE_KEY } });
    if (!r.ok) { console.warn('Massive futures ' + ticker + ' HTTP ' + r.status); return false; }
    const d = await r.json();
    const price = d.last_trade?.price ?? d.last?.price ?? d.value ?? null;
    if (!price) return false;
    priceCache[cacheKey] = { price, prev_close: d.prev_day?.close ?? null, updatedAt: new Date().toISOString() };
    console.log('Massive ' + ticker + ': ' + price);
    return true;
  } catch(e) { console.warn('Massive futures error:', e.message); return false; }
}

async function fetchAllPrices() {
  // Try Massive for ES/NQ futures first (real-time, always on)
  const [esOk, nqOk] = await Promise.all([
    fetchMassiveFutures('ES', 'ES'),
    fetchMassiveFutures('NQ', 'NQ')
  ]);
  // Fallback to Yahoo if Massive fails
  if (!esOk) await fetchYahooFutures('ES=F', 'ES');
  if (!nqOk) await fetchYahooFutures('NQ=F', 'NQ');

  // Update ratio using ES/NQ price and FreeFlow SPY/QQQ spot
  if (gexCache.SPY?.data?.ff_spot) updateDailyRatio('SPY', gexCache.SPY.data.ff_spot);
  if (gexCache.QQQ?.data?.ff_spot) updateDailyRatio('QQQ', gexCache.QQQ.data.ff_spot);
  console.log('Ratios: SPY=' + dailyRatio.SPY.toFixed(4) + ' QQQ=' + dailyRatio.QQQ.toFixed(4));
}

// Refresh every minute
setInterval(async () => { await fetchAllPrices(); }, 60 * 1000);

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

const FF_KEY = process.env.FREEFLOW_API_KEY;

// ══ GEX CACHE — FreeFlow ══════════════════════════════════

const gexCache = {
  SPY: { data: null, updatedAt: null },
  QQQ: { data: null, updatedAt: null }
};

// Get nearest expiration date for symbol
// Cache last known expiration per symbol
const lastExp = { SPY: null, QQQ: null };

// Daily ratio — SPY to ES and QQQ to NQ
// Updated once per day at NY Open when both prices are fresh
// Historical ratios: ES/SPY ~10.07-10.10, NQ/QQQ ~41.2-41.4
const dailyRatio = { SPY: 10.085, QQQ: 41.30 };

function updateDailyRatio(symbol, ffSpot) {
  const futuresPrice = symbol === 'SPY' ? priceCache.ES?.price : priceCache.NQ?.price;
  if (!futuresPrice || !ffSpot || ffSpot <= 0) return;
  const newRatio = futuresPrice / ffSpot;
  const validSPY = newRatio > 9 && newRatio < 12;
  const validQQQ = newRatio > 38 && newRatio < 45;
  if (symbol === 'SPY' && validSPY) { dailyRatio.SPY = newRatio; }
  if (symbol === 'QQQ' && validQQQ) { dailyRatio.QQQ = newRatio; }
}

async function getExpiration(symbol) {
  try {
    const r = await fetch(`https://www.free-flow.site/public/expirations?symbol=${symbol}`, {
      headers: { 'X-API-Key': FF_KEY }
    });
    if (!r.ok) {
      console.warn(`Expirations ${symbol} HTTP ${r.status} — using cached: ${lastExp[symbol]}`);
      return lastExp[symbol];
    }
    const d = await r.json();
    console.log(`FreeFlow expirations ${symbol} raw:`, JSON.stringify(d).slice(0, 300));
    const exps = d.expirations || [];
    const today = new Date().toISOString().split('T')[0];
    // Use today's expiration (0DTE) — matches FreeFlow website default
    const exp = exps.find(e => e >= today) || exps[0] || null;
    if (exp) lastExp[symbol] = exp;
    return exp || lastExp[symbol];
  } catch(e) {
    console.warn(`Expirations ${symbol} error — using cached: ${lastExp[symbol]}`);
    return lastExp[symbol];
  }
}

async function fetchGEX(symbol) {
  if (!FF_KEY) { console.warn('FREEFLOW_API_KEY not set'); return null; }
  try {
    const exp = await getExpiration(symbol);
    if (!exp) { console.warn(`GEX ${symbol}: no expiration found`); return null; }

    const agParam = '';  // ag=on doesn't convert strikes reliably — using dynamic ratio instead

    const [wallsRes, snapRes] = await Promise.all([
      fetch(`https://www.free-flow.site/public/walls?symbol=${symbol}&exp=${exp}`, { headers: { 'X-API-Key': FF_KEY } }),
      fetch(`https://www.free-flow.site/public/snapshot?symbol=${symbol}&exp=${exp}`, { headers: { 'X-API-Key': FF_KEY } })
    ]);

    const walls = wallsRes.ok ? await wallsRes.json() : {};
    const snap  = snapRes.ok  ? await snapRes.json()  : {};

    const ffSpot = walls.spot ?? snap.spot;
    // Update daily ratio during market hours
    if (ffSpot) updateDailyRatio(symbol, ffSpot);
    const storedRatio = dailyRatio[symbol] || (symbol === 'SPY' ? 10.10 : 41.267);

    const result = {
      call_wall_raw:    walls.call_wall?.strike ?? null,
      put_wall_raw:     walls.put_wall?.strike  ?? null,
      gamma_flip_raw:   typeof walls.gamma_flip === 'number' ? walls.gamma_flip : walls.gamma_flip?.strike ?? null,
      net_gex:          snap.total_gex  ?? null,
      net_dex:          snap.total_dex  ?? null,
      net_vanna:        snap.total_dag  ?? null,
      net_ag:           snap.total_ag   ?? null,
      ff_spot:          ffSpot ?? null,
      stored_ratio:     storedRatio,
      net_gex_label:    null,
      expiration:       exp
    };

    if (result.net_gex !== null) {
      result.net_gex_label = result.net_gex > 0 ? 'positive' : 'negative';
    }

    gexCache[symbol] = { data: result, updatedAt: new Date().toISOString() };
    console.log('GEX ' + symbol + ' updated: ratio=' + storedRatio.toFixed(4) + ' flip=' + result.gamma_flip_raw + ' call=' + result.call_wall_raw + ' put=' + result.put_wall_raw);
    return result;
  } catch(e) {
    console.warn(`GEX ${symbol} error:`, e.message);
    return null;
  }
}

// Update GEX every minute always (weekdays only)
async function updateGEX() {
  const now = new Date();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (!isWeekday) return;
  await Promise.all([fetchGEX('SPY'), fetchGEX('QQQ')]);
}

// Fetch immediately on startup, then every minute
(async () => {
  const now = new Date();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (isWeekday) {
    console.log('Fetching GEX on startup...');
    await Promise.all([fetchGEX('SPY'), fetchGEX('QQQ')]);
  }
})();

setInterval(updateGEX, 60 * 1000);
console.log('FreeFlow GEX scheduler active: every minute on weekdays');

// ══ GEX ENDPOINT (serves cached data) ═════════════════════

// Dynamic SPY→ES conversion using live prices
// Convert at API call time using FreeFlow spot (always current, fetched every minute)
app.get('/api/gex', requireAuth, requireSubscription, (req, res) => {
  const formatGex = (cache, symbol) => {
    if (!cache.data) return null;
    const d = cache.data;

    // Use stored_ratio from when GEX was fetched — calculated during market hours
    // Falls back to dailyRatio which is updated every minute during NY session
    const ratio = d.stored_ratio || dailyRatio[symbol] || (symbol === 'SPY' ? 10.085 : 41.30);
    const conv = (v) => v !== null && v !== undefined ? +(v * ratio).toFixed(2) : null;

    return {
      symbol,
      net_gex:           d.net_gex ?? null,
      net_dex:           d.net_dex ?? null,
      net_vanna:         d.net_vanna ?? null,
      net_gex_label:     d.net_gex_label ?? null,
      gamma_flip:        conv(d.gamma_flip_raw),
      call_wall:         conv(d.call_wall_raw),
      put_wall:          conv(d.put_wall_raw),
      underlying_price:  d.ff_spot ? conv(d.ff_spot) : null,
      expiration:        d.expiration,
      updatedAt:         cache.updatedAt
    };
  };

  const spyGex = formatGex(gexCache.SPY, 'ES (via SPY)');
  const qqqGex = formatGex(gexCache.QQQ, 'NQ (via QQQ)');

  // Session Regime — combines GEX + VIX
  const vix = macroCache.data?.vix;
  const esPrice = priceCache.ES?.price;
  let sessionRegime = 'MIXED';
  let sessionRegimeDesc = '';

  if (spyGex && vix) {
    const gexPositive = spyGex.net_gex_label === 'positive';
    const aboveFlip = spyGex.gamma_flip && esPrice ? esPrice > spyGex.gamma_flip : null;
    const betweenWalls = spyGex.call_wall && spyGex.put_wall && esPrice
      ? esPrice < spyGex.call_wall && esPrice > spyGex.put_wall : false;

    if (vix < 15 && gexPositive && betweenWalls) {
      sessionRegime = 'MEAN REVERSION';
      sessionRegimeDesc = 'Low VIX + Positive GEX + Price pinned between walls — fade extremes, buy dips sell highs';
    } else if (vix < 18 && gexPositive) {
      sessionRegime = 'MEAN REVERSION';
      sessionRegimeDesc = 'Low VIX + Positive GEX — range-bound environment, reversals favored';
    } else if (!gexPositive && !betweenWalls) {
      sessionRegime = 'TRENDING';
      sessionRegimeDesc = 'Negative GEX — momentum and trend following favored, avoid fading moves';
    } else if (vix > 25) {
      sessionRegime = 'HIGH VOL';
      sessionRegimeDesc = 'Elevated volatility — widen stops, reduce size, trend following only';
    } else if (aboveFlip === false) {
      sessionRegime = 'CAUTION';
      sessionRegimeDesc = 'Price below gamma flip — dealer hedging amplifies moves, avoid mean reversion';
    } else {
      sessionRegime = 'MIXED';
      sessionRegimeDesc = 'Mixed signals — trade smaller, wait for cleaner setups';
    }
  }

  res.json({ SPY: spyGex, QQQ: qqqGex, sessionRegime, sessionRegimeDesc, timestamp: new Date().toISOString() });
});

// ══ GEX DEBUG ═════════════════════════════════════════════
app.get('/api/gex/raw', async (req, res) => {
  if (!FF_KEY) return res.json({ error: 'No key' });
  try {
    const expR = await fetch('https://www.free-flow.site/public/expirations?symbol=SPY', { headers: { 'X-API-Key': FF_KEY } });
    const expD = await expR.json();
    const exps = (expD.expirations || []).slice(0, 5);

    // Test first 3 expirations to see which matches FreeFlow website
    const results = {};
    for (const exp of exps.slice(0, 3)) {
      const r = await fetch(`https://www.free-flow.site/public/walls?symbol=SPY&exp=${exp}`, { headers: { 'X-API-Key': FF_KEY } });
      const d = r.ok ? await r.json() : { error: r.status };
      results[exp] = { call: d.call_wall?.strike, put: d.put_wall?.strike, flip: d.gamma_flip, spot: d.spot };
    }
    res.json({ expirations: exps, walls_by_exp: results, current_ratios: dailyRatio });
  } catch(e) { res.json({ error: e.message }); }
});

// ══ SUPPORT EMAIL via Resend ════════════════════════════════

app.post('/api/support', async (req, res) => {
  const { username, email, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'Email and message required' });
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Email service not configured' });
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Bias Terminal <onboarding@resend.dev>',
        to: ['support@alpha-bias.com'],
        reply_to: email,
        subject: `Support Request from ${username || email}`,
        html: `<div style="font-family:monospace;padding:24px;"><h2>New Support Request</h2><p><b>Username:</b> ${username || '—'}</p><p><b>Email:</b> ${email}</p><p><b>Message:</b><br>${message}</p><p><b>Sent:</b> ${new Date().toUTCString()}</p></div>`
      })
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.message || 'Resend error'); }
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
