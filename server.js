process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const app     = express();
app.use(express.json());
app.use((req, res, next) => { res.setHeader('X-Frame-Options', 'ALLOWALL'); next(); });

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
    riskPct:        5.5,
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
  }
};

let performance = {
  mittel:    { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
  aggressiv: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
  goldglobe: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 }
};

let letzteEquity = { mittel: 1000, aggressiv: 1000, goldglobe: 1000 };
let letzteAktualisierung = new Date().toISOString();

// ── Equity Kurve ──────────────────────────────────────
const EQUITY_FILE  = '/data/equity.json';
const TRADES_FILE  = '/data/trades.json';

function ladeEquityDaten() {
  try {
    if (fs.existsSync(EQUITY_FILE)) {
      return JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('❌ Equity Datei laden fehlgeschlagen:', err.message);
  }
  return { mittel: [], aggressiv: [], goldglobe: [] };
}

function speichereEquityDaten(daten) {
  try {
    fs.writeFileSync(EQUITY_FILE, JSON.stringify(daten, null, 2));
  } catch (err) {
    console.error('❌ Equity Datei speichern fehlgeschlagen:', err.message);
  }
}

let equityVerlauf = ladeEquityDaten();

// ── Trade History (persistent) ────────────────────────
function ladeTradeHistory() {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('❌ Trade History laden fehlgeschlagen:', err.message);
  }
  return { mittel: [], aggressiv: [], goldglobe: [] };
}

function speichereTradeHistory(daten) {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(daten, null, 2));
  } catch (err) {
    console.error('❌ Trade History speichern fehlgeschlagen:', err.message);
  }
}

let tradeHistory = ladeTradeHistory();

// ── Adaptiver Risiko-Rechner ───────────────────────────
// Basis: Vereinfachtes Kelly Criterion
// Multiplier bleibt zwischen 0.5x und 1.5x des Basisrisikos
function adaptiveRisk(strategieName, baseRisk) {
  const trades = tradeHistory[strategieName];
  if (trades.length < 10) {
    console.log(`🧠 [${strategieName}] Noch zu wenig Trades (${trades.length}/10) → Basisrisiko ${baseRisk}%`);
    return baseRisk;
  }

  // Verlust-Streak Schutz: letzte 3 alle Verluste → Risiko halbieren
  const letzte3 = trades.slice(-3);
  if (letzte3.length === 3 && letzte3.every(t => t.pnl <= 0)) {
    const reduziert = parseFloat((baseRisk * 0.5).toFixed(2));
    console.log(`⚠️  [${strategieName}] 3er Verlust-Streak → Risiko auf ${reduziert}% reduziert`);
    return reduziert;
  }

  const recent      = trades.slice(-20);
  const gewinnT     = recent.filter(t => t.pnl > 0);
  const verlustT    = recent.filter(t => t.pnl <= 0);
  const winRate     = gewinnT.length / recent.length;

  if (gewinnT.length === 0 || verlustT.length === 0) return baseRisk;

  const avgWin  = gewinnT.reduce((s, t) => s + t.pnl, 0)              / gewinnT.length;
  const avgLoss = Math.abs(verlustT.reduce((s, t) => s + t.pnl, 0))   / verlustT.length;
  const ratio   = avgWin / avgLoss;

  // Kelly: f* = WR - (1-WR)/ratio
  const kelly      = winRate - (1 - winRate) / ratio;
  // Multiplier: 0.5x bis 1.5x
  const multiplier = Math.max(0.5, Math.min(1.5, 0.5 + kelly * 2));
  const adjusted   = parseFloat((baseRisk * multiplier).toFixed(2));

  console.log(`🧠 [${strategieName}] WR=${(winRate*100).toFixed(0)}% Ratio=${ratio.toFixed(2)} Kelly=${kelly.toFixed(3)} Mult=${multiplier.toFixed(2)}x → Risiko: ${baseRisk}% → ${adjusted}%`);
  return adjusted;
}

