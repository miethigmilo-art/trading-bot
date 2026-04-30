process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express    = require('express');
const axios      = require('axios');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const app        = express();
app.use(express.json());

// ── Konten ────────────────────────────────────────────
const KONTO_MITTEL = {
  apiKey: process.env.API_KEY, email: process.env.EMAIL,
  password: process.env.PASSWORD, baseUrl: process.env.BASE_URL, cst: null, token: null
};
const KONTO_AGGRESSIV = {
  apiKey: process.env.API_KEY_AGGRESSIV, email: process.env.EMAIL_AGGRESSIV,
  password: process.env.PASSWORD_AGGRESSIV, baseUrl: process.env.BASE_URL, cst: null, token: null
};
const KONTO_GOLDGLOBE = {
  apiKey: process.env.API_KEY_GOLDGLOBE, email: process.env.EMAIL_GOLDGLOBE,
  password: process.env.PASSWORD_GOLDGLOBE, baseUrl: process.env.BASE_URL, cst: null, token: null
};
const KONTO_TEST = {
  apiKey: process.env.API_KEY_TEST, email: process.env.EMAIL_TEST,
  password: process.env.PASSWORD_TEST, baseUrl: process.env.BASE_URL, cst: null, token: null
};
const KONTO_KONSERVATIV = {
  apiKey: process.env.API_KEY_KONSERVATIV, email: process.env.EMAIL_KONSERVATIV,
  password: process.env.PASSWORD_KONSERVATIV, baseUrl: process.env.BASE_URL, cst: null, token: null
};
const KONTO_OPTIMIERT = {
  apiKey: process.env.API_KEY_OPTIMIERT, email: process.env.EMAIL_OPTIMIERT,
  password: process.env.PASSWORD_OPTIMIERT, baseUrl: process.env.BASE_URL, cst: null, token: null
};

// ── Strategien ────────────────────────────────────────
const STRATEGIEN = {
  mittel:      { konto: KONTO_MITTEL,      epic: 'GOLD', riskPct: 2.7, leverage: 10, maxDrawdownPct: 20, startEquity: 1000 },
  aggressiv:   { konto: KONTO_AGGRESSIV,   epic: 'GOLD', riskPct: 3.7, leverage: 10, maxDrawdownPct: 30, startEquity: 1000 },
  goldglobe:   { konto: KONTO_GOLDGLOBE,   epic: 'GOLD', riskPct: 1.7, leverage: 10, maxDrawdownPct: 20, startEquity: 1000 },
  test:        { konto: KONTO_TEST,        epic: 'GOLD', riskPct: 1.0, leverage: 10, maxDrawdownPct: 50, startEquity: 1000 },
  // Konservativ: exakte Kopie test, NUR Tages-Stop (+5%)
  konservativ: { konto: KONTO_KONSERVATIV, epic: 'GOLD', riskPct: 1.0, leverage: 10, maxDrawdownPct: 50, startEquity: 1000, tagsStop: true },
  // Optimiert: exakte Kopie test, ALLE Fixes angewendet
  optimiert:   { konto: KONTO_OPTIMIERT,   epic: 'GOLD', riskPct: 1.0, leverage: 5,  maxDrawdownPct: 50, startEquity: 1000, tagsStop: true, alleFixe: true, minRRR: 2.0 }
};

const ALLE_STRATEGIEN = Object.keys(STRATEGIEN);

// ── Performance State ─────────────────────────────────
function neuPerf(startEquity = 1000) {
  return { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity, buyTrades: 0, sellTrades: 0, buyGewinn: 0, sellGewinn: 0, buyPnL: 0, sellPnL: 0 };
}
let performance = {};
ALLE_STRATEGIEN.forEach(n => { performance[n] = neuPerf(1000); });

let letzteEquity         = {};
ALLE_STRATEGIEN.forEach(n => { letzteEquity[n] = 1000; });
let letzteAktualisierung = new Date().toISOString();

// Tages-Stop State
let tagesStartEquity = {};
ALLE_STRATEGIEN.forEach(n => { tagesStartEquity[n] = null; });

// Duplikat-Schutz
const aktiveTrades = {};
const letzterTrade = {};

// ── Equity + Trade Dateien ────────────────────────────
const EQUITY_FILE = '/data/equity.json';
const TRADES_FILE = '/data/trades.json';

function ladeEquityDaten() {
  try {
    if (fs.existsSync(EQUITY_FILE)) return JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8'));
  } catch (err) { console.error('❌ Equity laden:', err.message); }
  const d = {};
  ALLE_STRATEGIEN.forEach(n => { d[n] = []; });
  return d;
}
function speichereEquityDaten(d) {
  try { fs.writeFileSync(EQUITY_FILE, JSON.stringify(d, null, 2)); }
  catch (err) { console.error('❌ Equity speichern:', err.message); }
}
let equityVerlauf = ladeEquityDaten();
ALLE_STRATEGIEN.forEach(n => { if (!equityVerlauf[n]) equityVerlauf[n] = []; });

function equityPunktHinzufuegen(name, equity) {
  if (!equityVerlauf[name]) equityVerlauf[name] = [];
  equityVerlauf[name].push({ datum: new Date().toISOString(), equity: parseFloat(equity) });
  speichereEquityDaten(equityVerlauf);
}

function ladeTradeDaten() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch (err) { console.error('❌ Trades laden:', err.message); }
  const d = {};
  ALLE_STRATEGIEN.forEach(n => { d[n] = []; });
  return d;
}
function speichereTradeDaten(d) {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(d, null, 2)); }
  catch (err) { console.error('❌ Trades speichern:', err.message); }
}
let tradeVerlauf = ladeTradeDaten();
ALLE_STRATEGIEN.forEach(n => { if (!tradeVerlauf[n]) tradeVerlauf[n] = []; });

// Performance + letzteEquity beim Start wiederherstellen
(function initAusDaten() {
  for (const [name, punkte] of Object.entries(equityVerlauf)) {
    if (punkte.length > 0) letzteEquity[name] = punkte[punkte.length - 1].equity;
  }
  for (const [name, trades] of Object.entries(tradeVerlauf)) {
    if (!performance[name] || !trades.length) continue;
    const p = performance[name];
    for (const t of trades) {
      p.trades++;
      p.gesamtPnL += t.pnl;
      if (t.pnl > 0) p.gewinn++; else p.verlust++;
      if (t.pnl > p.bestesTrade) p.bestesTrade = t.pnl;
      if (t.pnl < p.schlechtestesTrade) p.schlechtestesTrade = t.pnl;
      if (t.seite === 'BUY') {
        p.buyTrades++; p.buyPnL += t.pnl;
        if (t.pnl > 0) p.buyGewinn++;
      } else if (t.seite === 'SELL') {
        p.sellTrades++; p.sellPnL += t.pnl;
        if (t.pnl > 0) p.sellGewinn++;
      }
    }
    if (trades.length > 0) letzteAktualisierung = trades[trades.length - 1].datum;
  }
  console.log('📊 Performance wiederhergestellt:', ALLE_STRATEGIEN.map(n => n+':'+performance[n].trades+'T').join(' '));
})();

