process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const app     = express();
app.use(express.json());

const KONTO_MITTEL = {
  apiKey:   process.env.API_KEY,
  email:    process.env.EMAIL,
  password: process.env.PASSWORD,
  baseUrl:  process.env.BASE_URL,
  cst:      null,
  token:    null
};

const KONTO_AGGRESSIV = {
  apiKey:   process.env.API_KEY_AGGRESSIV,
  email:    process.env.EMAIL_AGGRESSIV,
  password: process.env.PASSWORD_AGGRESSIV,
  baseUrl:  process.env.BASE_URL,
  cst:      null,
  token:    null
};

const KONTO_GOLDGLOBE = {
  apiKey:   process.env.API_KEY_GOLDGLOBE,
  email:    process.env.EMAIL_GOLDGLOBE,
  password: process.env.PASSWORD_GOLDGLOBE,
  baseUrl:  process.env.BASE_URL,
  cst:      null,
  token:    null
};

const KONTO_TEST = {
  apiKey:   process.env.API_KEY_TEST,
  email:    process.env.EMAIL_TEST,
  password: process.env.PASSWORD_TEST,
  baseUrl:  process.env.BASE_URL,
  cst:      null,
  token:    null
};

const STRATEGIEN = {
  mittel: {
    konto:          KONTO_MITTEL,
    epic:           'GOLD',
    riskPct:        2.7,
    reservePct:     100,
    leverage:       10,
    maxDrawdownPct: 20,
    startEquity:    1000
  },
  aggressiv: {
    konto:          KONTO_AGGRESSIV,
    epic:           'GOLD',
    riskPct:        3.7,
    reservePct:     100,
    leverage:       10,
    maxDrawdownPct: 30,
    startEquity:    1000
  },
  goldglobe: {
    konto:          KONTO_GOLDGLOBE,
    epic:           'GOLD',
    riskPct:        1.7,
    reservePct:     100,
    leverage:       10,
    maxDrawdownPct: 20,
    startEquity:    1000
  },
  test: {
    konto:          KONTO_TEST,
    epic:           'GOLD',
    riskPct:        1.0,
    reservePct:     100,
    leverage:       10,
    maxDrawdownPct: 50,
    startEquity:    1000
  }
};

