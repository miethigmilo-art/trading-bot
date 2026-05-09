process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express    = require('express');
const axios      = require('axios');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const app        = express();
app.use(express.json());

// ── Konten ────────────────────────────────────────────
const KONTO_MITTEL      = { apiKey: process.env.API_KEY,            email: process.env.EMAIL,            password: process.env.PASSWORD,            baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_AGGRESSIV   = { apiKey: process.env.API_KEY_AGGRESSIV,  email: process.env.EMAIL_AGGRESSIV,  password: process.env.PASSWORD_AGGRESSIV,  baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_GOLDGLOBE   = { apiKey: process.env.API_KEY_GOLDGLOBE,  email: process.env.EMAIL_GOLDGLOBE,  password: process.env.PASSWORD_GOLDGLOBE,  baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_TEST        = { apiKey: process.env.API_KEY_TEST,       email: process.env.EMAIL_TEST,       password: process.env.PASSWORD_TEST,       baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_KONSERVATIV = { apiKey: process.env.API_KEY_KONSERVATIV,email: process.env.EMAIL_KONSERVATIV,password: process.env.PASSWORD_KONSERVATIV, baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_OPTIMIERT   = { apiKey: process.env.API_KEY_OPTIMIERT,  email: process.env.EMAIL_OPTIMIERT,  password: process.env.PASSWORD_OPTIMIERT,  baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_SIDEWAYS    = { apiKey: process.env.API_KEY_SIDEWAYS,   email: process.env.EMAIL_SIDEWAYS,   password: process.env.PASSWORD_SIDEWAYS,   baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_TEST2       = { apiKey: process.env.API_KEY_TEST2,      email: process.env.EMAIL_TEST2,      password: process.env.PASSWORD_TEST2,      baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_STEADY      = { apiKey: process.env.API_KEY_STEADY,     email: process.env.EMAIL_STEADY,     password: process.env.PASSWORD_STEADY,     baseUrl: process.env.BASE_URL, cst: null, token: null };

// ── Strategien ────────────────────────────────────────
// Alle Fixes auf alle Strategien: calcSizeFixed, closeOpenPosition,
// Duplikat-Schutz, Tages-Stop, RRR-Check, Webhook Secret
const STRATEGIEN = {
  mittel:      { konto: KONTO_MITTEL,      epic: 'GOLD', riskPct: 1.5, leverage: 5, maxDrawdownPct: 20, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  aggressiv:   { konto: KONTO_AGGRESSIV,   epic: 'GOLD', riskPct: 2.0, leverage: 5, maxDrawdownPct: 30, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  goldglobe:   { konto: KONTO_GOLDGLOBE,   epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 20, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  test:        { konto: KONTO_TEST,        epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  konservativ: { konto: KONTO_KONSERVATIV, epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  optimiert:   { konto: KONTO_OPTIMIERT,   epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  sideways:    { konto: KONTO_SIDEWAYS,    epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 20, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 1.0 },
  test2:       { konto: KONTO_TEST2,       epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStopPct: 5.0,  minRRR: 2.0 },
  steady:      { konto: KONTO_STEADY,      epic: 'GOLD', riskPct: 0.2, leverage: 2, maxDrawdownPct: 3,  startEquity: 1000, tagsStopPct: 0.05, tagsVerlustPct: 0.1, minRRR: 2.0 },
};

const ALLE_STRATEGIEN = Object.keys(STRATEGIEN);

// ── Performance State ─────────────────────────────────
function neuPerf() {
  return { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0,
           buyTrades: 0, sellTrades: 0, buyGewinn: 0, sellGewinn: 0, buyPnL: 0, sellPnL: 0 };
}
let performance = {};
ALLE_STRATEGIEN.forEach(n => { performance[n] = neuPerf(); });

let letzteEquity = {};
ALLE_STRATEGIEN.forEach(n => { letzteEquity[n] = STRATEGIEN[n].startEquity; });
let letzteAktualisierung = new Date().toISOString();

let tagesStartEquity = {};
ALLE_STRATEGIEN.forEach(n => { tagesStartEquity[n] = null; });

const aktiveTrades = {};
const letzterTrade = {};

// ── Dateien ───────────────────────────────────────────
const EQUITY_FILE = '/data/equity.json';
const TRADES_FILE = '/data/trades.json';

function ladeEquityDaten() {
  try { if (fs.existsSync(EQUITY_FILE)) return JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8')); }
  catch (err) { console.error('❌ Equity laden:', err.message); }
  const d = {}; ALLE_STRATEGIEN.forEach(n => { d[n] = []; }); return d;
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
  try { if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch (err) { console.error('❌ Trades laden:', err.message); }
  const d = {}; ALLE_STRATEGIEN.forEach(n => { d[n] = []; }); return d;
}
function speichereTradeDaten(d) {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(d, null, 2)); }
  catch (err) { console.error('❌ Trades speichern:', err.message); }
}
let tradeVerlauf = ladeTradeDaten();
ALLE_STRATEGIEN.forEach(n => { if (!tradeVerlauf[n]) tradeVerlauf[n] = []; });

// Performance beim Start wiederherstellen
(function initAusDaten() {
  for (const [name, punkte] of Object.entries(equityVerlauf)) {
    if (punkte.length > 0) letzteEquity[name] = punkte[punkte.length - 1].equity;
  }
  for (const [name, trades] of Object.entries(tradeVerlauf)) {
    if (!performance[name] || !trades.length) continue;
    const p = performance[name];
    for (const t of trades) {
      p.trades++; p.gesamtPnL += t.pnl;
      if (t.pnl > 0) p.gewinn++; else p.verlust++;
      if (t.pnl > p.bestesTrade)       p.bestesTrade       = t.pnl;
      if (t.pnl < p.schlechtestesTrade) p.schlechtestesTrade = t.pnl;
      if (t.seite === 'BUY')  { p.buyTrades++;  p.buyPnL  += t.pnl; if (t.pnl > 0) p.buyGewinn++;  }
      if (t.seite === 'SELL') { p.sellTrades++; p.sellPnL += t.pnl; if (t.pnl > 0) p.sellGewinn++; }
    }
    if (trades.length > 0) letzteAktualisierung = trades[trades.length - 1].datum;
  }
  console.log('📊 Performance wiederhergestellt:', ALLE_STRATEGIEN.map(n => `${n}:${performance[n].trades}T`).join(' '));
})();

function tradeHinzufuegen(name, trade) {
  if (!tradeVerlauf[name]) tradeVerlauf[name] = [];
  tradeVerlauf[name].push(trade);
  speichereTradeDaten(tradeVerlauf);
  console.log(`📝 [${name}] PnL ${trade.pnl >= 0 ? '+' : ''}${trade.pnl}€`);
}

// ── Login ─────────────────────────────────────────────
async function login(konto) {
  const res = await axios.post(`${konto.baseUrl}/session`,
    { identifier: konto.email, password: konto.password },
    { headers: { 'X-CAP-API-KEY': konto.apiKey } });
  konto.cst   = res.headers['cst'];
  konto.token = res.headers['x-security-token'];
  console.log(`✅ Login: ${konto.email}`);
}

// ── Equity ────────────────────────────────────────────
async function getEquity(konto) {
  try {
    const res = await axios.get(`${konto.baseUrl}/accounts`, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });
    const bal = res.data.accounts[0]?.balance;
    return bal?.balance ?? bal?.available ?? bal;
  } catch (err) {
    if (err.response?.status === 401) { await login(konto); return getEquity(konto); }
    throw err;
  }
}

// ── Positionen ────────────────────────────────────────
async function getOpenPosition(konto, epic) {
  const res = await axios.get(`${konto.baseUrl}/positions`, {
    headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
  });
  return (res.data.positions || []).find(p => p.market?.epic === epic) || null;
}

async function closeOpenPosition(konto, epic) {
  try {
    const res = await axios.get(`${konto.baseUrl}/positions`, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });
    for (const pos of (res.data.positions || []).filter(p => p.market?.epic === epic)) {
      await axios.delete(`${konto.baseUrl}/positions/${pos.position.dealId}`, {
        headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
      });
      console.log(`🔒 Position geschlossen: ${pos.position.dealId}`);
    }
  } catch (err) { console.error('❌ closeOpenPosition:', err.message); }
}

// ── Positionsgröße (korrekt, ohne doppelten Leverage) ─
function calcSizeFixed(equity, sl, tp, strategie) {
  const riskCapital = equity * (strategie.riskPct / 100);
  const slDistance  = Math.abs(parseFloat(tp) - parseFloat(sl));
  if (slDistance === 0) return 1;
  return Math.max(1, parseFloat((riskCapital / slDistance).toFixed(1)));
}

// ── Drawdown ──────────────────────────────────────────
function checkDrawdown(equity, strategie, name) {
  if (performance[name].trades === 0) return false;
  return ((strategie.startEquity - equity) / strategie.startEquity) * 100 >= strategie.maxDrawdownPct;
}

// ── Performance ───────────────────────────────────────
function updatePerformance(name, pnl, seite) {
  const p = performance[name];
  p.trades++; p.gesamtPnL += pnl;
  if (pnl > 0) p.gewinn++; else p.verlust++;
  if (pnl > p.bestesTrade)       p.bestesTrade       = pnl;
  if (pnl < p.schlechtestesTrade) p.schlechtestesTrade = pnl;
  if (seite === 'BUY')  { p.buyTrades++;  p.buyPnL  += pnl; if (pnl > 0) p.buyGewinn++;  }
  if (seite === 'SELL') { p.sellTrades++; p.sellPnL += pnl; if (pnl > 0) p.sellGewinn++; }
  letzteAktualisierung = new Date().toISOString();
}

// ── Telegram ──────────────────────────────────────────
async function sendTelegram(nachricht) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text: nachricht, parse_mode: 'HTML' });
  } catch (err) { console.error('❌ Telegram:', err.message); }
}

// ── Timezone Helper ───────────────────────────────────
function datumBerlin(isoString) {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(isoString));
  const p = {}; parts.forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

// ── Universeller Webhook Handler — alle Fixes ─────────
async function handleWebhook(req, res, name) {
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const konto = strategie.konto;

  // Webhook Secret
  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Ungültiger Webhook Secret' });
  }

  // Duplikat-Schutz + Cooldown
  if (aktiveTrades[name]) return res.status(429).json({ error: 'Trade läuft bereits' });
  const jetzt = Date.now();
  if (letzterTrade[name] && jetzt - letzterTrade[name] < 30000) {
    return res.status(429).json({ error: 'Cooldown aktiv (30s)' });
  }
  aktiveTrades[name] = true;

  try {
    console.log(`📨 Signal [${name}]:`, req.body);
    const { side, sl, tp } = req.body;
    if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder' });

    if (!konto.cst) await login(konto);
    const equity = await getEquity(konto);

    // Tages-Stop initialisieren
    if (tagesStartEquity[name] === null) tagesStartEquity[name] = equity;
    const tagesPct = ((equity - tagesStartEquity[name]) / tagesStartEquity[name]) * 100;

    // Tages-Gewinn-Stop
    if (tagesPct >= strategie.tagsStopPct) {
      const msg = name === 'steady'
        ? `✅ Steady Tagesziel erreicht! +0.05% — Bot pausiert bis morgen`
        : `🎯 Tagesziel erreicht! +${strategie.tagsStopPct}% — ${name} pausiert bis morgen`;
      await sendTelegram(msg);
      return res.json({ status: 'pausiert', grund: 'Tagesziel erreicht' });
    }

    // Tages-Verlust-Stop (steady)
    if (strategie.tagsVerlustPct && tagesPct <= -strategie.tagsVerlustPct) {
      await sendTelegram(`🛑 ${name} Tagesverlust-Stop: -${strategie.tagsVerlustPct}% — Bot pausiert bis morgen`);
      return res.json({ status: 'pausiert', grund: 'Tagesverlust-Stop erreicht' });
    }

    // Max Drawdown
    if (checkDrawdown(equity, strategie, name)) {
      await sendTelegram(`🛑 <b>Bot gestoppt!</b>\nStrategie: <b>${name}</b>\nMax. Drawdown erreicht!`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown erreicht' });
    }

    // Trade-PnL aufzeichnen (Equity-Differenz zum letzten Signal)
    const pnl = equity - letzteEquity[name];
    if (pnl !== 0) {
      updatePerformance(name, pnl, side);
      tradeHinzufuegen(name, {
        datum: new Date().toISOString(),
        pnl:    parseFloat(pnl.toFixed(2)),
        equity: parseFloat(equity.toFixed(2)),
        seite:  side,
        sl:     parseFloat(sl),
        tp:     parseFloat(tp)
      });
    }
    letzteEquity[name] = equity;
    equityPunktHinzufuegen(name, equity);

    // RRR erzwingen
    let slFloat = parseFloat(sl);
    let tpFloat = parseFloat(tp);
    const minRRR = strategie.minRRR || 2.0;
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
        console.log(`📐 [${name}] RRR angepasst: TP → ${tpFloat}`);
      }
    } catch (rrrErr) { console.error('⚠️ RRR Preis-Check:', rrrErr.message); }

    // Offene Position schließen vor neuer Order
    await closeOpenPosition(konto, strategie.epic);

    // Order platzieren
    const size  = calcSizeFixed(equity, slFloat, tpFloat, strategie);
    const order = { epic: strategie.epic, direction: side, size, guaranteedStop: false, stopLevel: slFloat, profitLevel: tpFloat };
    console.log(`📤 [${name}] Order:`, order);
    await axios.post(`${konto.baseUrl}/positions`, order, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });

    await sendTelegram(`${side === 'BUY' ? '🟢' : '🔴'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'} eröffnet</b>\nStrategie: <b>${name}</b>\nGröße: <b>${size} Units</b>\nSL: <b>${slFloat}$</b>\nTP: <b>${tpFloat}$</b>`);
    res.json({ status: 'ok', strategie: name, size, sl: slFloat, tp: tpFloat });

  } catch (err) {
    if (err.response?.status === 401) { konto.cst = null; await login(konto); return res.status(500).json({ error: 'Session erneuert' }); }
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
app.post('/webhook/konservativ', (req, res) => handleWebhook(req, res, 'konservativ'));
app.post('/webhook/optimiert',   (req, res) => handleWebhook(req, res, 'optimiert'));
app.post('/webhook/sideways',    (req, res) => handleWebhook(req, res, 'sideways'));
app.post('/webhook/test2',       (req, res) => handleWebhook(req, res, 'test2'));
app.post('/webhook/steady',      (req, res) => handleWebhook(req, res, 'steady'));

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

// ── Performance API ───────────────────────────────────
app.get('/api/performance', async (req, res) => {
  async function tryEquity(konto) {
    try { if (!konto.cst) await login(konto); return await getEquity(konto); }
    catch (err) { console.error(`❌ Equity (${konto.email}):`, err.message); return null; }
  }
  // Fix #1: gesamtPnL = aktuelleEquity - startEquity (nicht kumulativ)
  function buildStats(name, strat, equity) {
    const p = performance[name];
    const gesamtPnL = equity != null
      ? parseFloat((equity - strat.startEquity).toFixed(2))
      : parseFloat(((letzteEquity[name] || strat.startEquity) - strat.startEquity).toFixed(2));
    const dd = equity != null && p.trades > 0
      ? (((strat.startEquity - equity) / strat.startEquity) * 100).toFixed(2)
      : '0.00';
    return {
      ...p,
      aktuellesEquity: equity,
      gesamtPnL,
      drawdown:    dd,
      winRate:     p.trades > 0      ? ((p.gewinn    / p.trades)      * 100).toFixed(1) : '0',
      buyWinRate:  p.buyTrades > 0   ? ((p.buyGewinn / p.buyTrades)   * 100).toFixed(1) : '0',
      sellWinRate: p.sellTrades > 0  ? ((p.sellGewinn/ p.sellTrades)  * 100).toFixed(1) : '0',
      buyPnL:  parseFloat(p.buyPnL.toFixed(2)),
      sellPnL: parseFloat(p.sellPnL.toFixed(2))
    };
  }
  const equities = await Promise.all(ALLE_STRATEGIEN.map(n => tryEquity(STRATEGIEN[n].konto)));
  const result   = { letzteAktualisierung };
  ALLE_STRATEGIEN.forEach((n, i) => { result[n] = buildStats(n, STRATEGIEN[n], equities[i]); });
  res.json(result);
});

// ── Equity API ────────────────────────────────────────
app.get('/api/equity', (req, res) => { res.json(equityVerlauf); });

// ── Trades API ────────────────────────────────────────
app.get('/api/trades/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });

  const { datum, von, bis } = req.query;
  let trades = tradeVerlauf[name] || [];

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
    buyCount:    buyTrades.length,
    sellCount:   sellTrades.length,
    buyWinRate:  buyTrades.length  > 0 ? ((buyTrades.filter(t=>t.pnl>0).length  / buyTrades.length)  * 100).toFixed(1) : '0',
    sellWinRate: sellTrades.length > 0 ? ((sellTrades.filter(t=>t.pnl>0).length / sellTrades.length) * 100).toFixed(1) : '0',
    buyPnL:  parseFloat(buyTrades.reduce((s,t)=>s+t.pnl,0).toFixed(2)),
    sellPnL: parseFloat(sellTrades.reduce((s,t)=>s+t.pnl,0).toFixed(2))
  });
});

// ── Analyse API ───────────────────────────────────────
app.get('/api/analyse/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const trades = tradeVerlauf[name] || [];

  const stunden    = Array.from({ length: 24 }, (_, i) => ({ stunde: i, trades: 0, gesamtPnL: 0, gewinn: 0 }));
  const wochentage = ['So','Mo','Di','Mi','Do','Fr','Sa'].map((n,i) => ({ tag: n, tagNr: i, trades: 0, gesamtPnL: 0, gewinn: 0 }));

  for (const t of trades) {
    const d  = new Date(t.datum);
    const h  = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(d);
    const wd = d.getUTCDay();
    const hi = parseInt(h);
    if (hi >= 0 && hi < 24) {
      stunden[hi].trades++; stunden[hi].gesamtPnL += t.pnl; if (t.pnl > 0) stunden[hi].gewinn++;
    }
    wochentage[wd].trades++; wochentage[wd].gesamtPnL += t.pnl; if (t.pnl > 0) wochentage[wd].gewinn++;
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
    const p = position.position, m = position.market;
    res.json({ position: { dealId: p.dealId, richtung: p.direction, groesse: p.size, pnl: p.upl, level: p.level, sl: p.stopLevel, tp: p.limitLevel, epic: m.epic, name: m.instrumentName } });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  const rows = trades.map(t => {
    const d  = new Date(t.datum);
    const cl = t.pnl > 0 ? 'color:#22c55e' : 'color:#ef4444';
    return `<tr><td>${d.toLocaleDateString('de-DE')}</td><td>${d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</td><td>${t.seite}</td><td style="${cl}">${t.pnl>=0?'+':''}${t.pnl.toFixed(2)}€</td><td>${t.equity.toFixed(2)}€</td><td>${t.sl}</td><td>${t.tp}</td></tr>`;
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
td{padding:9px 8px;border-bottom:1px solid #1a1a1a}</style></head><body>
<h1>Wochenbericht — ${name}</h1><p class="sub">${vonStr} bis ${bisStr}</p>
<div class="stats">
  <div class="s"><div class="v">${trades.length}</div><div class="l">Trades</div></div>
  <div class="s"><div class="v ${gesamtPnL>=0?'pos':'neg'}">${gesamtPnL>=0?'+':''}${gesamtPnL.toFixed(2)}€</div><div class="l">Gesamt P&L</div></div>
  <div class="s"><div class="v">${winRate}%</div><div class="l">Win Rate</div></div>
  <div class="s"><div class="v">${gewinn} / ${trades.length-gewinn}</div><div class="l">Win / Loss</div></div>
</div>
<table><thead><tr><th>Datum</th><th>Zeit</th><th>Richtung</th><th>P&L</th><th>Equity</th><th>SL</th><th>TP</th></tr></thead>
<tbody>${rows||'<tr><td colspan="7" style="text-align:center;padding:24px;color:#333">Keine Trades</td></tr>'}</tbody></table>
</body></html>`);
});

// ── Reset ─────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  ALLE_STRATEGIEN.forEach(n => { performance[n] = neuPerf(); letzteEquity[n] = STRATEGIEN[n].startEquity; });
  letzteAktualisierung = new Date().toISOString();
  res.json({ status: 'ok' });
});

// ── Einzahlung / Auszahlung ───────────────────────────
app.get('/api/einzahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  const targets = strategie === 'alle' ? ALLE_STRATEGIEN : [strategie];
  for (const n of targets) {
    if (STRATEGIEN[n]) { STRATEGIEN[n].startEquity += betrag; letzteEquity[n] += betrag; }
  }
  sendTelegram(`💰 <b>Einzahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

app.get('/api/auszahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  const targets = strategie === 'alle' ? ALLE_STRATEGIEN : [strategie];
  for (const n of targets) {
    if (STRATEGIEN[n]) { STRATEGIEN[n].startEquity -= betrag; letzteEquity[n] -= betrag; }
  }
  sendTelegram(`💸 <b>Auszahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

// ── Test Endpoints ────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    if (!KONTO_MITTEL.cst) await login(KONTO_MITTEL);
    const em = await getEquity(KONTO_MITTEL);
    res.json({ status: '✅ Verbunden', equityMittel: em + '€' });
  } catch (err) { res.json({ status: '❌ Fehler', fehler: err.message }); }
});

app.get('/test/trade', async (req, res) => {
  try {
    if (!KONTO_TEST.cst) await login(KONTO_TEST);
    const equity = await getEquity(KONTO_TEST);
    const mkt    = await axios.get(`${KONTO_TEST.baseUrl}/markets/GOLD`, {
      headers: { 'X-CAP-API-KEY': KONTO_TEST.apiKey, 'CST': KONTO_TEST.cst, 'X-SECURITY-TOKEN': KONTO_TEST.token }
    });
    const price = mkt.data.snapshot.offer;
    const sl    = (price * 0.99).toFixed(2);
    const tp    = (price * 1.02).toFixed(2);
    const size  = calcSizeFixed(equity, sl, tp, STRATEGIEN.test);
    await axios.post(`${KONTO_TEST.baseUrl}/positions`,
      { epic: 'GOLD', direction: 'BUY', size, guaranteedStop: false, stopLevel: parseFloat(sl), profitLevel: parseFloat(tp) },
      { headers: { 'X-CAP-API-KEY': KONTO_TEST.apiKey, 'CST': KONTO_TEST.cst, 'X-SECURITY-TOKEN': KONTO_TEST.token } });
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
.btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;margin-right:8px}
.dir-bars{margin-top:12px;padding-top:12px;border-top:1px solid #1e1e1e}
.dir-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px}
.dir-label{width:36px;color:#555}
.dir-bar-wrap{flex:1;background:#111;border-radius:4px;height:6px;overflow:hidden}
.dir-bar{height:100%;border-radius:4px;transition:width .3s}
.dir-bar-buy{background:#22c55e}.dir-bar-sell{background:#ef4444}
.dir-pct{width:36px;text-align:right;color:#444}
.chart-wrap{overflow:hidden;transition:max-height .4s;max-height:160px}
.chart-wrap.expanded{max-height:520px}
.chart-controls{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.chart-controls input[type=range]{flex:1;min-width:100px;accent-color:#4ade80}
.chart-controls button{background:#222;border:1px solid #333;color:#aaa;padding:5px 11px;border-radius:7px;font-size:12px;cursor:pointer}
.chart-controls button:hover{color:#fff}
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-bar button{background:#1a1a1a;border:1px solid #282828;color:#888;padding:6px 14px;border-radius:20px;font-size:12px;cursor:pointer;transition:all .15s}
.filter-bar button.active,.filter-bar button:hover{background:#222;border-color:#444;color:#fff}
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

<div class="filter-bar">
  <button id="f7" class="active" onclick="setFilter(7)">Diese Woche</button>
  <button id="f30" onclick="setFilter(30)">Letzter Monat</button>
  <button id="f0" onclick="setFilter(0)">Alles</button>
</div>

<div class="card" style="margin-bottom:16px;cursor:default">
  <h2>Equity Kurve — Alle Strategien</h2>
  <div class="chart-wrap" id="chartWrap">
    <canvas id="equityChart" style="min-height:140px"></canvas>
  </div>
  <div class="chart-controls">
    <input type="range" id="zoomSlider" min="5" max="100" value="100" oninput="updateChartZoom(this.value)" title="Zoom">
    <span id="zoomLabel" style="color:#555;font-size:12px">100%</span>
    <button id="expandBtn" onclick="toggleChart()">Ausklappen</button>
    <button onclick="ladeChart()">Neu laden</button>
  </div>
</div>

<div class="grid2">
  <div class="card" onclick="openModal('mittel')">
    <h2><span class="tag" style="background:#1e3a5f;color:#60a5fa">Mittel</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="m-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="m-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="m-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="m-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="m-dd">-</span></div>
    <div class="dir-bars" id="m-dirs"></div>
    <div id="m-openpos"></div>
  </div>
  <div class="card" onclick="openModal('aggressiv')">
    <h2><span class="tag" style="background:#3b1f00;color:#fb923c">Aggressiv</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="a-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="a-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="a-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="a-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="a-dd">-</span></div>
    <div class="dir-bars" id="a-dirs"></div>
    <div id="a-openpos"></div>
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
    <div id="g-openpos"></div>
  </div>
  <div class="card" style="border-color:#1a3a1a" onclick="openModal('test')">
    <h2><span class="tag" style="background:#1a3a1a;color:#4ade80">Test 1M</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="t-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="t-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="t-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="t-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="t-dd">-</span></div>
    <div class="dir-bars" id="t-dirs"></div>
    <div id="t-openpos"></div>
  </div>
</div>
<div class="grid2">
  <div class="card" style="border-color:#1f3b2e" onclick="openModal('konservativ')">
    <h2><span class="tag" style="background:#1f3b2e;color:#34d399">Konservativ</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="k-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="k-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="k-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="k-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="k-dd">-</span></div>
    <div class="dir-bars" id="k-dirs"></div>
    <div id="k-openpos"></div>
  </div>
  <div class="card" style="border-color:#2a1f3b" onclick="openModal('optimiert')">
    <h2><span class="tag" style="background:#2a1f3b;color:#a78bfa">Optimiert ✨</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="o-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="o-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="o-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="o-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="o-dd">-</span></div>
    <div class="dir-bars" id="o-dirs"></div>
    <div id="o-openpos"></div>
  </div>
</div>
<div class="grid3">
  <div class="card" style="border-color:#2d2a00" onclick="openModal('sideways')">
    <h2><span class="tag" style="background:#2d2a00;color:#fbbf24">Sideways ↔</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="sw-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="sw-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="sw-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="sw-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="sw-dd">-</span></div>
    <div class="dir-bars" id="sw-dirs"></div>
    <div id="sw-openpos"></div>
  </div>
  <div class="card" style="border-color:#003a3a" onclick="openModal('test2')">
    <h2><span class="tag" style="background:#003a3a;color:#38bdf8">Test2 1M</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="t2-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="t2-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="t2-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="t2-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="t2-dd">-</span></div>
    <div class="dir-bars" id="t2-dirs"></div>
    <div id="t2-openpos"></div>
  </div>
  <div class="card" style="border-color:#3a0030" onclick="openModal('steady')">
    <h2><span class="tag" style="background:#3a0030;color:#e879f9">Steady 0.05%</span><span class="hint">Trades →</span></h2>
    <div class="equity pos" id="st-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="st-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="st-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="st-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="st-dd">-</span></div>
    <div class="dir-bars" id="st-dirs"></div>
    <div id="st-openpos"></div>
  </div>
</div>

<div class="card" style="margin-top:16px;margin-bottom:16px;cursor:default">
  <h2 style="margin-bottom:14px">EIN- / AUSZAHLUNG</h2>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><div style="color:#555;font-size:11px;margin-bottom:5px">BETRAG (€)</div>
      <input type="number" id="betrag" placeholder="500" style="background:#222;border:1px solid #333;color:#fff;padding:9px 11px;border-radius:8px;width:120px;font-size:14px"></div>
    <div><div style="color:#555;font-size:11px;margin-bottom:5px">STRATEGIE</div>
      <select id="strategie" style="background:#222;border:1px solid #333;color:#fff;padding:9px 11px;border-radius:8px;font-size:13px">
        <option value="mittel">Mittel</option><option value="aggressiv">Aggressiv</option>
        <option value="goldglobe">GoldGlobe</option><option value="test">Test</option>
        <option value="konservativ">Konservativ</option><option value="optimiert">Optimiert</option>
        <option value="sideways">Sideways</option><option value="test2">Test2</option>
        <option value="steady">Steady</option><option value="alle">Alle</option>
      </select></div>
    <button class="btn" style="background:#1a3a1a;color:#22c55e" onclick="einzahlung()">Einzahlen</button>
    <button class="btn" style="background:#3a1a1a;color:#ef4444" onclick="auszahlung()">Auszahlen</button>
  </div>
  <div id="zahlung-status" style="margin-top:10px;font-size:12px;color:#555"></div>
</div>
<button class="btn" style="background:#222;color:#fff" onclick="laden()">Aktualisieren</button>
<button class="btn" style="background:#1a0000;color:#ef4444" onclick="reset()">Reset</button>

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
let aktStrat     = 'test';
let filterTage   = 7;
let chartInst    = null;
let allChartData = {};
let chartExpanded = false;
let zoomPct      = 100;

const namen  = { mittel:'Mittel', aggressiv:'Aggressiv', goldglobe:'GoldGlobe', test:'Test 1M', konservativ:'Konservativ', optimiert:'Optimiert', sideways:'Sideways', test2:'Test2 1M', steady:'Steady' };
const prefix = { mittel:'m', aggressiv:'a', goldglobe:'g', test:'t', konservativ:'k', optimiert:'o', sideways:'sw', test2:'t2', steady:'st' };
const farben  = { mittel:'#60a5fa', aggressiv:'#fb923c', goldglobe:'#a78bfa', test:'#4ade80', konservativ:'#34d399', optimiert:'#f472b6', sideways:'#fbbf24', test2:'#38bdf8', steady:'#e879f9' };

function pf(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }

function setFilter(tage) {
  filterTage = tage;
  ['f7','f30','f0'].forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById(tage===7?'f7':tage===30?'f30':'f0').classList.add('active');
  ladeChart();
}

function dirBars(p, id) {
  const el = document.getElementById(id);
  if (!el) return;
  const tot = (p.buyTrades||0) + (p.sellTrades||0);
  if (tot === 0) { el.innerHTML = ''; return; }
  const buyPct  = Math.round((p.buyTrades||0) / tot * 100);
  const buyPnl  = (p.buyPnL||0) >= 0 ? '+' : '';
  const sePnl   = (p.sellPnL||0) >= 0 ? '+' : '';
  el.innerHTML = \`
    <div class="dir-row"><span class="dir-label">LONG</span><div class="dir-bar-wrap"><div class="dir-bar dir-bar-buy" style="width:\${buyPct}%"></div></div><span class="dir-pct">\${buyPnl}\${(p.buyPnL||0).toFixed(0)}€</span></div>
    <div class="dir-row"><span class="dir-label">SHORT</span><div class="dir-bar-wrap"><div class="dir-bar dir-bar-sell" style="width:\${100-buyPct}%"></div></div><span class="dir-pct">\${sePnl}\${(p.sellPnL||0).toFixed(0)}€</span></div>
  \`;
}

function fillKarte(p, d) {
  if (!d || !document.getElementById(p+'-equity')) return;
  const eq = d.aktuellesEquity;
  document.getElementById(p+'-equity').textContent = eq != null ? parseFloat(eq).toFixed(2) + ' €' : '—';
  document.getElementById(p+'-trades').textContent  = d.trades || 0;
  document.getElementById(p+'-winrate').textContent = (d.winRate || '0') + '%';
  const pel = document.getElementById(p+'-pnl');
  const pnlV = parseFloat(d.gesamtPnL || 0);
  pel.textContent = (pnlV >= 0 ? '+' : '') + pnlV.toFixed(2) + ' €';
  pel.className   = 'stat-value ' + pf(pnlV);
  document.getElementById(p+'-dd').textContent = (d.drawdown || '0') + '%';
  const name = Object.entries(prefix).find(([,v]) => v === p)?.[0];
  if (name) dirBars(d, p+'-dirs');
}

async function laden() {
  try {
    const r = await fetch('/api/performance');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    document.getElementById('updatezeit').textContent = 'Letzte Aktualisierung: ' + new Date(d.letzteAktualisierung).toLocaleString('de-DE');
    Object.entries(prefix).forEach(([name, p]) => fillKarte(p, d[name] || {}));
    Object.keys(prefix).forEach(name => ladeOffenePosition(name, prefix[name]+'-openpos'));
  } catch(e) { document.getElementById('updatezeit').textContent = '❌ ' + e.message; }
}

async function ladeOffenePosition(strat, elId) {
  try {
    const r = await fetch('/api/offene-position/' + strat);
    const d = await r.json();
    const el = document.getElementById(elId);
    if (!el) return;
    if (!d.position) { el.innerHTML = ''; return; }
    const pos = d.position;
    const cl  = pos.pnl >= 0 ? 'pos' : 'neg';
    el.innerHTML = \`<div class="open-pos" onclick="event.stopPropagation()">
      <div class="op-header"><span class="op-tag">● OFFEN: \${pos.richtung} \${pos.groesse} Units</span>
      <button class="btn-close-pos" onclick="schliessePosition('\${strat}')">Schließen</button></div>
      <div style="font-size:12px;color:#666">Entry: <b style="color:#fff">\${pos.level}</b> &nbsp; SL: <b>\${pos.sl||'—'}</b> &nbsp; TP: <b>\${pos.tp||'—'}</b> &nbsp; P&L: <b class="\${cl}">\${pos.pnl>=0?'+':''}\${(pos.pnl||0).toFixed(2)}€</b></div>
    </div>\`;
  } catch(e) {}
}

async function schliessePosition(strat) {
  if (!confirm('Position für ' + strat + ' wirklich schließen?')) return;
  try {
    const r = await fetch('/api/schliesse-position/' + strat, { method: 'POST' });
    const d = await r.json();
    alert(d.status === 'ok' ? '✅ Position geschlossen' : 'ℹ️ ' + d.status);
    laden();
  } catch(e) { alert('❌ Fehler: ' + e.message); }
}

function datumStr(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10);
}
function setTag(offset) { document.getElementById('modal-datum').value = datumStr(offset); }

function openModal(strat) {
  aktStrat = strat;
  document.getElementById('modal-titel').textContent = namen[strat] + ' — Trades';
  setTag(0);
  document.getElementById('overlay').classList.add('on');
  ladeModalTrades();
  ladeOffenePosition(strat, 'modal-openpos');
}
function closeModal() { document.getElementById('overlay').classList.remove('on'); }
function bgClose(e)   { if (e.target === document.getElementById('overlay')) closeModal(); }

async function ladeModalTrades() {
  const datum = document.getElementById('modal-datum').value;
  if (!datum) return;
  try {
    const r = await fetch('/api/trades/' + aktStrat + '?datum=' + datum);
    const d = await r.json();
    document.getElementById('s-anz').textContent = d.count;
    const pe = document.getElementById('s-pnl');
    pe.textContent = (d.gesamtPnL >= 0 ? '+' : '') + d.gesamtPnL.toFixed(2) + '€';
    pe.className   = 'v ' + pf(d.gesamtPnL);
    document.getElementById('s-wl').textContent = d.gewinn + ' / ' + d.verlust;
    const body = document.getElementById('modal-body');
    if (!d.trades.length) { body.innerHTML = '<div class="empty">Keine Trades</div>'; return; }
    let h = '<table><thead><tr><th>Zeit</th><th>Richtung</th><th>P&L</th><th>Equity</th><th>SL</th><th>TP</th></tr></thead><tbody>';
    for (const t of d.trades) {
      const z  = new Date(t.datum).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const cl = t.pnl > 0 ? 'pos' : 'neg';
      h += \`<tr><td>\${z}</td><td><span class="badge \${t.seite==='BUY'?'buy-b':'sell-b'}">\${t.seite}</span></td><td class="\${cl}">\${t.pnl>=0?'+':''}\${t.pnl.toFixed(2)}€</td><td>\${t.equity.toFixed(2)}€</td><td>\${t.sl}</td><td>\${t.tp}</td></tr>\`;
    }
    body.innerHTML = h + '</tbody></table>';
  } catch(e) { document.getElementById('modal-body').innerHTML = '<div class="empty">Fehler: ' + e.message + '</div>'; }
}

// ── Equity Chart (Fix: echte Timestamps, auto Y-Achse, Tooltips) ──
function updateChartZoom(val) {
  zoomPct = parseInt(val);
  document.getElementById('zoomLabel').textContent = val + '%';
  if (chartInst) renderChart();
}

function toggleChart() {
  chartExpanded = !chartExpanded;
  document.getElementById('chartWrap').className = 'chart-wrap' + (chartExpanded ? ' expanded' : '');
  document.getElementById('expandBtn').textContent = chartExpanded ? 'Einklappen' : 'Ausklappen';
  if (chartInst) chartInst.resize();
}

async function ladeChart() {
  try {
    const r = await fetch('/api/equity');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const cutoff = filterTage > 0 ? Date.now() - filterTage * 24 * 60 * 60 * 1000 : 0;
    allChartData = {};
    for (const [name, farbe] of Object.entries(farben)) {
      const punkte   = data[name] || [];
      const filtered = cutoff > 0 ? punkte.filter(p => new Date(p.datum).getTime() >= cutoff) : punkte;
      if (!filtered.length) continue;
      const pts = filtered.map(p => ({ x: new Date(p.datum).getTime(), y: parseFloat(p.equity) }));
      allChartData[name] = { pts, farbe };
    }
    renderChart();
  } catch(e) { console.error('Chart:', e.message); }
}

function renderChart() {
  const ctx = document.getElementById('equityChart').getContext('2d');
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const datasets = [];
  let allY = [];
  for (const [name, data] of Object.entries(allChartData)) {
    const n      = Math.max(2, Math.floor(data.pts.length * zoomPct / 100));
    const sliced = data.pts.slice(-n);
    sliced.forEach(p => allY.push(p.y));
    datasets.push({
      label:           namen[name] || name,
      data:            sliced,
      borderColor:     data.farbe,
      backgroundColor: data.farbe + '14',
      tension:         0.3,
      fill:            false,
      pointRadius:     sliced.length > 100 ? 0 : 2,
      parsing:         false
    });
  }
  if (!datasets.length) return;
  const pad  = 0.005;
  const yMin = Math.min(...allY) * (1 - pad);
  const yMax = Math.max(...allY) * (1 + pad);
  chartInst = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: {
        legend: { labels: { color: '#555', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: items => new Date(items[0].parsed.x).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
            label: item => (namen[item.dataset.label] || item.dataset.label) + ': ' + item.parsed.y.toFixed(2) + '€'
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          ticks: { color: '#444', maxTicksLimit: 10, font: { size: 10 }, callback: v => new Date(v).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) },
          grid:  { color: '#1a1a1a' }
        },
        y: {
          min: yMin, max: yMax,
          ticks: { color: '#555', callback: v => v.toFixed(0) + '€', font: { size: 10 } },
          grid:  { color: '#1a1a1a' }
        }
      }
    }
  });
}

async function reset()      { if (!confirm('Wirklich zurücksetzen?')) return; await fetch('/api/reset', { method: 'POST' }); laden(); }
async function einzahlung() {
  const b = document.getElementById('betrag').value, s = document.getElementById('strategie').value;
  if (!b) return alert('Betrag eingeben');
  await fetch('/api/einzahlung?betrag=' + b + '&strategie=' + s);
  document.getElementById('zahlung-status').textContent = '✅ Einzahlung ' + b + '€ für ' + s; laden();
}
async function auszahlung() {
  const b = document.getElementById('betrag').value, s = document.getElementById('strategie').value;
  if (!b) return alert('Betrag eingeben');
  await fetch('/api/auszahlung?betrag=' + b + '&strategie=' + s);
  document.getElementById('zahlung-status').textContent = '💸 Auszahlung ' + b + '€ für ' + s; laden();
}

laden(); ladeChart();
</script>
</body>
</html>`);
});

// ── Tages-Reset um 00:00 Berliner Zeit ───────────────
let letzterTagesReset = '';
setInterval(() => {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const p = {}; parts.forEach(x => { p[x.type] = x.value; });
  const berlinDate = `${p.year}-${p.month}-${p.day}`;
  if (p.hour === '00' && p.minute === '00' && berlinDate !== letzterTagesReset) {
    letzterTagesReset = berlinDate;
    ALLE_STRATEGIEN.forEach(n => { tagesStartEquity[n] = null; });
    console.log('🔄 Tages-Equity zurückgesetzt (00:00 Berliner Zeit)');
  }
}, 60000);

// ── Tägliche Telegram Zusammenfassung um 22:00 UTC ────
async function sendTageszusammenfassung() {
  try {
    const heute = datumBerlin(new Date().toISOString());
    let msg = `📊 <b>Tages-Zusammenfassung ${heute}</b>\n`;
    for (const name of ALLE_STRATEGIEN) {
      const trades    = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) === heute);
      const gesamtPnL = (letzteEquity[name] - STRATEGIEN[name].startEquity).toFixed(2);
      if (!trades.length) continue;
      const pnl     = trades.reduce((s, t) => s + t.pnl, 0);
      const gewinn  = trades.filter(t => t.pnl > 0).length;
      const winRate = ((gewinn / trades.length) * 100).toFixed(0);
      const bester  = Math.max(...trades.map(t => t.pnl));
      const worst   = Math.min(...trades.map(t => t.pnl));
      msg += `\n<b>${name}</b>: ${trades.length}T | Heute: ${pnl>=0?'+':''}${pnl.toFixed(2)}€ | Gesamt: ${gesamtPnL>=0?'+':''}${gesamtPnL}€ | Win: ${winRate}% | Best: +${bester.toFixed(2)}€ | Worst: ${worst.toFixed(2)}€ | Eq: ${letzteEquity[name].toFixed(2)}€`;
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
    const datum    = datumBerlin(new Date().toISOString());
    const berichte = '/data/berichte';
    if (!fs.existsSync(berichte)) fs.mkdirSync(berichte, { recursive: true });

    const einstellungen = ALLE_STRATEGIEN.map(n => {
      const s = STRATEGIEN[n];
      return `${n}: riskPct=${s.riskPct}%, leverage=${s.leverage}, maxDrawdown=${s.maxDrawdownPct}%, tagsStop=${s.tagsStopPct}%`;
    }).join('\n');

    let tagesPnL = 0, tagesTotalTrades = 0, tagesGewinn = 0;
    const equityLines = ALLE_STRATEGIEN.map(n => `  - ${n}: ${letzteEquity[n].toFixed(2)}€`).join('\n');
    for (const name of ALLE_STRATEGIEN) {
      const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) === datum);
      tagesPnL        += trades.reduce((s, t) => s + t.pnl, 0);
      tagesGewinn     += trades.filter(t => t.pnl > 0).length;
      tagesTotalTrades += trades.length;
    }
    const winRate      = tagesTotalTrades > 0 ? ((tagesGewinn / tagesTotalTrades) * 100).toFixed(1) : '0';
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
    fs.writeFileSync(`${berichte}/${datum}.md`, mdContent);

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_TO) {
      const transporter = nodemailer.createTransporter({
        host:   process.env.SMTP_HOST || 'smtp.gmail.com',
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth:   { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      const readme = `# Trading Bot Backup ${datum}\n\nEinstellungen:\n${einstellungen}\n\nAPI-Keys: NICHT GESPEICHERT\n`;
      await transporter.sendMail({
        from:    process.env.EMAIL_USER,
        to:      process.env.EMAIL_TO,
        subject: `Trading Bot Backup ${datum}`,
        text:    `Tägliches Backup vom ${datum}.\nP&L: ${tagesPnL>=0?'+':''}${tagesPnL.toFixed(2)}€ | Trades: ${tagesTotalTrades} | Win Rate: ${winRate}%`,
        attachments: [
          { filename: `bericht_${datum}.md`, content: mdContent },
          { filename: 'server_info.md',      content: readme    }
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