function tradeHinzufuegen(name, trade) {
  if (!tradeVerlauf[name]) tradeVerlauf[name] = [];
  tradeVerlauf[name].push(trade);
  speichereTradeDaten(tradeVerlauf);
  console.log(`📝 Trade [${name}]: PnL ${trade.pnl >= 0 ? '+' : ''}${trade.pnl}€`);
}

// ── Login ─────────────────────────────────────────────
async function login(konto) {
  const res = await axios.post(`${konto.baseUrl}/session`, {
    identifier: konto.email, password: konto.password
  }, { headers: { 'X-CAP-API-KEY': konto.apiKey } });
  konto.cst   = res.headers['cst'];
  konto.token = res.headers['x-security-token'];
  console.log(`✅ Login: ${konto.email}`);
}

// ── Equity holen ──────────────────────────────────────
async function getEquity(konto) {
  try {
    const res = await axios.get(`${konto.baseUrl}/accounts`, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });
    const bal   = res.data.accounts[0]?.balance;
    const equity = bal?.balance ?? bal?.available ?? bal;
    return equity;
  } catch (err) {
    if (err.response?.status === 401) { await login(konto); return getEquity(konto); }
    throw err;
  }
}

// ── Offene Positionen ─────────────────────────────────
async function getOpenPosition(konto, epic) {
  const res = await axios.get(`${konto.baseUrl}/positions`, {
    headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
  });
  const positions = res.data.positions || [];
  return positions.find(p => p.market?.epic === epic) || null;
}

async function closeOpenPosition(konto, epic) {
  try {
    const res = await axios.get(`${konto.baseUrl}/positions`, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });
    const positions = (res.data.positions || []).filter(p => p.market?.epic === epic);
    for (const pos of positions) {
      await axios.delete(`${konto.baseUrl}/positions/${pos.position.dealId}`, {
        headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
      });
      console.log(`🔒 Position geschlossen: ${pos.position.dealId}`);
    }
  } catch (err) {
    console.error('❌ closeOpenPosition:', err.message);
  }
}

// ── calcSize (original, mit Leverage) ────────────────
function calcSize(equity, sl, tp, strategie) {
  const riskCapital = equity * (strategie.riskPct / 100) * strategie.leverage;
  const slDistance  = Math.abs(parseFloat(tp) - parseFloat(sl));
  let size          = riskCapital / slDistance;
  const maxSize     = (equity * strategie.leverage) / parseFloat(sl);
  size              = Math.min(size, maxSize);
  return Math.max(1, parseFloat(size.toFixed(1)));
}

// ── calcSize Fixed (ohne doppelten Leverage) ─────────
function calcSizeFixed(equity, sl, tp, strategie) {
  const riskCapital = equity * (strategie.riskPct / 100);
  const slDistance  = Math.abs(parseFloat(tp) - parseFloat(sl));
  if (slDistance === 0) return 1;
  let size = riskCapital / slDistance;
  return Math.max(1, parseFloat(size.toFixed(1)));
}

// ── Drawdown prüfen ───────────────────────────────────
function checkDrawdown(equity, strategie, name) {
  if (performance[name].trades === 0) return false;
  const drawdown = ((strategie.startEquity - equity) / strategie.startEquity) * 100;
  return drawdown >= strategie.maxDrawdownPct;
}

// ── Performance updaten ───────────────────────────────
function updatePerformance(name, pnl, seite) {
  const p = performance[name];
  p.trades++;
  p.gesamtPnL += pnl;
  if (pnl > 0) p.gewinn++; else p.verlust++;
  if (pnl > p.bestesTrade) p.bestesTrade = pnl;
  if (pnl < p.schlechtestesTrade) p.schlechtestesTrade = pnl;
  if (seite === 'BUY') { p.buyTrades++; p.buyPnL += pnl; if (pnl > 0) p.buyGewinn++; }
  else if (seite === 'SELL') { p.sellTrades++; p.sellPnL += pnl; if (pnl > 0) p.sellGewinn++; }
  letzteAktualisierung = new Date().toISOString();
}

// ── Telegram ──────────────────────────────────────────
async function sendTelegram(nachricht) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID, text: nachricht, parse_mode: 'HTML'
    });
  } catch (err) { console.error('❌ Telegram:', err.message); }
}

// ── Tages-Stop Prüfung ────────────────────────────────
function pruefeTagsStop(name, equity) {
  if (tagesStartEquity[name] === null) { tagesStartEquity[name] = equity; return false; }
  const pct = ((equity - tagesStartEquity[name]) / tagesStartEquity[name]) * 100;
  return pct >= 5.0;
}