let performance = {
  mittel:     { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
  aggressiv:  { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
  goldglobe:  { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
  test:       { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 }
};

let letzteEquity         = { mittel: 1000, aggressiv: 1000, goldglobe: 1000, test: 1000 };
let letzteAktualisierung = new Date().toISOString();

// ── Equity Kurve ──────────────────────────────────────
const EQUITY_FILE = '/data/equity.json';

function ladeEquityDaten() {
  try {
    if (fs.existsSync(EQUITY_FILE)) {
      return JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('❌ Equity Datei laden fehlgeschlagen:', err.message);
  }
  return { mittel: [], aggressiv: [], goldglobe: [], test: [] };
}

function speichereEquityDaten(daten) {
  try {
    fs.writeFileSync(EQUITY_FILE, JSON.stringify(daten, null, 2));
  } catch (err) {
    console.error('❌ Equity Datei speichern fehlgeschlagen:', err.message);
  }
}

let equityVerlauf = ladeEquityDaten();

function equityPunktHinzufuegen(strategieName, equity) {
  if (!equityVerlauf[strategieName]) equityVerlauf[strategieName] = [];
  equityVerlauf[strategieName].push({ datum: new Date().toISOString(), equity: parseFloat(equity) });
  speichereEquityDaten(equityVerlauf);
}

// ── Trade Historie ────────────────────────────────────
const TRADES_FILE = '/data/trades.json';

function ladeTradeDaten() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch (err) { console.error('❌ Trades laden:', err.message); }
  return { mittel: [], aggressiv: [], goldglobe: [], test: [] };
}

function speichereTradeDaten(daten) {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(daten, null, 2)); }
  catch (err) { console.error('❌ Trades speichern:', err.message); }
}

let tradeVerlauf = ladeTradeDaten();

function tradeHinzufuegen(strategieName, trade) {
  if (!tradeVerlauf[strategieName]) tradeVerlauf[strategieName] = [];
  tradeVerlauf[strategieName].push(trade);
  speichereTradeDaten(tradeVerlauf);
  console.log(`📝 Trade gespeichert [${strategieName}]: PnL ${trade.pnl > 0 ? '+' : ''}${trade.pnl}€`);
}

// ── Login ─────────────────────────────────────────────
async function login(konto) {
  const res = await axios.post(`${konto.baseUrl}/session`, {
    identifier: konto.email,
    password:   konto.password
  }, { headers: { 'X-CAP-API-KEY': konto.apiKey } });
  konto.cst   = res.headers['cst'];
  konto.token = res.headers['x-security-token'];
  console.log(`✅ Login erfolgreich: ${konto.email}`);
}

// ── Equity holen ──────────────────────────────────────
// Capital.com balance: { balance (kontostand), deposit, profitLoss (floating), available (freie Margin) }
// balance.balance = echter Kontostand (wie auf Capital.com angezeigt)
async function getEquity(konto) {
  try {
    const res = await axios.get(`${konto.baseUrl}/accounts`, {
      headers: {
        'X-CAP-API-KEY':    konto.apiKey,
        'CST':              konto.cst,
        'X-SECURITY-TOKEN': konto.token
      }
    });
    const account = res.data.accounts[0];
    const bal     = account?.balance;
    const equity  = bal?.balance ?? bal?.available ?? bal;
    console.log(`💰 Equity (${konto.email}): ${equity}€ | available: ${bal?.available} | profitLoss: ${bal?.profitLoss}`);
    return equity;
  } catch (err) {
    if (err.response?.status === 401) {
      await login(konto);
      return getEquity(konto);
    }
    throw err;
  }
}

// ── Trades von Capital.com holen ─────────────────────
async function getClosedTrades(konto, von, bis) {
  const fromDate = von ? new Date(von) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate   = bis ? new Date(bis) : new Date();

  // Capital.com erwartet ISO-Format: "2026-03-29T00:00:00"
  const params = {
    from:              fromDate.toISOString().slice(0, 19),
    to:                toDate.toISOString().slice(0, 19),
    lastNumberOfItems: 500,
    detailed:          true
  };

  console.log(`📋 History Params:`, params);
  const res = await axios.get(`${konto.baseUrl}/history/activity`, {
    headers: {
      'X-CAP-API-KEY':    konto.apiKey,
      'CST':              konto.cst,
      'X-SECURITY-TOKEN': konto.token
    },
    params
  });

  const alle = res.data.activityHistory || res.data.activities || (Array.isArray(res.data) ? res.data : []);
  console.log(`📋 Capital.com History: ${alle.length} Einträge, Response-Keys: ${Object.keys(res.data).join(', ')}`);
  if (alle.length > 0) console.log('📋 Erster Eintrag:', JSON.stringify(alle[0]).slice(0, 400));
  return alle;
}

// ── Drawdown prüfen ───────────────────────────────────
function checkDrawdown(equity, strategie, strategieName) {
  if (performance[strategieName].trades === 0) return false;
  const drawdown = ((strategie.startEquity - equity) / strategie.startEquity) * 100;
  console.log(`📉 [${strategieName}] Drawdown: ${drawdown.toFixed(2)}%`);
  return drawdown >= strategie.maxDrawdownPct;
}

// ── Positionsgröße berechnen ──────────────────────────
function calcSize(equity, sl, tp, strategie) {
  const riskCapital = equity * (strategie.riskPct / 100) * strategie.leverage;
  const slDistance  = Math.abs(parseFloat(tp) - parseFloat(sl));
  let size          = riskCapital / slDistance;
  const maxSize     = (equity * strategie.leverage) / parseFloat(sl);
  size              = Math.min(size, maxSize);
  return Math.max(1, parseFloat(size.toFixed(1)));
}

// ── Performance updaten ───────────────────────────────
function updatePerformance(strategieName, pnl) {
  const p = performance[strategieName];
  p.trades++;
  p.gesamtPnL += pnl;
  if (pnl > 0) p.gewinn++;
  else p.verlust++;
  if (pnl > p.bestesTrade) p.bestesTrade = pnl;
  if (pnl < p.schlechtestesTrade) p.schlechtestesTrade = pnl;
  letzteAktualisierung = new Date().toISOString();
}

// ── Telegram ──────────────────────────────────────────
async function sendTelegram(nachricht) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id:    process.env.TELEGRAM_CHAT_ID,
      text:       nachricht,
      parse_mode: 'HTML'
    });
    console.log('📱 Telegram Nachricht gesendet');
  } catch (err) {
    console.error('❌ Telegram Fehler:', err.message);
  }
}