function equityPunktHinzufuegen(strategieName, equity) {
  equityVerlauf[strategieName].push({
    datum:  new Date().toISOString(),
    equity: parseFloat(equity)
  });
  speichereEquityDaten(equityVerlauf);
  console.log(`📈 Equity Punkt gespeichert [${strategieName}]: ${equity}€`);
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
    const equity  = account?.balance?.equity
                 || account?.balance?.available
                 || account?.balance?.balance
                 || account?.balance;
    console.log(`💰 Equity (${konto.email}): ${equity}€`);
    return equity;
  } catch (err) {
    if (err.response?.status === 401) {
      await login(konto);
      return getEquity(konto);
    }
    throw err;
  }
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
      tradeHistory[strategieName].push({ datum: new Date().toISOString(), pnl: parseFloat(pnl.toFixed(2)) });
      speichereTradeHistory(tradeHistory);
    }
    letzteEquity[strategieName] = equity;
    equityPunktHinzufuegen(strategieName, equity);

    const aktuellesRisiko = adaptiveRisk(strategieName, strategie.riskPct);
    const size  = calcSize(equity, sl, tp, { ...strategie, riskPct: aktuellesRisiko });
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
      `TP: <b>${tp}$</b>\n` +
      `🧠 Risiko: <b>${aktuellesRisiko}%</b> (Basis: ${strategie.riskPct}%)`
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
app.post('/webhook/mittel',    (req, res) => handleWebhook(req, res, 'mittel'));
app.post('/webhook/aggressiv', (req, res) => handleWebhook(req, res, 'aggressiv'));
app.post('/webhook/goldglobe', (req, res) => handleWebhook(req, res, 'goldglobe'));

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
  function kontoStats(name, equity) {
    const p = performance[name] || { trades:0, gewinn:0, verlust:0, gesamtPnL:0, bestesTrade:0, schlechtestesTrade:0, startEquity:1000 };
    const s = STRATEGIEN[name];
    return {
      ...p,
      aktuellesEquity: equity,
      gesamtPnL:  p.gesamtPnL.toFixed(2),
      drawdown:   p.trades === 0 ? '0.00' : (((s.startEquity - equity) / s.startEquity) * 100).toFixed(2),
      winRate:    p.trades > 0 ? ((p.gewinn / p.trades) * 100).toFixed(1) : '0'
    };
  }

  async function safeEquity(konto, fallback) {
    try {
      if (!konto.apiKey) return fallback;
      if (!konto.cst) await login(konto);
      return await getEquity(konto);
    } catch { return fallback; }
  }

  const [equityMittel, equityAggressiv, equityGoldglobe] = await Promise.all([
    safeEquity(KONTO_MITTEL,    1000),
    safeEquity(KONTO_AGGRESSIV, 1000),
    safeEquity(KONTO_GOLDGLOBE, 1000)
  ]);

  res.json({
    letzteAktualisierung,
    mittel:    kontoStats('mittel',    equityMittel),
    aggressiv: kontoStats('aggressiv', equityAggressiv),
    goldglobe: kontoStats('goldglobe', equityGoldglobe)
  });
});

// ── Equity API ────────────────────────────────────────
app.get('/api/equity', (req, res) => {
  res.json(equityVerlauf);
});

// ── Adaptive API ─────────────────────────────────────
app.get('/api/adaptive', (req, res) => {
  const result = {};
  for (const name of ['mittel', 'aggressiv']) {
    const strategie   = STRATEGIEN[name];
    const trades      = tradeHistory[name];
    const recent      = trades.slice(-20);
    const gewinnT     = recent.filter(t => t.pnl > 0);
    const letzte5     = trades.slice(-5).map(t => t.pnl > 0 ? 'W' : 'L').join('') || '-';
    const adjusted    = adaptiveRisk(name, strategie.riskPct);
    result[name] = {
      basisRisiko:     strategie.riskPct,
      aktuellesRisiko: adjusted,
      multiplikator:   parseFloat((adjusted / strategie.riskPct).toFixed(2)),
      gesamtTrades:    trades.length,
      recentWinRate:   recent.length > 0 ? ((gewinnT.length / recent.length) * 100).toFixed(1) : '0',
      letzte5Trades:   letzte5
    };
  }
  res.json(result);
});

