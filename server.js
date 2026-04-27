const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FRED_KEY = process.env.FRED_API_KEY;

// ── FRED Proxy ────────────────────────────────────────────
app.get('/api/fred/:series', async (req, res) => {
  if (!FRED_KEY) return res.status(500).json({ error: 'FRED_API_KEY not configured' });
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${req.params.series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).find(o => o.value !== '.');
    res.json({ value: obs ? parseFloat(obs.value) : null, date: obs?.date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FRED Bulk (all macro at once) ─────────────────────────
app.get('/api/macro', async (req, res) => {
  if (!FRED_KEY) return res.status(500).json({ error: 'FRED_API_KEY not configured on server' });
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

// ── CFTC COT Proxy ────────────────────────────────────────
app.get('/api/cot', async (req, res) => {
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

      const net = (long, short) => {
        const l = parseFloat(latest[long] || 0);
        const s = parseFloat(latest[short] || 0);
        return Math.round(l - s);
      };

      const cotIndex = (longField, shortField) => {
        const vals = history.map(h => parseFloat(h[longField] || 0) - parseFloat(h[shortField] || 0));
        const mn = Math.min(...vals), mx = Math.max(...vals), cur = vals[0];
        if (mx === mn) return 50;
        return Math.round((cur - mn) / (mx - mn) * 100);
      };

      return {
        name,
        date: latest.report_date_as_yyyy_mm_dd,
        leveragedFunds: {
          net: net('noncomm_positions_long_all', 'noncomm_positions_short_all'),
          index: cotIndex('noncomm_positions_long_all', 'noncomm_positions_short_all')
        },
        assetManagers: {
          net: net('comm_positions_long_all', 'comm_positions_short_all'),
          index: cotIndex('comm_positions_long_all', 'comm_positions_short_all')
        },
        smallSpec: {
          net: net('nonrept_positions_long_all', 'nonrept_positions_short_all'),
          index: cotIndex('nonrept_positions_long_all', 'nonrept_positions_short_all')
        },
        openInterest: parseInt(latest.open_interest_all || 0)
      };
    };

    res.json({
      ES: processInstrument('13874+', 'S&P 500 E-mini'),
      NQ: processInstrument('209742', 'NASDAQ 100 E-mini'),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, fredKeySet: !!FRED_KEY, time: new Date().toISOString() });
});

// ── Serve frontend for all other routes ──────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bias Terminal running on port ${PORT}`));