// ── Webhook Handler ───────────────────────────────────
async function handleWebhook(req, res, strategieName) {
  console.log(`📨 Signal [${strategieName}]:`, req.body);
  const { side, sl, tp } = req.body;

  if (!side || !sl || !tp) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }

  const strategie = STRATEGIEN[strategieName];
  const konto     = strategie.konto;

  try {
    if (!konto.cst) await login(konto);

    const equity = await getEquity(konto);

    if (checkDrawdown(equity, strategie, strategieName)) {
      console.log(`🛑 [${strategieName}] Max. Drawdown erreicht!`);
      await sendTelegram(`🛑 <b>Bot gestoppt!</b>\nStrategie: <b>${strategieName}</b>\nMax. Drawdown erreicht!`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown erreicht' });
    }

    const pnl = equity - letzteEquity[strategieName];
    if (pnl !== 0) {
      updatePerformance(strategieName, pnl);
      tradeHinzufuegen(strategieName, {
        datum:  new Date().toISOString(),
        pnl:    parseFloat(pnl.toFixed(2)),
        equity: parseFloat(equity.toFixed(2)),
        seite:  side,
        sl:     parseFloat(sl),
        tp:     parseFloat(tp)
      });
    }
    letzteEquity[strategieName] = equity;
    equityPunktHinzufuegen(strategieName, equity);

    const size  = calcSize(equity, sl, tp, strategie);
    const order = {
      epic:           strategie.epic,
      direction:      side,
      size:           size,
      guaranteedStop: false,
      stopLevel:      parseFloat(sl),
      profitLevel:    parseFloat(tp)
    };

    console.log(`📤 [${strategieName}] Order:`, order);

    await axios.post(`${konto.baseUrl}/positions`, order, {
      headers: {
        'X-CAP-API-KEY':    konto.apiKey,
        'CST':              konto.cst,
        'X-SECURITY-TOKEN': konto.token
      }
    });

    console.log(`✅ [${strategieName}] Order platziert`);

    await sendTelegram(
      `${side === 'BUY' ? '🟢' : '🔴'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'} eröffnet</b>\n` +
      `Strategie: <b>${strategieName}</b>\n` +
      `Größe: <b>${size} Units</b>\n` +
      `SL: <b>${sl}$</b>\n` +
      `TP: <b>${tp}$</b>`
    );

    res.json({ status: 'ok', strategie: strategieName, size });

  } catch (err) {
    if (err.response?.status === 401) {
      konto.cst = null;
      await login(konto);
      return res.status(500).json({ error: 'Session erneuert' });
    }
    console.error(`❌ Fehler:`, err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Webhook Routen ────────────────────────────────────
app.post('/webhook/mittel',     (req, res) => handleWebhook(req, res, 'mittel'));
app.post('/webhook/aggressiv',  (req, res) => handleWebhook(req, res, 'aggressiv'));
app.post('/webhook/goldglobe',  (req, res) => handleWebhook(req, res, 'goldglobe'));
app.post('/webhook/test',       (req, res) => handleWebhook(req, res, 'test'));

// ── Offene Position holen ─────────────────────────────
async function getOpenPosition(konto, epic) {
  const res = await axios.get(`${konto.baseUrl}/positions`, {
    headers: {
      'X-CAP-API-KEY':    konto.apiKey,
      'CST':              konto.cst,
      'X-SECURITY-TOKEN': konto.token
    }
  });
  const positions = res.data.positions || [];
  return positions.find(p => p.market.epic === epic) || null;
}

// ── SL Update Route ───────────────────────────────────
app.post('/webhook/update_sl/:strategie', async (req, res) => {
  const strategieName = req.params.strategie;
  const { action, sl } = req.body;

  if (action !== 'UPDATE_SL' || !sl) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }

  const strategie = STRATEGIEN[strategieName];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });

  const konto = strategie.konto;

  try {
    if (!konto.cst) await login(konto);

    const position = await getOpenPosition(konto, strategie.epic);
    if (!position) return res.json({ status: 'keine Position offen' });

    await axios.put(`${konto.baseUrl}/positions/${position.position.dealId}`, {
      stopLevel: parseFloat(sl)
    }, {
      headers: {
        'X-CAP-API-KEY':    konto.apiKey,
        'CST':              konto.cst,
        'X-SECURITY-TOKEN': konto.token
      }
    });

    await sendTelegram(`🔄 <b>SL aktualisiert</b>\nStrategie: <b>${strategieName}</b>\nNeuer SL: <b>${sl}$</b>`);
    res.json({ status: 'ok', neuerSL: sl });

  } catch (err) {
    if (err.response?.status === 401) {
      konto.cst = null;
      await login(konto);
      return res.status(500).json({ error: 'Session erneuert' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Performance API ───────────────────────────────────
app.get('/api/performance', async (req, res) => {
  async function tryEquity(konto) {
    try {
      if (!konto.cst) await login(konto);
      return await getEquity(konto);
    } catch (err) {
      console.error(`❌ Equity Fehler (${konto.email}):`, err.message);
      return null;
    }
  }

  function buildStats(name, strat, equity) {
    const p  = performance[name];
    const dd = equity != null && p.trades > 0
      ? (((strat.startEquity - equity) / strat.startEquity) * 100).toFixed(2)
      : '0.00';
    return {
      ...p,
      aktuellesEquity: equity,
      gesamtPnL:       p.gesamtPnL.toFixed(2),
      drawdown:        dd,
      winRate:         p.trades > 0 ? ((p.gewinn / p.trades) * 100).toFixed(1) : '0'
    };
  }

  const [equityMittel, equityAggressiv, equityGoldglobe, equityTest] = await Promise.all([
    tryEquity(KONTO_MITTEL),
    tryEquity(KONTO_AGGRESSIV),
    tryEquity(KONTO_GOLDGLOBE),
    tryEquity(KONTO_TEST)
  ]);

  res.json({
    letzteAktualisierung,
    mittel:    buildStats('mittel',    STRATEGIEN.mittel,    equityMittel),
    aggressiv: buildStats('aggressiv', STRATEGIEN.aggressiv, equityAggressiv),
    goldglobe: buildStats('goldglobe', STRATEGIEN.goldglobe, equityGoldglobe),
    test:      buildStats('test',      STRATEGIEN.test,      equityTest)
  });
});

// ── Equity API (legacy) ───────────────────────────────
app.get('/api/equity', (req, res) => {
  res.json(equityVerlauf);
});

// ── Trades API ────────────────────────────────────────
app.get('/api/trades/:strategie', (req, res) => {
  const strategieName = req.params.strategie;
  if (!STRATEGIEN[strategieName]) return res.status(400).json({ error: 'Unbekannte Strategie' });

  const { datum } = req.query; // Optional: ?datum=2026-04-28
  let trades = tradeVerlauf[strategieName] || [];

  if (datum) {
    trades = trades.filter(t => t.datum.startsWith(datum));
  }

  const gesamtPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const gewinn    = trades.filter(t => t.pnl > 0).length;
  res.json({ strategie: strategieName, datum: datum || 'alle', trades, count: trades.length, gesamtPnL: parseFloat(gesamtPnL.toFixed(2)), gewinn, verlust: trades.length - gewinn });
});

// ── Reset ─────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  performance = {
    mittel:    { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
    aggressiv: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
    goldglobe: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
    test:      { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 }
  };
  letzteEquity = { mittel: 1000, aggressiv: 1000, goldglobe: 1000, test: 1000 };
  letzteAktualisierung = new Date().toISOString();
  res.json({ status: 'ok' });
});

// ── Einzahlung ────────────────────────────────────────
app.get('/api/einzahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  if (strategie === 'mittel' || strategie === 'beide') {
    STRATEGIEN.mittel.startEquity    += betrag;
    letzteEquity.mittel              += betrag;
    performance.mittel.startEquity   += betrag;
  }
  if (strategie === 'aggressiv' || strategie === 'beide') {
    STRATEGIEN.aggressiv.startEquity  += betrag;
    letzteEquity.aggressiv            += betrag;
    performance.aggressiv.startEquity += betrag;
  }
  sendTelegram(`💰 <b>Einzahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

// ── Auszahlung ────────────────────────────────────────
app.get('/api/auszahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  if (strategie === 'mittel' || strategie === 'beide') {
    STRATEGIEN.mittel.startEquity    -= betrag;
    letzteEquity.mittel              -= betrag;
    performance.mittel.startEquity   -= betrag;
  }
  if (strategie === 'aggressiv' || strategie === 'beide') {
    STRATEGIEN.aggressiv.startEquity  -= betrag;
    letzteEquity.aggressiv            -= betrag;
    performance.aggressiv.startEquity -= betrag;
  }
  sendTelegram(`💸 <b>Auszahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

// ── Test ──────────────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    if (!KONTO_MITTEL.cst)    await login(KONTO_MITTEL);
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const equityMittel    = await getEquity(KONTO_MITTEL);
    const equityAggressiv = await getEquity(KONTO_AGGRESSIV);
    res.json({ status: '✅ Beide Konten verbunden', equityMittel: equityMittel + '€', equityAggressiv: equityAggressiv + '€' });
  } catch (err) {
    res.json({ status: '❌ Fehler', fehler: err.message });
  }
});

// ── Test Trade ────────────────────────────────────────
app.get('/test/trade', async (req, res) => {
  try {
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const equity    = await getEquity(KONTO_AGGRESSIV);
    const marketRes = await axios.get(`${KONTO_AGGRESSIV.baseUrl}/markets/GOLD`, {
      headers: { 'X-CAP-API-KEY': KONTO_AGGRESSIV.apiKey, 'CST': KONTO_AGGRESSIV.cst, 'X-SECURITY-TOKEN': KONTO_AGGRESSIV.token }
    });
    const currentPrice = marketRes.data.snapshot.offer;
    const sl   = (currentPrice * 0.99).toFixed(2);
    const tp   = (currentPrice * 1.02).toFixed(2);
    const size = calcSize(equity, sl, tp, STRATEGIEN.aggressiv);
    await axios.post(`${KONTO_AGGRESSIV.baseUrl}/positions`, {
      epic: 'GOLD', direction: 'BUY', size, guaranteedStop: false, stopLevel: parseFloat(sl), profitLevel: parseFloat(tp)
    }, {
      headers: { 'X-CAP-API-KEY': KONTO_AGGRESSIV.apiKey, 'CST': KONTO_AGGRESSIV.cst, 'X-SECURITY-TOKEN': KONTO_AGGRESSIV.token }
    });
    await sendTelegram(`🟢 <b>TEST LONG eröffnet</b>\nGröße: <b>${size} Units</b>\nSL: <b>${sl}$</b>\nTP: <b>${tp}$</b>`);
    res.json({ status: '✅ Test Trade platziert!', size, sl, tp });
  } catch (err) {
    res.json({ fehler: err.response?.data || err.message });
  }
});

// ── Dashboard ─────────────────────────────────────────
app.get('/dashboard', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,sans-serif; background:#0f0f0f; color:#fff; padding:24px; }
h1 { font-size:24px; font-weight:600; margin-bottom:6px; }
.subtitle { color:#666; font-size:14px; margin-bottom:28px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }
.card { background:#1a1a1a; border-radius:12px; padding:22px; border:1px solid #222; cursor:pointer; transition:border-color .15s, box-shadow .15s; }
.card:hover { border-color:#444; box-shadow:0 0 0 1px #333; }
.card h2 { font-size:12px; color:#666; margin-bottom:14px; text-transform:uppercase; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center; }
.card h2 span.hint { font-size:10px; color:#333; text-transform:none; letter-spacing:0; }
.equity { font-size:32px; font-weight:700; margin-bottom:14px; }
.stat { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #1e1e1e; }
.stat:last-of-type { border-bottom:none; }
.stat-label { color:#666; font-size:13px; }
.stat-value { font-size:13px; font-weight:600; }
.pos { color:#22c55e; } .neg { color:#ef4444; }
.tag { display:inline-block; padding:3px 9px; border-radius:20px; font-size:11px; font-weight:700; }
.tag-mittel { background:#1e3a5f; color:#60a5fa; }
.tag-aggressiv { background:#3b1f00; color:#fb923c; }
.tag-test { background:#1a3a1a; color:#4ade80; }
.btn { padding:9px 18px; border-radius:8px; border:none; cursor:pointer; font-size:13px; font-weight:600; margin-right:8px; }
/* Modal */
.overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:200; align-items:center; justify-content:center; padding:16px; }
.overlay.on { display:flex; }
.modal { background:#161616; border:1px solid #2a2a2a; border-radius:16px; width:100%; max-width:680px; max-height:88vh; overflow-y:auto; padding:26px; }
.modal-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; }
.modal-top h2 { font-size:17px; font-weight:600; }
.modal-close { background:#222; border:none; color:#777; font-size:18px; padding:3px 10px; border-radius:7px; cursor:pointer; }
.modal-close:hover { color:#fff; }
.date-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:18px; }
.date-bar input { background:#222; border:1px solid #333; color:#fff; padding:7px 11px; border-radius:8px; font-size:13px; }
.date-bar button { background:#262626; border:1px solid #333; color:#aaa; padding:7px 13px; border-radius:8px; font-size:12px; cursor:pointer; }
.date-bar button:hover { color:#fff; border-color:#555; }
.summary { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:18px; }
.sbox { background:#1e1e1e; border-radius:10px; padding:14px; text-align:center; }
.sbox .v { font-size:20px; font-weight:700; }
.sbox .l { font-size:11px; color:#555; margin-top:3px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { color:#444; font-weight:500; padding:7px 8px; text-align:left; border-bottom:1px solid #222; }
td { padding:9px 8px; border-bottom:1px solid #1a1a1a; vertical-align:middle; }
tr:last-child td { border:none; }
.badge { display:inline-block; padding:2px 7px; border-radius:20px; font-size:11px; font-weight:700; }
.buy-b { background:#1a3a1a; color:#4ade80; }
.sell-b { background:#3a1a1a; color:#ef4444; }
.empty { text-align:center; padding:36px; color:#333; font-size:14px; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
</head>
<body>
<h1>Trading Bot Dashboard</h1>
<p class="subtitle" id="updatezeit">Wird geladen...</p>

<div class="card" style="margin-bottom:16px;cursor:default">
  <h2>Equity Kurve — Test 1M</h2>
  <canvas id="equityChart" height="75"></canvas>
</div>

<div class="grid2">
  <div class="card" onclick="openModal('mittel')">
    <h2><span class="tag tag-mittel">Mittel</span><span class="hint">Trades anzeigen →</span></h2>
    <div class="equity pos" id="m-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="m-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="m-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="m-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="m-dd">-</span></div>
  </div>
  <div class="card" onclick="openModal('aggressiv')">
    <h2><span class="tag tag-aggressiv">Aggressiv</span><span class="hint">Trades anzeigen →</span></h2>
    <div class="equity pos" id="a-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="a-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="a-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="a-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="a-dd">-</span></div>
  </div>
</div>
<div class="grid2">
  <div class="card" style="border-color:#2d1f5e" onclick="openModal('goldglobe')">
    <h2><span class="tag" style="background:#2d1f5e;color:#a78bfa">GoldGlobe</span><span class="hint">Trades anzeigen →</span></h2>
    <div class="equity pos" id="g-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="g-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="g-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="g-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="g-dd">-</span></div>
  </div>
  <div class="card" style="border-color:#1a3a1a" onclick="openModal('test')">
    <h2><span class="tag tag-test">Test 1M</span><span class="hint">Trades anzeigen →</span></h2>
    <div class="equity pos" id="t-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="t-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="t-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="t-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="t-dd">-</span></div>
  </div>
</div>

<div class="card" style="margin-top:16px;margin-bottom:16px;cursor:default">
  <h2 style="margin-bottom:14px">EIN- / AUSZAHLUNG</h2>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><div style="color:#555;font-size:11px;margin-bottom:5px">BETRAG (€)</div>
      <input type="number" id="betrag" placeholder="500" style="background:#222;border:1px solid #333;color:#fff;padding:9px 11px;border-radius:8px;width:120px;font-size:14px"></div>
    <div><div style="color:#555;font-size:11px;margin-bottom:5px">STRATEGIE</div>
      <select id="strategie" style="background:#222;border:1px solid #333;color:#fff;padding:9px 11px;border-radius:8px;font-size:13px">
        <option value="mittel">Mittel</option><option value="aggressiv">Aggressiv</option><option value="beide">Beide</option>
      </select></div>
    <button class="btn" style="background:#1a3a1a;color:#22c55e" onclick="einzahlung()">Einzahlen</button>
    <button class="btn" style="background:#3a1a1a;color:#ef4444" onclick="auszahlung()">Auszahlen</button>
  </div>
  <div id="zahlung-status" style="margin-top:10px;font-size:12px;color:#555"></div>
</div>
<button class="btn" style="background:#222;color:#fff" onclick="laden()">Aktualisieren</button>
<button class="btn" style="background:#1a0000;color:#ef4444" onclick="reset()">Reset</button>

<!-- Modal -->
<div class="overlay" id="overlay" onclick="bgClose(event)">
  <div class="modal">
    <div class="modal-top">
      <h2 id="modal-titel">Trades</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="date-bar">
      <input type="date" id="modal-datum">
      <button onclick="ladeModalTrades()">Laden</button>
      <button onclick="setTag(0)">Heute</button>
      <button onclick="setTag(-1)">Gestern</button>
      <button onclick="setTag(-2)">Vorgestern</button>
    </div>
    <div class="summary">
      <div class="sbox"><div class="v" id="s-anz">—</div><div class="l">Trades</div></div>
      <div class="sbox"><div class="v" id="s-pnl">—</div><div class="l">Gesamt P&L</div></div>
      <div class="sbox"><div class="v" id="s-wl">—</div><div class="l">Win / Loss</div></div>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
let aktStrat = 'test';
const namen = { mittel:'Mittel', aggressiv:'Aggressiv', goldglobe:'GoldGlobe', test:'Test 1M' };

function pf(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }

function fillKarte(p, d) {
  const eq = d.aktuellesEquity;
  document.getElementById(p+'-equity').textContent = eq != null ? parseFloat(eq).toFixed(2)+' €' : '—';
  document.getElementById(p+'-trades').textContent  = d.trades;
  document.getElementById(p+'-winrate').textContent = d.winRate+'%';
  const pel = document.getElementById(p+'-pnl');
  pel.textContent = (d.gesamtPnL>=0?'+':'')+parseFloat(d.gesamtPnL).toFixed(2)+' €';
  pel.className = 'stat-value '+pf(parseFloat(d.gesamtPnL));
  document.getElementById(p+'-dd').textContent = d.drawdown+'%';
}

async function laden() {
  try {
    const r = await fetch('/api/performance');
    if (!r.ok) throw new Error('HTTP '+r.status);
    const d = await r.json();
    document.getElementById('updatezeit').textContent = 'Letzte Aktualisierung: '+new Date(d.letzteAktualisierung).toLocaleString('de-DE');
    fillKarte('m',d.mittel); fillKarte('a',d.aggressiv); fillKarte('g',d.goldglobe); fillKarte('t',d.test);
  } catch(e) { document.getElementById('updatezeit').textContent = '❌ '+e.message; }
}

function tagStr(offset) {
  const d = new Date(); d.setDate(d.getDate()+offset);
  return d.toISOString().slice(0,10);
}
function setTag(offset) { document.getElementById('modal-datum').value = tagStr(offset); }

function openModal(strat) {
  aktStrat = strat;
  document.getElementById('modal-titel').textContent = namen[strat]+' — Trades des Tages';
  setTag(0);
  document.getElementById('overlay').classList.add('on');
  ladeModalTrades();
}
function closeModal() { document.getElementById('overlay').classList.remove('on'); }
function bgClose(e) { if (e.target===document.getElementById('overlay')) closeModal(); }

async function ladeModalTrades() {
  const datum = document.getElementById('modal-datum').value;
  if (!datum) return;
  try {
    const r = await fetch('/api/trades/'+aktStrat+'?datum='+datum);
    const d = await r.json();
    document.getElementById('s-anz').textContent = d.count;
    const pe = document.getElementById('s-pnl');
    pe.textContent = (d.gesamtPnL>=0?'+':'')+d.gesamtPnL.toFixed(2)+'€';
    pe.className = 'v '+pf(d.gesamtPnL);
    document.getElementById('s-wl').textContent = d.gewinn+' / '+d.verlust;
    const body = document.getElementById('modal-body');
    if (!d.trades.length) { body.innerHTML='<div class="empty">Keine Trades für diesen Tag</div>'; return; }
    let h = '<table><thead><tr><th>Zeit</th><th>Richtung</th><th>P&L</th><th>Equity</th><th>SL</th><th>TP</th></tr></thead><tbody>';
    for (const t of d.trades) {
      const z = new Date(t.datum).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const cl = t.pnl>0?'pos':'neg';
      h += \`<tr><td>\${z}</td><td><span class="badge \${t.seite==='BUY'?'buy-b':'sell-b'}">\${t.seite}</span></td><td class="\${cl}">\${t.pnl>=0?'+':''}\${t.pnl.toFixed(2)}€</td><td>\${t.equity.toFixed(2)}€</td><td>\${t.sl}</td><td>\${t.tp}</td></tr>\`;
    }
    body.innerHTML = h+'</tbody></table>';
  } catch(e) { document.getElementById('modal-body').innerHTML='<div class="empty">Fehler: '+e.message+'</div>'; }
}

async function ladeChart() {
  try {
    const r = await fetch('/api/trades/test');
    const d = await r.json();
    let labels=[], vals=[];
    if (d.trades && d.trades.length > 0) {
      let eq=1000; labels.push('Start'); vals.push(1000);
      for (const t of d.trades) {
        eq = parseFloat((eq+t.pnl).toFixed(2));
        const dt = new Date(t.datum);
        labels.push(dt.toLocaleDateString('de-DE')+' '+dt.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}));
        vals.push(eq);
      }
    } else {
      const r2 = await fetch('/api/equity');
      const eq2 = await r2.json();
      const pts = (eq2.test||[]).filter(p=>p.equity>800);
      labels = pts.map(p=>{ const dt=new Date(p.datum); return dt.toLocaleDateString('de-DE')+' '+dt.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}); });
      vals   = pts.map(p=>p.equity);
    }
    if (!labels.length) return;
    new Chart(document.getElementById('equityChart').getContext('2d'), {
      type:'line',
      data:{ labels, datasets:[{ label:'Test 1M', data:vals, borderColor:'#4ade80', backgroundColor:'rgba(74,222,128,0.08)', tension:0.3, fill:true, pointRadius:2, pointHoverRadius:4 }] },
      options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#666', font:{size:11} } } }, scales:{ x:{ ticks:{ color:'#555', maxTicksLimit:10, font:{size:10} }, grid:{ color:'#1a1a1a' } }, y:{ ticks:{ color:'#555', callback:v=>v.toFixed(0)+'€', font:{size:10} }, grid:{ color:'#1a1a1a' } } } }
    });
  } catch(e) { console.error('Chart:',e.message); }
}

async function reset() { if(!confirm('Wirklich zurücksetzen?')) return; await fetch('/api/reset',{method:'POST'}); laden(); }
async function einzahlung() {
  const b=document.getElementById('betrag').value, s=document.getElementById('strategie').value;
  if(!b) return alert('Betrag eingeben');
  await fetch('/api/einzahlung?betrag='+b+'&strategie='+s);
  document.getElementById('zahlung-status').textContent='✅ Einzahlung '+b+'€ für '+s; laden();
}
async function auszahlung() {
  const b=document.getElementById('betrag').value, s=document.getElementById('strategie').value;
  if(!b) return alert('Betrag eingeben');
  await fetch('/api/auszahlung?betrag='+b+'&strategie='+s);
  document.getElementById('zahlung-status').textContent='💸 Auszahlung '+b+'€ für '+s; laden();
}

laden(); ladeChart();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf http://localhost:${PORT}`));