// ── Reset ─────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  performance = {
    mittel:    { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
    aggressiv: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 }
  };
  letzteEquity = { mittel: 1000, aggressiv: 1000 };
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
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<script src="https://unpkg.com/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #0a0e1a; color: #e0e6f0; padding: 16px; }
  h1 { font-size: 20px; font-weight: 700; color: #f0c040; margin-bottom: 2px; }
  .subtitle { color: #4a6080; font-size: 11px; margin-bottom: 14px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .card { background: #111827; border-radius: 10px; padding: 14px; border: 1px solid #1e2d45; }
  .card-title { font-size: 10px; color: #4a6080; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
  .equity { font-size: 26px; font-weight: 700; margin-bottom: 8px; }
  .stat { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #1a2540; font-size: 12px; }
  .stat:last-child { border-bottom: none; }
  .label { color: #4a6080; }
  .val { font-weight: 600; }
  .pos { color: #22c55e; }
  .neg { color: #ef4444; }
  .tag { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .tag-m { background:#1e3a5f33;color:#60a5fa;border:1px solid #1e3a5f; }
  .tag-a { background:#3b1f0033;color:#fb923c;border:1px solid #3b2000; }
  .tag-g { background:#0f3a2033;color:#44cc88;border:1px solid #1a4a30; }
  .btn { padding: 8px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 12px; font-weight: 600; margin-right: 6px; }
  a.expand { position:fixed;top:12px;right:12px;background:#1a2a4a;border:1px solid #2a4a6a;color:#6090c0;padding:6px 10px;border-radius:6px;font-size:11px;text-decoration:none; }
</style>
</head>
<body>
<a href="/dashboard" target="_blank" class="expand">⛶ Vollbild</a>
<h1>Trading Bot Dashboard</h1>
<p class="subtitle" id="updatezeit">Wird geladen...</p>

<div class="card" style="margin-bottom:12px">
  <div class="card-title">Equity Kurve</div>
  <canvas id="equityChart" height="55"></canvas>
</div>

<div class="grid3" id="konto-grid"></div>

<div class="card" style="margin-bottom:12px" id="adaptive-card">
  <div class="card-title">🧠 Adaptives Risiko</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px" id="adaptive-grid"></div>
</div>

<div class="card" style="margin-bottom:12px">
  <div class="card-title">Ein- / Auszahlung</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <input type="number" id="betrag" placeholder="Betrag €" style="background:#0d1b2a;border:1px solid #1e3a5a;color:#e0e6f0;padding:8px;border-radius:6px;width:110px;font-size:12px">
    <select id="strategie" style="background:#0d1b2a;border:1px solid #1e3a5a;color:#e0e6f0;padding:8px;border-radius:6px;font-size:12px">
      <option value="mittel">Mittel</option>
      <option value="aggressiv">Aggressiv</option>
      <option value="goldglobe">GoldGlobe</option>
      <option value="beide">Alle</option>
    </select>
    <button class="btn" style="background:#1a3a1a;color:#22c55e" onclick="einzahlung()">+ Einzahlen</button>
    <button class="btn" style="background:#3a1a1a;color:#ef4444" onclick="auszahlung()">- Auszahlen</button>
  </div>
  <div id="zahlung-status" style="margin-top:8px;font-size:11px;color:#4a6080"></div>
</div>

<button class="btn" style="background:#1a2a3a;color:#e0e6f0" onclick="laden()">↻ Refresh</button>
<button class="btn" style="background:#2a0a0a;color:#ef4444" onclick="reset()">Reset Stats</button>

<script>
let chartInstance = null;
function pc(v) { return v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#e0e6f0'; }

async function laden() {
  try {
    const res  = await fetch('/api/performance');
    const data = await res.json();
    if (data.fehler) throw new Error(data.fehler);
    document.getElementById('updatezeit').textContent = 'Aktualisiert: ' + new Date(data.letzteAktualisierung).toLocaleString('de-DE');

    const konten = [
      { key:'mittel',    label:'Mittel',       tag:'tag-m', risiko:'1.7%'    },
      { key:'aggressiv', label:'Aggressiv',    tag:'tag-a', risiko:'5.5%'    },
      { key:'goldglobe', label:'🤖 GoldGlobe', tag:'tag-g', risiko:'1.7%+KI' }
    ];
    document.getElementById('konto-grid').innerHTML = konten.map(k => {
      const s = data[k.key];
      if (!s) return '<div class="card"><div class="card-title">'+k.label+'</div><div style="color:#4a6080;font-size:11px">Nicht verfügbar</div></div>';
      const eq  = parseFloat(s.aktuellesEquity||0);
      const pnl = parseFloat(s.gesamtPnL||0);
      const dd  = parseFloat(s.drawdown||0);
      return \`<div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between"><span class="tag \${k.tag}">\${k.label}</span><span>\${k.risiko}</span></div>
        <div class="equity" style="color:\${eq>=1000?'#22c55e':'#ef4444'}">\${eq.toFixed(2)} €</div>
        <div class="stat"><span class="label">Trades</span><span class="val">\${s.trades}</span></div>
        <div class="stat"><span class="label">Win-Rate</span><span class="val">\${s.winRate}%</span></div>
        <div class="stat"><span class="label">PnL</span><span class="val" style="color:\${pc(pnl)}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}€</span></div>
        <div class="stat"><span class="label">Drawdown</span><span class="val" style="color:\${dd>15?'#ef4444':'#fb923c'}">\${dd.toFixed(1)}%</span></div>
        <div class="stat"><span class="label">Best</span><span class="val pos">+\${parseFloat(s.bestesTrade||0).toFixed(2)}€</span></div>
        <div class="stat"><span class="label">Worst</span><span class="val neg">\${parseFloat(s.schlechtestesTrade||0).toFixed(2)}€</span></div>
      </div>\`;
    }).join('');

    await ladeChart();
    await ladeAdaptiv();
  } catch(err) {
    document.getElementById('updatezeit').textContent = 'Fehler: ' + err.message;
  }
}

async function ladeChart() {
  try {
    const res  = await fetch('/api/equity');
    const data = await res.json();
    const m = data.mittel||[], a = data.aggressiv||[], g = data.goldglobe||[];
    const src = m.length ? m : a.length ? a : [];
    const labels = src.map(p => new Date(p.datum).toLocaleDateString('de-DE'));
    const ctx = document.getElementById('equityChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [
        { label:'Mittel',      data:m.map(p=>p.equity), borderColor:'#60a5fa', backgroundColor:'rgba(96,165,250,0.08)',  tension:0.3, pointRadius:0, fill:true },
        { label:'Aggressiv',  data:a.map(p=>p.equity), borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,0.08)',  tension:0.3, pointRadius:0, fill:true },
        { label:'GoldGlobe',  data:g.map(p=>p.equity), borderColor:'#44cc88', backgroundColor:'rgba(68,204,136,0.08)',  tension:0.3, pointRadius:0, fill:true }
      ]},
      options: {
        responsive:true,
        plugins:{ legend:{ labels:{ color:'#6080a0', font:{size:10}, boxWidth:10 } } },
        scales:{
          x:{ ticks:{color:'#4a6080',font:{size:9},maxTicksLimit:5}, grid:{color:'#111827'} },
          y:{ ticks:{color:'#4a6080',font:{size:9},callback:v=>v+'€'}, grid:{color:'#111827'} }
        }
      }
    });
  } catch(e){}
}

async function ladeAdaptiv() {
  try {
    const res  = await fetch('/api/adaptive');
    const data = await res.json();
    const namen = ['mittel','aggressiv'];
    document.getElementById('adaptive-grid').innerHTML = namen.map(name => {
      const d = data[name]; if (!d) return '';
      const farbe = name==='mittel'?'#60a5fa':'#fb923c';
      const mc = d.multiplikator > 1 ? '#22c55e' : d.multiplikator < 1 ? '#ef4444' : '#e0e6f0';
      return \`<div>
        <div style="color:\${farbe};font-size:11px;font-weight:600;margin-bottom:6px">\${name.toUpperCase()}</div>
        <div class="stat"><span class="label">Risiko</span><span class="val">\${d.aktuellesRisiko}%</span></div>
        <div class="stat"><span class="label">Multiplikator</span><span class="val" style="color:\${mc}">\${d.multiplikator}x</span></div>
        <div class="stat"><span class="label">Win Rate</span><span class="val">\${d.recentWinRate}%</span></div>
        <div class="stat"><span class="label">Letzte 5</span><span class="val" style="font-size:10px">\${d.letzte5Trades}</span></div>
      </div>\`;
    }).join('');
  } catch(e){}
}

async function reset() {
  if (!confirm('Statistik zurücksetzen?')) return;
  await fetch('/api/reset', { method:'POST' });
  laden();
}
async function einzahlung() {
  const b=document.getElementById('betrag').value, s=document.getElementById('strategie').value;
  if (!b) return alert('Betrag eingeben!');
  await fetch('/api/einzahlung?betrag='+b+'&strategie='+s);
  document.getElementById('zahlung-status').textContent = '✅ +'+b+'€ für '+s;
  laden();
}
async function auszahlung() {
  const b=document.getElementById('betrag').value, s=document.getElementById('strategie').value;
  if (!b) return alert('Betrag eingeben!');
  await fetch('/api/auszahlung?betrag='+b+'&strategie='+s);
  document.getElementById('zahlung-status').textContent = '💸 -'+b+'€ für '+s;
  laden();
}

laden();
setInterval(laden, 30000);
</script>
</body>
</html>`);
});
const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server läuft auf http://localhost:${PORT}`));
