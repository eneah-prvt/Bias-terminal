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
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID;       // your monthly price ID
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;  // service role key (server only)
const APP_URL      = process.env.APP_URL || 'http://localhost:3000';

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