// ── Webhook Handler (original, unverändert) ───────────
async function handleWebhook(req, res, strategieName) {
  console.log(`📨 Signal [${strategieName}]:`, req.body);
  const { side, sl, tp } = req.body;
  if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder' });

  const strategie = STRATEGIEN[strategieName];
  const konto     = strategie.konto;

  try {
    if (!konto.cst) await login(konto);
    const equity = await getEquity(konto);

    if (checkDrawdown(equity, strategie, strategieName)) {
      await sendTelegram(`🛑 <b>Bot gestoppt!</b>\nStrategie: <b>${strategieName}</b>\nMax. Drawdown erreicht!`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown erreicht' });
    }

    const pnl = equity - letzteEquity[strategieName];
    if (pnl !== 0) {
      updatePerformance(strategieName, pnl, side);
      tradeHinzufuegen(strategieName, { datum: new Date().toISOString(), pnl: parseFloat(pnl.toFixed(2)), equity: parseFloat(equity.toFixed(2)), seite: side, sl: parseFloat(sl), tp: parseFloat(tp) });
    }
    letzteEquity[strategieName] = equity;
    equityPunktHinzufuegen(strategieName, equity);

    const size  = calcSize(equity, sl, tp, strategie);
    const order = { epic: strategie.epic, direction: side, size, guaranteedStop: false, stopLevel: parseFloat(sl), profitLevel: parseFloat(tp) };

    await axios.post(`${konto.baseUrl}/positions`, order, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });

    await sendTelegram(`${side === 'BUY' ? '🟢' : '🔴'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'} eröffnet</b>\nStrategie: <b>${strategieName}</b>\nGröße: <b>${size} Units</b>\nSL: <b>${sl}$</b>\nTP: <b>${tp}$</b>`);
    res.json({ status: 'ok', strategie: strategieName, size });

  } catch (err) {
    if (err.response?.status === 401) { konto.cst = null; await login(konto); return res.status(500).json({ error: 'Session erneuert' }); }
    console.error('❌ Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Konservativ Handler (nur Tages-Stop) ──────────────
async function handleWebhookKonservativ(req, res) {
  const name = 'konservativ';
  console.log(`📨 Signal [${name}]:`, req.body);
  const { side, sl, tp } = req.body;
  if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder' });

  const strategie = STRATEGIEN[name];
  const konto     = strategie.konto;

  try {
    if (!konto.cst) await login(konto);
    const equity = await getEquity(konto);

    // Tages-Stop +5%
    if (pruefeTagsStop(name, equity)) {
      await sendTelegram(`🎯 Tagesziel erreicht! +5% — Konservativ pausiert bis morgen`);
      return res.json({ status: 'pausiert', grund: 'Tagesziel +5% erreicht' });
    }

    if (checkDrawdown(equity, strategie, name)) {
      await sendTelegram(`🛑 <b>Bot gestoppt!</b>\nStrategie: <b>${name}</b>\nMax. Drawdown erreicht!`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown erreicht' });
    }

    const pnl = equity - letzteEquity[name];
    if (pnl !== 0) {
      updatePerformance(name, pnl, side);
      tradeHinzufuegen(name, { datum: new Date().toISOString(), pnl: parseFloat(pnl.toFixed(2)), equity: parseFloat(equity.toFixed(2)), seite: side, sl: parseFloat(sl), tp: parseFloat(tp) });
    }
    letzteEquity[name] = equity;
    equityPunktHinzufuegen(name, equity);

    const size  = calcSize(equity, sl, tp, strategie);
    const order = { epic: strategie.epic, direction: side, size, guaranteedStop: false, stopLevel: parseFloat(sl), profitLevel: parseFloat(tp) };

    await axios.post(`${konto.baseUrl}/positions`, order, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });

    await sendTelegram(`${side === 'BUY' ? '🟢' : '🔴'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'} eröffnet</b>\nStrategie: <b>${name}</b>\nGröße: <b>${size} Units</b>\nSL: <b>${sl}$</b>\nTP: <b>${tp}$</b>`);
    res.json({ status: 'ok', strategie: name, size });

  } catch (err) {
    if (err.response?.status === 401) { konto.cst = null; await login(konto); return res.status(500).json({ error: 'Session erneuert' }); }
    console.error('❌ Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Optimiert Handler (alle Fixes) ───────────────────
async function handleWebhookOptimiert(req, res) {
  const name = 'optimiert';

  // Fix #12: Webhook Secret
  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Ungültiger Webhook Secret' });
  }

  // Fix #4: Duplikat-Schutz
  if (aktiveTrades[name]) return res.status(429).json({ error: 'Trade läuft bereits' });
  const jetzt = Date.now();
  if (letzterTrade[name] && jetzt - letzterTrade[name] < 30000) {
    return res.status(429).json({ error: 'Cooldown aktiv (30s)' });
  }
  aktiveTrades[name] = true;

  try {
    console.log(`📨 Signal [${name}]:`, req.body);
    let { side, sl, tp } = req.body;
    if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder' });

    const strategie = STRATEGIEN[name];
    const konto     = strategie.konto;

    if (!konto.cst) await login(konto);
    const equity = await getEquity(konto);

    // Fix #5: Tages-Stop +5%
    if (pruefeTagsStop(name, equity)) {
      await sendTelegram(`🎯 Tagesziel erreicht! +5% — Optimiert pausiert bis morgen`);
      return res.json({ status: 'pausiert', grund: 'Tagesziel +5% erreicht' });
    }

    if (checkDrawdown(equity, strategie, name)) {
      await sendTelegram(`🛑 <b>Bot gestoppt!</b>\nStrategie: <b>${name}</b>\nMax. Drawdown erreicht!`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown erreicht' });
    }

    // Fix #3: RRR erzwingen (min 2.0)
    const minRRR   = strategie.minRRR || 2.0;
    const slFloat  = parseFloat(sl);
    let   tpFloat  = parseFloat(tp);
    // Schätze Entry-Preis als Midpoint (SL und TP liegen zu beiden Seiten der Entry)
    // Für BUY: entry > SL, TP > entry → riskDist = entry - SL, rewardDist = TP - entry
    // Für SELL: entry < SL, TP < entry → riskDist = SL - entry, rewardDist = entry - TP
    // Ohne exakten Entry: validiere über Marktpreis von Capital.com
    try {
      const mkt = await axios.get(`${konto.baseUrl}/markets/${strategie.epic}`, {
        headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
      });
      const entry   = side === 'BUY' ? parseFloat(mkt.data.snapshot.offer) : parseFloat(mkt.data.snapshot.bid);
      const riskD   = Math.abs(entry - slFloat);
      const rewardD = Math.abs(tpFloat - entry);
      if (riskD > 0 && rewardD / riskD < minRRR) {
        tpFloat = side === 'BUY' ? entry + riskD * minRRR : entry - riskD * minRRR;
        tpFloat = parseFloat(tpFloat.toFixed(2));
        console.log(`📐 [${name}] RRR angepasst: TP ${tp} → ${tpFloat}`);
      }
    } catch (rrrErr) {
      console.error('⚠️ RRR Preis-Check fehlgeschlagen:', rrrErr.message);
    }

    const pnl = equity - letzteEquity[name];
    if (pnl !== 0) {
      updatePerformance(name, pnl, side);
      tradeHinzufuegen(name, { datum: new Date().toISOString(), pnl: parseFloat(pnl.toFixed(2)), equity: parseFloat(equity.toFixed(2)), seite: side, sl: slFloat, tp: tpFloat });
    }
    letzteEquity[name] = equity;
    equityPunktHinzufuegen(name, equity);

    // Fix #2: Offene Position schließen
    await closeOpenPosition(konto, strategie.epic);

    // Fix #1: calcSize ohne doppelten Leverage
    const size  = calcSizeFixed(equity, slFloat, tpFloat, strategie);
    const order = { epic: strategie.epic, direction: side, size, guaranteedStop: false, stopLevel: slFloat, profitLevel: tpFloat };

    console.log(`📤 [${name}] Order:`, order);
    await axios.post(`${konto.baseUrl}/positions`, order, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });

    await sendTelegram(`${side === 'BUY' ? '🟢' : '🔴'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'} eröffnet</b>\nStrategie: <b>${name}</b>\nGröße: <b>${size} Units</b>\nSL: <b>${slFloat}$</b>\nTP: <b>${tpFloat}$</b>`);
    res.json({ status: 'ok', strategie: name, size, sl: slFloat, tp: tpFloat });

  } catch (err) {
    if (err.response?.status === 401) { KONTO_OPTIMIERT.cst = null; await login(KONTO_OPTIMIERT); return res.status(500).json({ error: 'Session erneuert' }); }
    console.error('❌ Fehler:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  } finally {
    aktiveTrades[name] = false;
    letzterTrade[name] = Date.now();
  }
}

// ── Webhook Routen ────────────────────────────────────
app.post('/webhook/mittel',      (req, res) => handleWebhook(req, res, 'mittel'));
app.post('/webhook/aggressiv',   (req, res) => handleWebhook(req, res, 'aggressiv'));
app.post('/webhook/goldglobe',   (req, res) => handleWebhook(req, res, 'goldglobe'));
app.post('/webhook/test',        (req, res) => handleWebhook(req, res, 'test'));
app.post('/webhook/konservativ', handleWebhookKonservativ);
app.post('/webhook/optimiert',   handleWebhookOptimiert);

// ── SL Update ─────────────────────────────────────────
app.post('/webhook/update_sl/:strategie', async (req, res) => {
  const name = req.params.strategie;
  const { action, sl } = req.body;
  if (action !== 'UPDATE_SL' || !sl) return res.status(400).json({ error: 'Fehlende Felder' });
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const konto = strategie.konto;
  try {
    if (!konto.cst) await login(konto);
    const position = await getOpenPosition(konto, strategie.epic);
    if (!position) return res.json({ status: 'keine Position offen' });
    await axios.put(`${konto.baseUrl}/positions/${position.position.dealId}`, { stopLevel: parseFloat(sl) }, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });
    await sendTelegram(`🔄 <b>SL aktualisiert</b>\nStrategie: <b>${name}</b>\nNeuer SL: <b>${sl}$</b>`);
    res.json({ status: 'ok', neuerSL: sl });
  } catch (err) {
    if (err.response?.status === 401) { konto.cst = null; await login(konto); return res.status(500).json({ error: 'Session erneuert' }); }
    res.status(500).json({ error: err.message });
  }
});

// ── Timezone Helper (UTC → Berlin) ───────────────────
function datumBerlin(isoString) {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(isoString));
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

// ── Performance API ───────────────────────────────────
app.get('/api/performance', async (req, res) => {
  async function tryEquity(konto) {
    try { if (!konto.cst) await login(konto); return await getEquity(konto); }
    catch (err) { console.error(`❌ Equity (${konto.email}):`, err.message); return null; }
  }
  function buildStats(name, strat, equity) {
    const p  = performance[name];
    const dd = equity != null && p.trades > 0 ? (((strat.startEquity - equity) / strat.startEquity) * 100).toFixed(2) : '0.00';
    return {
      ...p,
      aktuellesEquity: equity,
      gesamtPnL:       parseFloat(p.gesamtPnL.toFixed(2)),
      drawdown:        dd,
      winRate:         p.trades > 0 ? ((p.gewinn / p.trades) * 100).toFixed(1) : '0',
      buyWinRate:      p.buyTrades > 0 ? ((p.buyGewinn / p.buyTrades) * 100).toFixed(1) : '0',
      sellWinRate:     p.sellTrades > 0 ? ((p.sellGewinn / p.sellTrades) * 100).toFixed(1) : '0',
      buyPnL:          parseFloat(p.buyPnL.toFixed(2)),
      sellPnL:         parseFloat(p.sellPnL.toFixed(2))
    };
  }
  const equities = await Promise.all(ALLE_STRATEGIEN.map(n => tryEquity(STRATEGIEN[n].konto)));
  const result   = { letzteAktualisierung };
  ALLE_STRATEGIEN.forEach((n, i) => { result[n] = buildStats(n, STRATEGIEN[n], equities[i]); });
  res.json(result);
});

// ── Equity API ────────────────────────────────────────
app.get('/api/equity', (req, res) => { res.json(equityVerlauf); });

// ── Trades API (mit Timezone Fix + von/bis + BUY/SELL) ─
app.get('/api/trades/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });

  const { datum, von, bis } = req.query;
  let trades = tradeVerlauf[name] || [];

  // Fix #16: Datum-Filter in Berliner Zeit
  if (datum) {
    trades = trades.filter(t => datumBerlin(t.datum) === datum);
  } else {
    if (von) trades = trades.filter(t => datumBerlin(t.datum) >= von);
    if (bis) trades = trades.filter(t => datumBerlin(t.datum) <= bis);
  }

  const gesamtPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const gewinn     = trades.filter(t => t.pnl > 0).length;
  const buyTrades  = trades.filter(t => t.seite === 'BUY');
  const sellTrades = trades.filter(t => t.seite === 'SELL');

  res.json({
    strategie: name, datum: datum || 'alle', trades, count: trades.length,
    gesamtPnL: parseFloat(gesamtPnL.toFixed(2)), gewinn, verlust: trades.length - gewinn,
    buyCount:  buyTrades.length,
    sellCount: sellTrades.length,
    buyWinRate:  buyTrades.length > 0 ? ((buyTrades.filter(t => t.pnl > 0).length / buyTrades.length) * 100).toFixed(1) : '0',
    sellWinRate: sellTrades.length > 0 ? ((sellTrades.filter(t => t.pnl > 0).length / sellTrades.length) * 100).toFixed(1) : '0',
    buyPnL:  parseFloat(buyTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)),
    sellPnL: parseFloat(sellTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2))
  });
});

// ── Analyse API (Stunden + Wochentag) ────────────────
app.get('/api/analyse/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const trades = tradeVerlauf[name] || [];

  const stunden    = Array.from({ length: 24 }, (_, i) => ({ stunde: i, trades: 0, gesamtPnL: 0, gewinn: 0 }));
  const wochentage = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map((n, i) => ({ tag: n, tagNr: i, trades: 0, gesamtPnL: 0, gewinn: 0 }));

  for (const t of trades) {
    const d  = new Date(t.datum);
    const h  = d.getUTCHours();
    const wd = d.getUTCDay();
    stunden[h].trades++;
    stunden[h].gesamtPnL += t.pnl;
    if (t.pnl > 0) stunden[h].gewinn++;
    wochentage[wd].trades++;
    wochentage[wd].gesamtPnL += t.pnl;
    if (t.pnl > 0) wochentage[wd].gewinn++;
  }

  stunden.forEach(s => {
    s.gesamtPnL = parseFloat(s.gesamtPnL.toFixed(2));
    s.winRate   = s.trades > 0 ? ((s.gewinn / s.trades) * 100).toFixed(1) : '0';
    s.avgPnL    = s.trades > 0 ? parseFloat((s.gesamtPnL / s.trades).toFixed(2)) : 0;
  });
  wochentage.forEach(w => {
    w.gesamtPnL = parseFloat(w.gesamtPnL.toFixed(2));
    w.winRate   = w.trades > 0 ? ((w.gewinn / w.trades) * 100).toFixed(1) : '0';
    w.avgPnL    = w.trades > 0 ? parseFloat((w.gesamtPnL / w.trades).toFixed(2)) : 0;
  });

  res.json({ strategie: name, gesamtTrades: trades.length, stunden, wochentage });
});

// ── Offene Position API ───────────────────────────────
app.get('/api/offene-position/:strategie', async (req, res) => {
  const name = req.params.strategie;
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const konto = strategie.konto;
  try {
    if (!konto.cst) await login(konto);
    const position = await getOpenPosition(konto, strategie.epic);
    if (!position) return res.json({ position: null });
    const p = position.position;
    const m = position.market;
    res.json({
      position: {
        dealId:    p.dealId,
        richtung:  p.direction,
        groesse:   p.size,
        pnl:       p.upl,
        level:     p.level,
        sl:        p.stopLevel,
        tp:        p.limitLevel,
        epic:      m.epic,
        name:      m.instrumentName
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schliesse-position/:strategie', async (req, res) => {
  const name = req.params.strategie;
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const konto = strategie.konto;
  try {
    if (!konto.cst) await login(konto);
    const position = await getOpenPosition(konto, strategie.epic);
    if (!position) return res.json({ status: 'keine Position offen' });
    await axios.delete(`${konto.baseUrl}/positions/${position.position.dealId}`, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });
    await sendTelegram(`🔒 <b>Position manuell geschlossen</b>\nStrategie: <b>${name}</b>`);
    res.json({ status: 'ok', dealId: position.position.dealId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Weekly HTML Report ────────────────────────────────
app.get('/api/report/weekly/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });

  const bis    = new Date();
  const von    = new Date(bis.getTime() - 7 * 24 * 60 * 60 * 1000);
  const vonStr = von.toISOString().slice(0, 10);
  const bisStr = bis.toISOString().slice(0, 10);
  const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) >= vonStr && datumBerlin(t.datum) <= bisStr);

  const gesamtPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const gewinn    = trades.filter(t => t.pnl > 0).length;
  const winRate   = trades.length > 0 ? ((gewinn / trades.length) * 100).toFixed(1) : '0';

  let rows = trades.map(t => {
    const d   = new Date(t.datum);
    const cl  = t.pnl > 0 ? 'color:#22c55e' : 'color:#ef4444';
    return `<tr><td>${d.toLocaleDateString('de-DE')}</td><td>${d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</td><td>${t.seite}</td><td style="${cl}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}€</td><td>${t.equity.toFixed(2)}€</td><td>${t.sl}</td><td>${t.tp}</td></tr>`;
  }).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Wochenbericht ${name}</title>
<style>body{font-family:sans-serif;background:#0f0f0f;color:#fff;padding:32px}h1{margin-bottom:4px}
.sub{color:#666;margin-bottom:24px}.stats{display:flex;gap:16px;margin-bottom:24px}
.s{background:#1a1a1a;border-radius:10px;padding:16px 20px;min-width:120px}
.s .v{font-size:22px;font-weight:700}.s .l{font-size:11px;color:#555;margin-top:4px}
.pos{color:#22c55e}.neg{color:#ef4444}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#555;padding:8px;text-align:left;border-bottom:1px solid #222}
td{padding:9px 8px;border-bottom:1px solid #1a1a1a}
</style></head><body>
<h1>Wochenbericht — ${name}</h1>
<p class="sub">${vonStr} bis ${bisStr}</p>
<div class="stats">
  <div class="s"><div class="v">${trades.length}</div><div class="l">Trades</div></div>
  <div class="s"><div class="v ${gesamtPnL >= 0 ? 'pos' : 'neg'}">${gesamtPnL >= 0 ? '+' : ''}${gesamtPnL.toFixed(2)}€</div><div class="l">Gesamt P&L</div></div>
  <div class="s"><div class="v">${winRate}%</div><div class="l">Win Rate</div></div>
  <div class="s"><div class="v">${gewinn} / ${trades.length - gewinn}</div><div class="l">Win / Loss</div></div>
</div>
<table><thead><tr><th>Datum</th><th>Zeit</th><th>Richtung</th><th>P&L</th><th>Equity</th><th>SL</th><th>TP</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:24px;color:#333">Keine Trades in diesem Zeitraum</td></tr>'}</tbody></table>
</body></html>`);
});

// ── Reset ─────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  ALLE_STRATEGIEN.forEach(n => { performance[n] = neuPerf(STRATEGIEN[n].startEquity); });
  ALLE_STRATEGIEN.forEach(n => { letzteEquity[n] = STRATEGIEN[n].startEquity; });
  letzteAktualisierung = new Date().toISOString();
  res.json({ status: 'ok' });
});

// ── Einzahlung / Auszahlung ───────────────────────────
app.get('/api/einzahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  const targets = strategie === 'beide' ? ['mittel','aggressiv'] : [strategie];
  for (const n of targets) {
    if (STRATEGIEN[n]) { STRATEGIEN[n].startEquity += betrag; letzteEquity[n] += betrag; performance[n].startEquity += betrag; }
  }
  sendTelegram(`💰 <b>Einzahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

app.get('/api/auszahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  const targets = strategie === 'beide' ? ['mittel','aggressiv'] : [strategie];
  for (const n of targets) {
    if (STRATEGIEN[n]) { STRATEGIEN[n].startEquity -= betrag; letzteEquity[n] -= betrag; performance[n].startEquity -= betrag; }
  }
  sendTelegram(`💸 <b>Auszahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

// ── Test ──────────────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    if (!KONTO_MITTEL.cst)    await login(KONTO_MITTEL);
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const em = await getEquity(KONTO_MITTEL);
    const ea = await getEquity(KONTO_AGGRESSIV);
    res.json({ status: '✅ Verbunden', equityMittel: em+'€', equityAggressiv: ea+'€' });
  } catch (err) { res.json({ status: '❌ Fehler', fehler: err.message }); }
});

app.get('/test/trade', async (req, res) => {
  try {
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const equity = await getEquity(KONTO_AGGRESSIV);
    const mkt    = await axios.get(`${KONTO_AGGRESSIV.baseUrl}/markets/GOLD`, {
      headers: { 'X-CAP-API-KEY': KONTO_AGGRESSIV.apiKey, 'CST': KONTO_AGGRESSIV.cst, 'X-SECURITY-TOKEN': KONTO_AGGRESSIV.token }
    });
    const price = mkt.data.snapshot.offer;
    const sl    = (price * 0.99).toFixed(2);
    const tp    = (price * 1.02).toFixed(2);
    const size  = calcSize(equity, sl, tp, STRATEGIEN.aggressiv);
    await axios.post(`${KONTO_AGGRESSIV.baseUrl}/positions`, {
      epic: 'GOLD', direction: 'BUY', size, guaranteedStop: false, stopLevel: parseFloat(sl), profitLevel: parseFloat(tp)
    }, { headers: { 'X-CAP-API-KEY': KONTO_AGGRESSIV.apiKey, 'CST': KONTO_AGGRESSIV.cst, 'X-SECURITY-TOKEN': KONTO_AGGRESSIV.token } });
    await sendTelegram(`🟢 <b>TEST LONG</b>\nGröße: <b>${size}</b>\nSL: <b>${sl}$</b>\nTP: <b>${tp}$</b>`);
    res.json({ status: '✅ Test Trade platziert!', size, sl, tp });
  } catch (err) { res.json({ fehler: err.response?.data || err.message }); }
});

// ── Dashboard ─────────────────────────────────────────
app.get('/dashboard', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#fff;padding:24px}
h1{font-size:24px;font-weight:600;margin-bottom:6px}
.subtitle{color:#666;font-size:14px;margin-bottom:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px}
.card{background:#1a1a1a;border-radius:12px;padding:22px;border:1px solid #222;cursor:pointer;transition:border-color .15s}
.card:hover{border-color:#444}
.card h2{font-size:12px;color:#666;margin-bottom:14px;text-transform:uppercase;letter-spacing:1px;display:flex;justify-content:space-between;align-items:center}
.card h2 span.hint{font-size:10px;color:#333;text-transform:none;letter-spacing:0}
.equity{font-size:32px;font-weight:700;margin-bottom:14px}
.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1e1e1e}
.stat:last-of-type{border-bottom:none}
.stat-label{color:#666;font-size:13px}.stat-value{font-size:13px;font-weight:600}
.pos{color:#22c55e}.neg{color:#ef4444}
.tag{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700}
.tag-mittel{background:#1e3a5f;color:#60a5fa}
.tag-aggressiv{background:#3b1f00;color:#fb923c}
.tag-test{background:#1a3a1a;color:#4ade80}
.tag-konservativ{background:#1f3b2e;color:#34d399}
.tag-optimiert{background:#2a1f3b;color:#a78bfa}
.btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;margin-right:8px}
/* Direction bars */
.dir-bars{margin-top:12px;padding-top:12px;border-top:1px solid #1e1e1e}
.dir-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px}
.dir-label{width:36px;color:#555}
.dir-bar-wrap{flex:1;background:#111;border-radius:4px;height:6px;overflow:hidden}
.dir-bar{height:100%;border-radius:4px;transition:width .3s}
.dir-bar-buy{background:#22c55e}
.dir-bar-sell{background:#ef4444}
.dir-pct{width:36px;text-align:right;color:#444}
/* Equity Chart */
.chart-wrap{overflow:hidden;transition:max-height .4s;max-height:160px}
.chart-wrap.expanded{max-height:500px}
.chart-controls{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.chart-controls input[type=range]{flex:1;min-width:100px;accent-color:#4ade80}
.chart-controls button{background:#222;border:1px solid #333;color:#aaa;padding:5px 11px;border-radius:7px;font-size:12px;cursor:pointer}
.chart-controls button:hover{color:#fff}
/* Time filter */
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-bar button{background:#1a1a1a;border:1px solid #282828;color:#888;padding:6px 14px;border-radius:20px;font-size:12px;cursor:pointer;transition:all .15s}
.filter-bar button.active,.filter-bar button:hover{background:#222;border-color:#444;color:#fff}
/* Modal */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:200;align-items:center;justify-content:center;padding:16px}
.overlay.on{display:flex}
.modal{background:#161616;border:1px solid #2a2a2a;border-radius:16px;width:100%;max-width:720px;max-height:90vh;overflow-y:auto;padding:26px}
.modal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.modal-top h2{font-size:17px;font-weight:600}
.modal-close{background:#222;border:none;color:#777;font-size:18px;padding:3px 10px;border-radius:7px;cursor:pointer}
.modal-close:hover{color:#fff}
.date-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.date-bar input{background:#222;border:1px solid #333;color:#fff;padding:7px 11px;border-radius:8px;font-size:13px}
.date-bar button{background:#262626;border:1px solid #333;color:#aaa;padding:7px 13px;border-radius:8px;font-size:12px;cursor:pointer}
.date-bar button:hover{color:#fff;border-color:#555}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
.sbox{background:#1e1e1e;border-radius:10px;padding:14px;text-align:center}
.sbox .v{font-size:20px;font-weight:700}.sbox .l{font-size:11px;color:#555;margin-top:3px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#444;font-weight:500;padding:7px 8px;text-align:left;border-bottom:1px solid #222}
td{padding:9px 8px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
tr:last-child td{border:none}
.badge{display:inline-block;padding:2px 7px;border-radius:20px;font-size:11px;font-weight:700}
.buy-b{background:#1a3a1a;color:#4ade80}.sell-b{background:#3a1a1a;color:#ef4444}
.empty{text-align:center;padding:36px;color:#333;font-size:14px}
/* Open position */
.open-pos{background:#1a1a2e;border:1px solid #2d2d5e;border-radius:10px;padding:14px 18px;margin-top:12px;font-size:13px}
.open-pos .op-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.open-pos .op-tag{font-size:11px;color:#818cf8;font-weight:700}
.btn-close-pos{background:#3a1a1a;color:#ef4444;border:none;padding:5px 12px;border-radius:7px;font-size:12px;cursor:pointer}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
</head>
<body>
<h1>Trading Bot Dashboard</h1>
<p class="subtitle" id="updatezeit">Wird geladen...</p>

<!-- Time Filter -->
<div class="filter-bar">
  <button id="f7" class="active" onclick="setFilter(7)">Diese Woche</button>
  <button id="f30" onclick="setFilter(30)">Letzter Monat</button>
  <button id="f0" onclick="setFilter(0)">Alles</button>
</div>

<!-- Equity Chart -->
<div class="card" style="margin-bottom:16px;cursor:default">
  <h2>Equity Kurve — Alle Strategien</h2>
  <div class="chart-wrap" id="chartWrap">
    <canvas id="equityChart"></canvas>
  </div>
  <div class="chart-controls">
    <input type="range" id="zoomSlider" min="10" max="100" value="100" oninput="updateChartZoom(this.value)" title="Zoom">
    <span id="zoomLabel" style="color:#555;font-size:12px">100%</span>
    <button id="expandBtn" onclick="toggleChart()">Ausklappen</button>
    <button onclick="ladeChart()">Neu laden</button>
  </div>
</div>

<!-- Strategien Karten -->
<div class="grid2">
  <div class="card" onclick="openModal('mittel')">
    <h2><span class="tag tag-mittel">Mittel</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="m-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="m-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="m-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="m-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="m-dd">-</span></div>
    <div class="dir-bars" id="m-dirs"></div>
  </div>
  <div class="card" onclick="openModal('aggressiv')">
    <h2><span class="tag tag-aggressiv">Aggressiv</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="a-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="a-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="a-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="a-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="a-dd">-</span></div>
    <div class="dir-bars" id="a-dirs"></div>
  </div>
</div>
<div class="grid2">
  <div class="card" style="border-color:#2d1f5e" onclick="openModal('goldglobe')">
    <h2><span class="tag" style="background:#2d1f5e;color:#a78bfa">GoldGlobe</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="g-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="g-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="g-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="g-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="g-dd">-</span></div>
    <div class="dir-bars" id="g-dirs"></div>
  </div>
  <div class="card" style="border-color:#1a3a1a" onclick="openModal('test')">
    <h2><span class="tag tag-test">Test 1M</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="t-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="t-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="t-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="t-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="t-dd">-</span></div>
    <div class="dir-bars" id="t-dirs"></div>
  </div>
</div>
<!-- Neue Karten: Konservativ + Optimiert -->
<div class="grid2">
  <div class="card" style="border-color:#1f3b2e" onclick="openModal('konservativ')">
    <h2><span class="tag tag-konservativ">Konservativ</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="k-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="k-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="k-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="k-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="k-dd">-</span></div>
    <div class="dir-bars" id="k-dirs"></div>
    <div id="k-openpos"></div>
  </div>
  <div class="card" style="border-color:#2a1f3b" onclick="openModal('optimiert')">
    <h2><span class="tag tag-optimiert">Optimiert ✨</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="o-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="o-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="o-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="o-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="o-dd">-</span></div>
    <div class="dir-bars" id="o-dirs"></div>
    <div id="o-openpos"></div>
  </div>
</div>

<!-- Einzahlung -->
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
    <div id="modal-openpos" style="margin-bottom:14px"></div>
    <div class="summary">
      <div class="sbox"><div class="v" id="s-anz">—</div><div class="l">Trades</div></div>
      <div class="sbox"><div class="v" id="s-pnl">—</div><div class="l">Gesamt P&L</div></div>
      <div class="sbox"><div class="v" id="s-wl">—</div><div class="l">Win / Loss</div></div>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
let aktStrat   = 'test';
let filterTage = 7;
let chartInst  = null;
let allChartData = {};
let chartExpanded = false;
const namen = { mittel:'Mittel', aggressiv:'Aggressiv', goldglobe:'GoldGlobe', test:'Test 1M', konservativ:'Konservativ', optimiert:'Optimiert' };
const prefix = { mittel:'m', aggressiv:'a', goldglobe:'g', test:'t', konservativ:'k', optimiert:'o' };

function pf(v) { return v>0?'pos':v<0?'neg':''; }

function setFilter(tage) {
  filterTage = tage;
  ['f7','f30','f0'].forEach(id => document.getElementById(id).classList.remove('active'));
  const id = tage===7?'f7':tage===30?'f30':'f0';
  document.getElementById(id).classList.add('active');
  ladeChart();
}

function dirBars(p, id) {
  const el = document.getElementById(id);
  if (!el) return;
  const tot = (p.buyTrades||0) + (p.sellTrades||0);
  if (tot === 0) { el.innerHTML=''; return; }
  const buyPct  = Math.round((p.buyTrades||0)/tot*100);
  const sellPct = 100-buyPct;
  const buyPnl  = (p.buyPnL||0)>=0?'+':'';
  const sePnl   = (p.sellPnL||0)>=0?'+':'';
  el.innerHTML = \`
    <div class="dir-row"><span class="dir-label">LONG</span><div class="dir-bar-wrap"><div class="dir-bar dir-bar-buy" style="width:\${buyPct}%"></div></div><span class="dir-pct">\${buyPnl}\${(p.buyPnL||0).toFixed(0)}€</span></div>
    <div class="dir-row"><span class="dir-label">SHORT</span><div class="dir-bar-wrap"><div class="dir-bar dir-bar-sell" style="width:\${sellPct}%"></div></div><span class="dir-pct">\${sePnl}\${(p.sellPnL||0).toFixed(0)}€</span></div>
  \`;
}

function fillKarte(p, d) {
  const eq = d.aktuellesEquity;
  document.getElementById(p+'-equity').textContent = eq!=null?parseFloat(eq).toFixed(2)+' €':'—';
  document.getElementById(p+'-trades').textContent  = d.trades;
  document.getElementById(p+'-winrate').textContent = d.winRate+'%';
  const pel = document.getElementById(p+'-pnl');
  const pnlV = parseFloat(d.gesamtPnL);
  pel.textContent = (pnlV>=0?'+':'')+pnlV.toFixed(2)+' €';
  pel.className = 'stat-value '+pf(pnlV);
  document.getElementById(p+'-dd').textContent = d.drawdown+'%';
  const name = Object.entries(prefix).find(([,v])=>v===p)?.[0];
  if (name) dirBars(d, p+'-dirs');
}

async function laden() {
  try {
    const r = await fetch('/api/performance');
    if (!r.ok) throw new Error('HTTP '+r.status);
    const d = await r.json();
    document.getElementById('updatezeit').textContent = 'Letzte Aktualisierung: '+new Date(d.letzteAktualisierung).toLocaleString('de-DE');
    fillKarte('m',d.mittel); fillKarte('a',d.aggressiv); fillKarte('g',d.goldglobe);
    fillKarte('t',d.test);   fillKarte('k',d.konservativ||{}); fillKarte('o',d.optimiert||{});
    // Offene Positionen für konservativ + optimiert
    ladeOffenePosition('konservativ','k-openpos');
    ladeOffenePosition('optimiert','o-openpos');
  } catch(e) { document.getElementById('updatezeit').textContent = '❌ '+e.message; }
}

async function ladeOffenePosition(strat, elId) {
  try {
    const r = await fetch('/api/offene-position/'+strat);
    const d = await r.json();
    const el = document.getElementById(elId);
    if (!el) return;
    if (!d.position) { el.innerHTML=''; return; }
    const pos = d.position;
    const cl  = pos.pnl>=0?'pos':'neg';
    el.innerHTML = \`<div class="open-pos" onclick="event.stopPropagation()">
      <div class="op-header"><span class="op-tag">● OFFEN: \${pos.richtung} \${pos.groesse} Units</span>
      <button class="btn-close-pos" onclick="schliessePosition('\${strat}')">Schließen</button></div>
      <div style="font-size:12px;color:#666">Entry: <b style="color:#fff">\${pos.level}</b> &nbsp; SL: <b>\${pos.sl||'—'}</b> &nbsp; TP: <b>\${pos.tp||'—'}</b> &nbsp; P&L: <b class="\${cl}">\${pos.pnl>=0?'+':''}\${(pos.pnl||0).toFixed(2)}€</b></div>
    </div>\`;
  } catch(e) {}
}

async function schliessePosition(strat) {
  if (!confirm('Position für '+strat+' wirklich schließen?')) return;
  try {
    const r = await fetch('/api/schliesse-position/'+strat, {method:'POST'});
    const d = await r.json();
    alert(d.status==='ok'?'✅ Position geschlossen':'ℹ️ '+d.status);
    laden();
  } catch(e) { alert('❌ Fehler: '+e.message); }
}

function datumStr(offset) {
  const d=new Date(); d.setDate(d.getDate()+offset); return d.toISOString().slice(0,10);
}
function setTag(offset) { document.getElementById('modal-datum').value=datumStr(offset); }

function openModal(strat) {
  aktStrat = strat;
  document.getElementById('modal-titel').textContent = namen[strat]+' — Trades';
  setTag(0);
  document.getElementById('overlay').classList.add('on');
  ladeModalTrades();
  // Offene Position im Modal
  ladeOffenePosition(strat,'modal-openpos');
}
function closeModal() { document.getElementById('overlay').classList.remove('on'); }
function bgClose(e) { if(e.target===document.getElementById('overlay')) closeModal(); }

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
    if (!d.trades.length) { body.innerHTML='<div class="empty">Keine Trades</div>'; return; }
    let h = '<table><thead><tr><th>Zeit</th><th>Richtung</th><th>P&L</th><th>Equity</th><th>SL</th><th>TP</th></tr></thead><tbody>';
    for (const t of d.trades) {
      const z  = new Date(t.datum).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const cl = t.pnl>0?'pos':'neg';
      h += \`<tr><td>\${z}</td><td><span class="badge \${t.seite==='BUY'?'buy-b':'sell-b'}">\${t.seite}</span></td><td class="\${cl}">\${t.pnl>=0?'+':''}\${t.pnl.toFixed(2)}€</td><td>\${t.equity.toFixed(2)}€</td><td>\${t.sl}</td><td>\${t.tp}</td></tr>\`;
    }
    body.innerHTML = h+'</tbody></table>';
  } catch(e) { document.getElementById('modal-body').innerHTML='<div class="empty">Fehler: '+e.message+'</div>'; }
}

// ── Equity Chart ──────────────────────────────────────
let zoomPct = 100;

function updateChartZoom(val) {
  zoomPct = parseInt(val);
  document.getElementById('zoomLabel').textContent = val+'%';
  if (chartInst) renderChart();
}

function toggleChart() {
  chartExpanded = !chartExpanded;
  document.getElementById('chartWrap').className = 'chart-wrap'+(chartExpanded?' expanded':'');
  document.getElementById('expandBtn').textContent = chartExpanded ? 'Einklappen' : 'Ausklappen';
  if (chartInst) { chartInst.resize(); }
}

async function ladeChart() {
  try {
    const vonDate = filterTage > 0 ? new Date(Date.now()-filterTage*24*60*60*1000).toISOString().slice(0,10) : null;
    const datasets = [];
    const farben = { test:'#4ade80', mittel:'#60a5fa', aggressiv:'#fb923c', goldglobe:'#a78bfa', konservativ:'#34d399', optimiert:'#f472b6' };
    allChartData = {};
    for (const [name, farbe] of Object.entries(farben)) {
      const r = await fetch('/api/trades/'+name+(vonDate?'?von='+vonDate:''));
      const d = await r.json();
      if (!d.trades || !d.trades.length) continue;
      let eq = 1000; const pts = [{ x: 'Start', y: 1000 }];
      for (const t of d.trades) { eq = parseFloat((eq+t.pnl).toFixed(2)); pts.push({ x: new Date(t.datum).toLocaleDateString('de-DE'), y: eq }); }
      allChartData[name] = { pts, farbe };
    }
    renderChart();
  } catch(e) { console.error('Chart:', e.message); }
}

function renderChart() {
  const ctx = document.getElementById('equityChart').getContext('2d');
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const datasets = [];
  for (const [name, data] of Object.entries(allChartData)) {
    const pts = data.pts;
    const n   = Math.max(2, Math.floor(pts.length * zoomPct / 100));
    const sliced = pts.slice(-n);
    datasets.push({
      label: name, data: sliced.map(p=>p.y),
      borderColor: data.farbe, backgroundColor: data.farbe+'14',
      tension: 0.3, fill: false, pointRadius: sliced.length > 100 ? 0 : 2
    });
    // Use labels from first dataset
    if (!window._chartLabels || datasets.length === 1) window._chartLabels = sliced.map(p=>p.x);
  }
  if (!datasets.length) return;
  chartInst = new Chart(ctx, {
    type: 'line',
    data: { labels: window._chartLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#555', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#444', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: '#1a1a1a' } },
        y: { ticks: { color: '#555', callback: v => v.toFixed(0)+'€', font: { size: 10 } }, grid: { color: '#1a1a1a' } }
      }
    }
  });
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

// ── Tages-Reset um 00:00 UTC ──────────────────────────
function scheduleMidnightReset() {
  const now   = new Date();
  const next  = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  setTimeout(() => {
    ALLE_STRATEGIEN.forEach(n => { tagesStartEquity[n] = null; });
    console.log('🔄 Tages-Equity zurückgesetzt (00:00 UTC)');
    scheduleMidnightReset();
  }, next - now);
}
scheduleMidnightReset();

// ── Tägliche Telegram Zusammenfassung um 22:00 UTC ────
async function sendTageszusammenfassung() {
  try {
    const heute = new Date().toLocaleDateString('de-DE');
    let msg = `📊 <b>Tages-Zusammenfassung ${heute}</b>\n`;
    for (const name of ALLE_STRATEGIEN) {
      const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) === datumBerlin(new Date().toISOString()));
      if (!trades.length) continue;
      const pnl     = trades.reduce((s, t) => s + t.pnl, 0);
      const gewinn  = trades.filter(t => t.pnl > 0).length;
      const winRate = ((gewinn / trades.length) * 100).toFixed(0);
      const bester  = Math.max(...trades.map(t => t.pnl));
      const worst   = Math.min(...trades.map(t => t.pnl));
      msg += `\n<b>${name}</b>: ${trades.length} Trades | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}€ | Win: ${winRate}% | Best: +${bester.toFixed(2)}€ | Worst: ${worst.toFixed(2)}€`;
      msg += ` | Equity: ${letzteEquity[name].toFixed(2)}€`;
    }
    await sendTelegram(msg);
  } catch (err) { console.error('❌ Tageszusammenfassung:', err.message); }
}

function schedule22Uhr() {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(22, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { sendTageszusammenfassung(); schedule22Uhr(); }, next - now);
}
schedule22Uhr();

// ── Tägliches Backup um 23:00 UTC ────────────────────
async function sendeBackup() {
  try {
    const datum      = new Date().toISOString().slice(0, 10);
    const berichte   = '/data/berichte';
    if (!fs.existsSync(berichte)) fs.mkdirSync(berichte, { recursive: true });

    // Einstellungen ohne Keys
    const einstellungen = ALLE_STRATEGIEN.map(n => {
      const s = STRATEGIEN[n];
      return `${n}: riskPct=${s.riskPct}%, leverage=${s.leverage}, maxDrawdown=${s.maxDrawdownPct}%`;
    }).join('\n');

    // Obsidian .md Bericht
    let tagesPnL = 0, tagesTotalTrades = 0, tagesGewinn = 0;
    const equityLines = ALLE_STRATEGIEN.map(n => `  - ${n}: ${letzteEquity[n].toFixed(2)}€`).join('\n');
    for (const name of ALLE_STRATEGIEN) {
      const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) === datum);
      tagesPnL += trades.reduce((s, t) => s + t.pnl, 0);
      tagesGewinn += trades.filter(t => t.pnl > 0).length;
      tagesTotalTrades += trades.length;
    }
    const winRate = tagesTotalTrades > 0 ? ((tagesGewinn / tagesTotalTrades) * 100).toFixed(1) : '0';
    const einschaetzung = tagesPnL > 0 ? 'Profitabler Tag ✅' : tagesPnL < 0 ? 'Verlusttag ❌' : 'Neutraler Tag ⚪';

    const mdContent = `---
date: ${datum}
tags: [trading, gold, daily, bot]
---

# Trading Bericht ${datum}

## Equity
${equityLines}

## Tages-Performance
- Trades: ${tagesTotalTrades}
- Gesamt P&L: ${tagesPnL >= 0 ? '+' : ''}${tagesPnL.toFixed(2)}€
- Win Rate: ${winRate}%
- Einschätzung: ${einschaetzung}

## Bot-Einstellungen
\`\`\`
${einstellungen}
\`\`\`

#trading #gold #daily #bot
`;
    const mdPfad = `${berichte}/${datum}.md`;
    fs.writeFileSync(mdPfad, mdContent);

    // Email senden
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_TO) {
      const transporter = nodemailer.createTransporter({
        host:   process.env.SMTP_HOST || 'smtp.gmail.com',
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth:   { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });

      // README ohne Keys
      const readme = `# Trading Bot Backup ${datum}\n\nEinstellungen:\n${einstellungen}\n\nAPI-Keys: NICHT GESPEICHERT\n`;
      fs.writeFileSync('/tmp/README.md', readme);

      await transporter.sendMail({
        from:    process.env.EMAIL_USER,
        to:      process.env.EMAIL_TO,
        subject: `Trading Bot Backup ${datum}`,
        text:    `Tägliches Backup vom ${datum}.\nP&L: ${tagesPnL >= 0 ? '+' : ''}${tagesPnL.toFixed(2)}€ | Trades: ${tagesTotalTrades} | Win Rate: ${winRate}%`,
        attachments: [
          { filename: `bericht_${datum}.md`, content: mdContent },
          { filename: 'server_info.md', content: readme }
        ]
      });
      console.log(`📧 Backup Email gesendet: ${datum}`);
    }
  } catch (err) { console.error('❌ Backup Fehler:', err.message); }
}

function schedule23Uhr() {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(23, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { sendeBackup(); schedule23Uhr(); }, next - now);
}
schedule23Uhr();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf http://localhost:${PORT}`));
