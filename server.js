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
      subscription_data: {
        trial_period_days: 3,
        metadata: { user_id: user.id }
      },
      payment_method_collection: 'always',
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

// ══ FRED MACRO DATA (protected) ════════════════════════════

app.get('/api/macro', requireAuth, requireSubscription, async (req, res) => {
  if (!FRED_KEY) return res.status(500).json({ error: 'FRED_API_KEY not configured' });
  const series = { t10: 'DGS10', t2: 'DGS2', vix: 'VIXCLS', dxy: 'DTWEXBGS', hy: 'BAMLH0A0HYM2' };
  try {
    const results = await Promise.all(
      Object.entries(series).map(async ([key, id]) => {
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`;
        const r = await fetch(url);
        const d = await r.json();
        const obs = (d.observations || []).find(o => o.value !== '.');
        return [key, obs ? parseFloat(obs.value) : null];
      })
    );
    const data = Object.fromEntries(results);
    data.yc = (data.t10 !== null && data.t2 !== null) ? +(data.t10 - data.t2).toFixed(3) : null;
    data.timestamp = new Date().toISOString();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══ CFTC COT DATA (protected) ══════════════════════════════

app.get('/api/cot', requireAuth, requireSubscription, async (req, res) => {
  const url = `https://publicreporting.cftc.gov/api/odata/v1/HistoricalViewByReportType?$filter=report_date_as_yyyy_mm_dd%20gt%20%272024-01-01%27%20and%20(cftc_contract_market_code%20eq%20%2713874%2B%27%20or%20cftc_contract_market_code%20eq%20%27209742%27)&$orderby=report_date_as_yyyy_mm_dd%20desc&$top=120&$format=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('CFTC HTTP ' + r.status);
    const d = await r.json();
    const rows = d.value || [];

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
    res.json({ ES: processInstrument('13874+','S&P 500 E-mini'), NQ: processInstrument('209742','NASDAQ 100 E-mini'), timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Refresh prices every 5 minutes during market hours
setInterval(async () => {
  const now = new Date();
  const h = now.getUTCHours();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (isWeekday && h >= 13 && h < 22) await fetchAllPrices();
}, 5 * 60 * 1000);

// Fetch on startup
(async () => { await fetchAllPrices(); })();

// ══ PRICE ENDPOINT ═════════════════════════════════════════

app.get('/api/prices', requireAuth, requireSubscription, (req, res) => {
  res.json({ ES: priceCache.ES, NQ: priceCache.NQ, timestamp: new Date().toISOString() });
});

// ══ GEX CACHE (server-side, shared for all users) ══════════

const gexCache = {
  SPY: { data: null, updatedAt: null },
  QQQ: { data: null, updatedAt: null }
};

async function fetchGEX(symbol) {
  if (!FLASHALPHA_KEY) return null;
  try {
    const r = await fetch(`https://lab.flashalpha.com/v1/exposure/gex/${symbol}`, {
      headers: { 'X-Api-Key': FLASHALPHA_KEY }
    });
    if (!r.ok) { console.warn(`GEX ${symbol} failed: HTTP ${r.status}`); return null; }
    const d = await r.json();
    gexCache[symbol] = { data: d, updatedAt: new Date().toISOString() };
    console.log(`GEX ${symbol} updated at ${gexCache[symbol].updatedAt}`);
    return d;
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

function scheduleGEX() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const timeMin = h * 60 + m;

  // NY Open: 13:30 UTC — SPY + QQQ
  const nyOpen   = 13 * 60 + 30;
  // Mid:     15:00 UTC — SPY + QQQ
  const nyMid    = 15 * 60 + 0;
  // Late:    17:30 UTC — QQQ only
  const nyLate   = 17 * 60 + 30;

  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (!isWeekday) return;

  if (timeMin === nyOpen)       { fetchGEX('SPY'); fetchGEX('QQQ'); }
  else if (timeMin === nyMid)   { fetchGEX('SPY'); fetchGEX('QQQ'); }
  else if (timeMin === nyLate)  { fetchGEX('QQQ'); }
}

// Check every minute
setInterval(scheduleGEX, 60 * 1000);

// On server start — if within NY session, fetch immediately
(async () => {
  const now = new Date();
  const h = now.getUTCHours();
  const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (isWeekday && h >= 13 && h < 22) {
    console.log('Server start within NY session — fetching GEX...');
    await fetchGEX('SPY');
    await fetchGEX('QQQ');
  }
})();

// ══ GEX ENDPOINT (serves cached data) ═════════════════════

app.get('/api/gex', requireAuth, requireSubscription, (req, res) => {
  res.json({
    SPY: gexCache.SPY.data ? {
      symbol: 'SPY',
      net_gex: gexCache.SPY.data.net_gex,
      net_gex_label: gexCache.SPY.data.net_gex_label,
      gamma_flip: gexCache.SPY.data.gamma_flip,
      call_wall: gexCache.SPY.data.call_wall,
      put_wall: gexCache.SPY.data.put_wall,
      underlying_price: gexCache.SPY.data.underlying_price,
      updatedAt: gexCache.SPY.updatedAt
    } : null,
    QQQ: gexCache.QQQ.data ? {
      symbol: 'QQQ',
      net_gex: gexCache.QQQ.data.net_gex,
      net_gex_label: gexCache.QQQ.data.net_gex_label,
      gamma_flip: gexCache.QQQ.data.gamma_flip,
      call_wall: gexCache.QQQ.data.call_wall,
      put_wall: gexCache.QQQ.data.put_wall,
      underlying_price: gexCache.QQQ.data.underlying_price,
      updatedAt: gexCache.QQQ.updatedAt
    } : null,
    timestamp: new Date().toISOString()
  });
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
