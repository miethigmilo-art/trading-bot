process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express    = require('express');
const axios      = require('axios');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const app        = express();
app.use(express.json());

// ── Konten ─────────────────────────────────────────────────────────────────
const KONTO_MITTEL      = { apiKey: process.env.API_KEY,             email: process.env.EMAIL,             password: process.env.PASSWORD,             baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_AGGRESSIV   = { apiKey: process.env.API_KEY_AGGRESSIV,   email: process.env.EMAIL_AGGRESSIV,   password: process.env.PASSWORD_AGGRESSIV,   baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_GOLDGLOBE   = { apiKey: process.env.API_KEY_GOLDGLOBE,   email: process.env.EMAIL_GOLDGLOBE,   password: process.env.PASSWORD_GOLDGLOBE,   baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_TEST        = { apiKey: process.env.API_KEY_TEST,        email: process.env.EMAIL_TEST,        password: process.env.PASSWORD_TEST,        baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_KONSERVATIV = { apiKey: process.env.API_KEY_KONSERVATIV, email: process.env.EMAIL_KONSERVATIV, password: process.env.PASSWORD_KONSERVATIV, baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_OPTIMIERT   = { apiKey: process.env.API_KEY_OPTIMIERT,   email: process.env.EMAIL_OPTIMIERT,   password: process.env.PASSWORD_OPTIMIERT,   baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_TEST2       = { apiKey: process.env.API_KEY_TEST2,       email: process.env.EMAIL_TEST2,       password: process.env.PASSWORD_TEST2,       baseUrl: process.env.BASE_URL, cst: null, token: null };
const KONTO_STEADY      = { apiKey: process.env.API_KEY_STEADY,      email: process.env.EMAIL_STEADY,      password: process.env.PASSWORD_STEADY,      baseUrl: process.env.BASE_URL, cst: null, token: null };

// ── Strategien ─────────────────────────────────────────────────────────────
const STRATEGIEN = {
  mittel:      { konto: KONTO_MITTEL,      epic: 'GOLD', riskPct: 1.5, leverage: 5, maxDrawdownPct: 20, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0 },
  aggressiv:   { konto: KONTO_AGGRESSIV,   epic: 'GOLD', riskPct: 2.0, leverage: 5, maxDrawdownPct: 30, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0 },
  smart:       { konto: KONTO_GOLDGLOBE,   epic: 'GOLD', riskPct: 1.2, leverage: 5, maxDrawdownPct: 20, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0, minRRR: 2.5, regimeFilter: true },
  test:        { konto: KONTO_TEST,        epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0 },
  konservativ: { konto: KONTO_KONSERVATIV, epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0 },
  optimiert:   { konto: KONTO_OPTIMIERT,   epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0, minRRR: 2.0 },
  test2:       { konto: KONTO_TEST2,       epic: 'GOLD', riskPct: 1.0, leverage: 5, maxDrawdownPct: 50, startEquity: 1000, tagsStop: true, tagsStopPct: 5.0 },
  steady:      { konto: KONTO_STEADY,      epic: 'GOLD', riskPct: 0.2, leverage: 2, maxDrawdownPct: 3,  startEquity: 1000, tagsStop: true, tagsStopPct: 0.05,
                 tagesVerlustPct: 0.1, tagsStopNachricht: '✅ Steady Tagesziel erreicht! +0.05% — Bot pausiert bis morgen' }
};
const ALLE_STRATEGIEN = Object.keys(STRATEGIEN);

// ── Performance State ──────────────────────────────────────────────────────
function neuPerf() {
  return { trades: 0, gewinn: 0, verlust: 0, bestesTrade: 0, schlechtestesTrade: 0,
           buyTrades: 0, sellTrades: 0, buyGewinn: 0, sellGewinn: 0, buyPnL: 0, sellPnL: 0 };
}
const performance = {};
ALLE_STRATEGIEN.forEach(n => { performance[n] = neuPerf(); });

const letzteEquity = {};
ALLE_STRATEGIEN.forEach(n => { letzteEquity[n] = STRATEGIEN[n].startEquity; });
let letzteAktualisierung = new Date().toISOString();

const tagesStartEquity = {};
ALLE_STRATEGIEN.forEach(n => { tagesStartEquity[n] = null; });

const aktiveTrades = {};
const letzterTrade = {};

// ── Datei-Persistenz ───────────────────────────────────────────────────────
const EQUITY_FILE = '/data/equity.json';
const TRADES_FILE = '/data/trades.json';

function ladeEquityDaten() {
  try { if (fs.existsSync(EQUITY_FILE)) return JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8')); }
  catch (e) { console.error('❌ Equity laden:', e.message); }
  const d = {}; ALLE_STRATEGIEN.forEach(n => { d[n] = []; }); return d;
}
function speichereEquityDaten(d) {
  try { fs.writeFileSync(EQUITY_FILE, JSON.stringify(d, null, 2)); }
  catch (e) { console.error('❌ Equity speichern:', e.message); }
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
  catch (e) { console.error('❌ Trades laden:', e.message); }
  const d = {}; ALLE_STRATEGIEN.forEach(n => { d[n] = []; }); return d;
}
function speichereTradeDaten(d) {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(d, null, 2)); }
  catch (e) { console.error('❌ Trades speichern:', e.message); }
}
let tradeVerlauf = ladeTradeDaten();
ALLE_STRATEGIEN.forEach(n => { if (!tradeVerlauf[n]) tradeVerlauf[n] = []; });

// Performance + letzteEquity beim Start aus gespeicherten Daten wiederherstellen
(function initAusDaten() {
  for (const [name, punkte] of Object.entries(equityVerlauf)) {
    if (punkte.length > 0) letzteEquity[name] = punkte[punkte.length - 1].equity;
  }
  for (const [name, trades] of Object.entries(tradeVerlauf)) {
    if (!performance[name] || !trades.length) continue;
    const p = performance[name];
    for (const t of trades) {
      p.trades++;
      if (t.pnl > 0) p.gewinn++; else p.verlust++;
      if (t.pnl > p.bestesTrade) p.bestesTrade = t.pnl;
      if (t.pnl < p.schlechtestesTrade) p.schlechtestesTrade = t.pnl;
      if (t.seite === 'BUY') { p.buyTrades++; p.buyPnL += t.pnl; if (t.pnl > 0) p.buyGewinn++; }
      else if (t.seite === 'SELL') { p.sellTrades++; p.sellPnL += t.pnl; if (t.pnl > 0) p.sellGewinn++; }
    }
    if (trades.length > 0) letzteAktualisierung = trades[trades.length - 1].datum;
  }
  console.log('📊 Wiederhergestellt:', ALLE_STRATEGIEN.map(n => `${n}:${performance[n].trades}T`).join(' '));
})();

function tradeHinzufuegen(name, trade) {
  if (!tradeVerlauf[name]) tradeVerlauf[name] = [];
  tradeVerlauf[name].push(trade);
  speichereTradeDaten(tradeVerlauf);
  console.log(`📝 Trade [${name}]: PnL ${trade.pnl >= 0 ? '+' : ''}${trade.pnl}€`);
}

// ── Login ──────────────────────────────────────────────────────────────────
async function login(konto) {
  const res = await axios.post(`${konto.baseUrl}/session`,
    { identifier: konto.email, password: konto.password },
    { headers: { 'X-CAP-API-KEY': konto.apiKey } });
  konto.cst   = res.headers['cst'];
  konto.token = res.headers['x-security-token'];
  console.log(`✅ Login: ${konto.email}`);
}

// ── Equity holen ───────────────────────────────────────────────────────────
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

// ── Positionen ─────────────────────────────────────────────────────────────
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
    const positionen = (res.data.positions || []).filter(p => p.market?.epic === epic);
    for (const pos of positionen) {
      await axios.delete(`${konto.baseUrl}/positions/${pos.position.dealId}`, {
        headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
      });
      console.log(`🔒 Position geschlossen: ${pos.position.dealId}`);
    }
  } catch (err) { console.error('❌ closeOpenPosition:', err.message); }
}

async function schliesseAllePositionen() {
  console.log('🇺🇸 Alle Positionen werden geschlossen...');
  for (const [name, strat] of Object.entries(STRATEGIEN)) {
    try {
      if (!strat.konto.cst) await login(strat.konto);
      await closeOpenPosition(strat.konto, strat.epic);
    } catch (e) { console.error(`❌ Marktschluss [${name}]:`, e.message); }
  }
  await sendTelegram('🇺🇸 <b>Wochenende</b>\nAlle offenen Positionen automatisch geschlossen (Fr 23:00 UTC).');
}

// ── Positionsgröße (ohne doppelten Leverage — Fix #7) ──────────────────────
function calcSizeFixed(equity, sl, tp, strategie) {
  const riskCapital = equity * (strategie.riskPct / 100);
  const slDistance  = Math.abs(parseFloat(tp) - parseFloat(sl));
  if (slDistance === 0) return 1;
  return Math.max(1, parseFloat((riskCapital / slDistance).toFixed(1)));
}

// ── Drawdown prüfen ────────────────────────────────────────────────────────
function checkDrawdown(equity, strategie, name) {
  if (performance[name].trades === 0) return false;
  return ((strategie.startEquity - equity) / strategie.startEquity) * 100 >= strategie.maxDrawdownPct;
}

// ── Tages-Stop ─────────────────────────────────────────────────────────────
function pruefeTagsStop(name, equity) {
  if (tagesStartEquity[name] === null) { tagesStartEquity[name] = equity; return false; }
  const pct  = ((equity - tagesStartEquity[name]) / tagesStartEquity[name]) * 100;
  const ziel = STRATEGIEN[name].tagsStopPct || 5.0;
  return pct >= ziel;
}

function pruefeTagesVerlust(name, equity) {
  if (tagesStartEquity[name] === null) return false;
  const ziel = STRATEGIEN[name].tagesVerlustPct;
  if (!ziel) return false;
  return ((tagesStartEquity[name] - equity) / tagesStartEquity[name]) * 100 >= ziel;
}

// ── Performance updaten ────────────────────────────────────────────────────
function updatePerformance(name, pnl, seite) {
  const p = performance[name];
  p.trades++;
  if (pnl > 0) p.gewinn++; else p.verlust++;
  if (pnl > p.bestesTrade) p.bestesTrade = pnl;
  if (pnl < p.schlechtestesTrade) p.schlechtestesTrade = pnl;
  if (seite === 'BUY')  { p.buyTrades++;  p.buyPnL  += pnl; if (pnl > 0) p.buyGewinn++;  }
  if (seite === 'SELL') { p.sellTrades++; p.sellPnL += pnl; if (pnl > 0) p.sellGewinn++; }
  letzteAktualisierung = new Date().toISOString();
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(nachricht) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text: nachricht, parse_mode: 'HTML' });
  } catch (err) { console.error('❌ Telegram:', err.message); }
}

// ── Timezone Helper ────────────────────────────────────────────────────────
function datumBerlin(isoString) {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(isoString));
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

// ── Smart Regime Detection ─────────────────────────────────────────────────
const SMART_STATE = { modus: 'AKTIV', pauseBis: null, geaendertAm: null, rollendeWinRate: null, konsekVerluste: 0 };
const REGIME_FENSTER = 15;
const WR_PAUSE       = 0.35;
const WR_VORSICHTIG  = 0.42;
const KONSE_MAX      = 4;
const PAUSE_MS       = 2 * 60 * 60 * 1000;

function berechneRegime(name) {
  const trades = tradeVerlauf[name] || [];
  let konsek = 0;
  for (let i = trades.length - 1; i >= 0; i--) { if (trades[i].pnl < 0) konsek++; else break; }
  SMART_STATE.konsekVerluste = konsek;
  const fenster = trades.slice(-REGIME_FENSTER);
  if (fenster.length < 5) { SMART_STATE.rollendeWinRate = null; return 'AKTIV'; }
  const wr = fenster.filter(t => t.pnl > 0).length / fenster.length;
  SMART_STATE.rollendeWinRate = parseFloat((wr * 100).toFixed(1));
  if (konsek >= KONSE_MAX || wr < WR_PAUSE)   return 'PAUSE';
  if (wr < WR_VORSICHTIG)                     return 'VORSICHTIG';
  return 'AKTIV';
}

async function pruefeRegime(name) {
  if (SMART_STATE.modus === 'PAUSE' && SMART_STATE.pauseBis && Date.now() < SMART_STATE.pauseBis) {
    return { geblockt: true, grund: `PAUSE – noch ${Math.round((SMART_STATE.pauseBis - Date.now()) / 60000)} Min.` };
  }
  const neu = berechneRegime(name);
  if (neu !== SMART_STATE.modus) {
    const alt = SMART_STATE.modus;
    SMART_STATE.modus      = neu;
    SMART_STATE.geaendertAm = new Date().toISOString();
    SMART_STATE.pauseBis    = neu === 'PAUSE' ? Date.now() + PAUSE_MS : null;
    const emoji = neu === 'AKTIV' ? '🟢' : neu === 'VORSICHTIG' ? '🟡' : '🔴';
    await sendTelegram(
      `${emoji} <b>[Smart] Regime: ${alt} → ${neu}</b>\n` +
      `Rolling WR: <b>${SMART_STATE.rollendeWinRate ?? '?'}%</b> | Konsek. Verluste: <b>${SMART_STATE.konsekVerluste}</b>` +
      (neu === 'PAUSE' ? `\n⏸ Pause bis: <b>${new Date(SMART_STATE.pauseBis).toLocaleTimeString('de-DE')}</b>` : '')
    );
  }
  if (SMART_STATE.modus === 'PAUSE') return { geblockt: true, grund: 'PAUSE aktiv (2h)' };
  return { geblockt: false, modus: SMART_STATE.modus };
}

// ── Universeller Webhook Handler (alle Fixes angewendet) ───────────────────
async function handleWebhookUniversal(req, res, name) {
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });

  // Fix #18: Webhook Secret
  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Ungültiger Webhook Secret' });
  }

  // Fix #10: Duplikat-Schutz + 30s Cooldown
  if (aktiveTrades[name]) return res.status(429).json({ error: 'Trade läuft bereits' });
  const jetzt = Date.now();
  if (letzterTrade[name] && jetzt - letzterTrade[name] < 30000) {
    return res.status(429).json({ error: 'Cooldown aktiv (30s)' });
  }
  aktiveTrades[name] = true;

  try {
    console.log(`📨 Signal [${name}]:`, req.body);
    const { side, sl, tp } = req.body;
    if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder: side, sl, tp' });

    const konto = strategie.konto;
    if (!konto.cst) await login(konto);
    const equity = await getEquity(konto);

    // Fix #11 + #2: Tages-Stop (mit return — Telegram + hartes return)
    if (strategie.tagsStop) {
      if (pruefeTagsStop(name, equity)) {
        const msg = strategie.tagsStopNachricht ||
          `🎯 Tagesziel +${strategie.tagsStopPct}% erreicht — <b>${name}</b> pausiert bis morgen`;
        await sendTelegram(msg);
        return res.json({ status: 'pausiert', grund: 'Tagesziel erreicht' });
      }
      if (pruefeTagesVerlust(name, equity)) {
        await sendTelegram(`🛑 Tages-Verlust-Stop (-${strategie.tagesVerlustPct}%) — <b>${name}</b> pausiert bis morgen`);
        return res.json({ status: 'pausiert', grund: 'Tages-Verlust-Stop' });
      }
    }

    // Drawdown Check
    if (checkDrawdown(equity, strategie, name)) {
      await sendTelegram(`🛑 <b>Max. Drawdown erreicht!</b>\nStrategie: <b>${name}</b>`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown erreicht' });
    }

    // Regime-Filter (nur für Smart Bot)
    let regimeModus = 'AKTIV';
    if (strategie.regimeFilter) {
      const regime = await pruefeRegime(name);
      if (regime.geblockt) {
        console.log(`⏸ [${name}] Signal übersprungen: ${regime.grund}`);
        return res.json({ status: 'übersprungen', grund: regime.grund, modus: SMART_STATE.modus });
      }
      regimeModus = regime.modus;
      if (regimeModus === 'VORSICHTIG' && side === 'SELL') {
        console.log(`🟡 [${name}] VORSICHTIG: SELL ignoriert`);
        return res.json({ status: 'übersprungen', grund: 'VORSICHTIG – nur LONG erlaubt', modus: 'VORSICHTIG' });
      }
    }

    // Fix #9: RRR erzwingen (im VORSICHTIG-Modus strenger)
    const effektivesMinRRR = (strategie.regimeFilter && regimeModus === 'VORSICHTIG') ? 3.5 : strategie.minRRR;
    let slFloat = parseFloat(sl), tpFloat = parseFloat(tp);
    if (effektivesMinRRR) {
      try {
        const mkt = await axios.get(`${konto.baseUrl}/markets/${strategie.epic}`, {
          headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
        });
        const entry  = side === 'BUY' ? parseFloat(mkt.data.snapshot.offer) : parseFloat(mkt.data.snapshot.bid);
        const riskD  = Math.abs(entry - slFloat);
        const rwrdD  = Math.abs(tpFloat - entry);
        if (riskD > 0 && rwrdD / riskD < effektivesMinRRR) {
          tpFloat = parseFloat((side === 'BUY' ? entry + riskD * effektivesMinRRR : entry - riskD * effektivesMinRRR).toFixed(2));
          console.log(`📐 [${name}] RRR angepasst (${effektivesMinRRR}): TP → ${tpFloat}`);
        }
      } catch (rrrErr) { console.error('⚠️ RRR Check:', rrrErr.message); }
    }

    // Fix #1: gesamtPnL via Equity-Differenz (kein aufaddieren)
    const pnl = equity - letzteEquity[name];
    if (pnl !== 0) {
      updatePerformance(name, pnl, side);
      tradeHinzufuegen(name, {
        datum: new Date().toISOString(), pnl: parseFloat(pnl.toFixed(2)),
        equity: parseFloat(equity.toFixed(2)), seite: side, sl: slFloat, tp: tpFloat
      });
    }
    letzteEquity[name] = equity;
    equityPunktHinzufuegen(name, equity);

    // Fix #8: Offene Position schließen vor neuer Order
    await closeOpenPosition(konto, strategie.epic);

    // Fix #7: calcSizeFixed (kein doppelter Leverage)
    const size  = calcSizeFixed(equity, slFloat, tpFloat, strategie);
    const order = { epic: strategie.epic, direction: side, size, guaranteedStop: false, stopLevel: slFloat, profitLevel: tpFloat };
    console.log(`📤 [${name}] Order:`, order);
    await axios.post(`${konto.baseUrl}/positions`, order, {
      headers: { 'X-CAP-API-KEY': konto.apiKey, 'CST': konto.cst, 'X-SECURITY-TOKEN': konto.token }
    });

    // Fix #1: gesamtPnL direkt = aktuelleEquity - startEquity
    const gesamtPnL = (equity - strategie.startEquity).toFixed(2);
    const regimeLabel = strategie.regimeFilter ? ` [${regimeModus}${regimeModus === 'VORSICHTIG' ? ' 🟡' : ' 🟢'}]` : '';
    await sendTelegram(
      `${side === 'BUY' ? '🟢' : '🔴'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'} eröffnet</b>\n` +
      `Strategie: <b>${name}${regimeLabel}</b>\nGröße: <b>${size} Units</b>\nSL: <b>${slFloat}$</b>  TP: <b>${tpFloat}$</b>\n` +
      `Gesamt P&L: <b>${parseFloat(gesamtPnL) >= 0 ? '+' : ''}${gesamtPnL}€</b>`
    );
    res.json({ status: 'ok', strategie: name, size, sl: slFloat, tp: tpFloat });

  } catch (err) {
    if (err.response?.status === 401) {
      strategie.konto.cst = null;
      await login(strategie.konto);
      return res.status(500).json({ error: 'Session erneuert, bitte erneut senden' });
    }
    console.error(`❌ [${name}]:`, err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  } finally {
    aktiveTrades[name] = false;
    letzterTrade[name] = Date.now();
  }
}

// ── Webhook Routen ─────────────────────────────────────────────────────────
ALLE_STRATEGIEN.forEach(name => {
  app.post(`/webhook/${name}`, (req, res) => handleWebhookUniversal(req, res, name));
});
// Alte GoldGlobe-URL als Alias für Smart Bot (TradingView Alerts müssen nicht geändert werden)
app.post('/webhook/goldglobe', (req, res) => handleWebhookUniversal(req, res, 'smart'));

// ── Smart Status API ────────────────────────────────────────────────────────
app.get('/api/smart-status', (req, res) => {
  res.json({
    modus:           SMART_STATE.modus,
    rollendeWinRate: SMART_STATE.rollendeWinRate,
    konsekVerluste:  SMART_STATE.konsekVerluste,
    pauseBis:        SMART_STATE.pauseBis,
    pauseMinLeft:    SMART_STATE.pauseBis && Date.now() < SMART_STATE.pauseBis ? Math.round((SMART_STATE.pauseBis - Date.now()) / 60000) : 0,
    geaendertAm:     SMART_STATE.geaendertAm,
    schwellen:       { pause: WR_PAUSE * 100, vorsichtig: WR_VORSICHTIG * 100, konsekMax: KONSE_MAX }
  });
});

// ── SL Update ──────────────────────────────────────────────────────────────
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

// ── Performance API ────────────────────────────────────────────────────────
app.get('/api/performance', async (req, res) => {
  async function tryEquity(konto) {
    try { if (!konto.cst) await login(konto); return await getEquity(konto); }
    catch (e) { console.error(`❌ Equity (${konto.email}):`, e.message); return null; }
  }
  const equities = await Promise.all(ALLE_STRATEGIEN.map(n => tryEquity(STRATEGIEN[n].konto)));
  const result   = { letzteAktualisierung };
  ALLE_STRATEGIEN.forEach((n, i) => {
    const p   = performance[n];
    const eq  = equities[i];
    const st  = STRATEGIEN[n];
    // Fix #1: gesamtPnL = aktuelleEquity - startEquity
    const gesamtPnL = eq != null ? parseFloat((eq - st.startEquity).toFixed(2)) : null;
    const dd = eq != null && p.trades > 0 ? (((st.startEquity - eq) / st.startEquity) * 100).toFixed(2) : '0.00';
    result[n] = {
      ...p,
      aktuellesEquity: eq,
      gesamtPnL:   gesamtPnL,
      drawdown:    dd,
      winRate:     p.trades   > 0 ? ((p.gewinn / p.trades) * 100).toFixed(1)         : '0',
      buyWinRate:  p.buyTrades  > 0 ? ((p.buyGewinn / p.buyTrades) * 100).toFixed(1)  : '0',
      sellWinRate: p.sellTrades > 0 ? ((p.sellGewinn / p.sellTrades) * 100).toFixed(1) : '0',
      buyPnL:      parseFloat(p.buyPnL.toFixed(2)),
      sellPnL:     parseFloat(p.sellPnL.toFixed(2))
    };
  });
  res.json(result);
});

// ── Equity API ─────────────────────────────────────────────────────────────
app.get('/api/equity', (req, res) => { res.json(equityVerlauf); });

// ── Trades API (mit Timezone Fix + von/bis) ────────────────────────────────
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

// ── Analyse API (Stunden + Wochentag) ─────────────────────────────────────
app.get('/api/analyse/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const trades = tradeVerlauf[name] || [];
  const stunden    = Array.from({ length: 24 }, (_, i) => ({ stunde: i, trades: 0, gesamtPnL: 0, gewinn: 0 }));
  const wochentage = ['So','Mo','Di','Mi','Do','Fr','Sa'].map((n, i) => ({ tag: n, tagNr: i, trades: 0, gesamtPnL: 0, gewinn: 0 }));
  for (const t of trades) {
    const d = new Date(t.datum);
    const h = d.getUTCHours(), wd = d.getUTCDay();
    stunden[h].trades++; stunden[h].gesamtPnL += t.pnl; if (t.pnl > 0) stunden[h].gewinn++;
    wochentage[wd].trades++; wochentage[wd].gesamtPnL += t.pnl; if (t.pnl > 0) wochentage[wd].gewinn++;
  }
  stunden.forEach(s => { s.gesamtPnL = parseFloat(s.gesamtPnL.toFixed(2)); s.winRate = s.trades > 0 ? ((s.gewinn/s.trades)*100).toFixed(1) : '0'; s.avgPnL = s.trades > 0 ? parseFloat((s.gesamtPnL/s.trades).toFixed(2)) : 0; });
  wochentage.forEach(w => { w.gesamtPnL = parseFloat(w.gesamtPnL.toFixed(2)); w.winRate = w.trades > 0 ? ((w.gewinn/w.trades)*100).toFixed(1) : '0'; w.avgPnL = w.trades > 0 ? parseFloat((w.gesamtPnL/w.trades).toFixed(2)) : 0; });
  res.json({ strategie: name, gesamtTrades: trades.length, stunden, wochentage });
});

// ── Offene Position API ────────────────────────────────────────────────────
app.get('/api/offene-position/:strategie', async (req, res) => {
  const name = req.params.strategie;
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });
  try {
    if (!strategie.konto.cst) await login(strategie.konto);
    const position = await getOpenPosition(strategie.konto, strategie.epic);
    if (!position) return res.json({ position: null });
    const p = position.position, m = position.market;
    res.json({ position: { dealId: p.dealId, richtung: p.direction, groesse: p.size, pnl: p.upl, level: p.level, sl: p.stopLevel, tp: p.limitLevel, epic: m.epic, name: m.instrumentName } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schliesse-position/:strategie', async (req, res) => {
  const name = req.params.strategie;
  const strategie = STRATEGIEN[name];
  if (!strategie) return res.status(400).json({ error: 'Unbekannte Strategie' });
  try {
    if (!strategie.konto.cst) await login(strategie.konto);
    const position = await getOpenPosition(strategie.konto, strategie.epic);
    if (!position) return res.json({ status: 'keine Position offen' });
    await axios.delete(`${strategie.konto.baseUrl}/positions/${position.position.dealId}`, {
      headers: { 'X-CAP-API-KEY': strategie.konto.apiKey, 'CST': strategie.konto.cst, 'X-SECURITY-TOKEN': strategie.konto.token }
    });
    await sendTelegram(`🔒 <b>Position manuell geschlossen</b>\nStrategie: <b>${name}</b>`);
    res.json({ status: 'ok', dealId: position.position.dealId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Weekly HTML Report ─────────────────────────────────────────────────────
app.get('/api/report/weekly/:strategie', (req, res) => {
  const name = req.params.strategie;
  if (!STRATEGIEN[name]) return res.status(400).json({ error: 'Unbekannte Strategie' });
  const bis = new Date(), von = new Date(bis.getTime() - 7 * 86400000);
  const vonStr = von.toISOString().slice(0,10), bisStr = bis.toISOString().slice(0,10);
  const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) >= vonStr && datumBerlin(t.datum) <= bisStr);
  const gesamtPnL = trades.reduce((s,t) => s+t.pnl, 0);
  const gewinn    = trades.filter(t => t.pnl > 0).length;
  const winRate   = trades.length > 0 ? ((gewinn/trades.length)*100).toFixed(1) : '0';
  const rows = trades.map(t => {
    const d = new Date(t.datum);
    const cl = t.pnl > 0 ? 'color:#22c55e' : 'color:#ef4444';
    return `<tr><td>${d.toLocaleDateString('de-DE')}</td><td>${d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</td><td>${t.seite}</td><td style="${cl}">${t.pnl>=0?'+':''}${t.pnl.toFixed(2)}€</td><td>${t.equity.toFixed(2)}€</td><td>${t.sl}</td><td>${t.tp}</td></tr>`;
  }).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Wochenbericht ${name}</title>
<style>body{font-family:sans-serif;background:#0f0f0f;color:#fff;padding:32px}h1{margin-bottom:4px}.sub{color:#666;margin-bottom:24px}
.stats{display:flex;gap:16px;margin-bottom:24px}.s{background:#1a1a1a;border-radius:10px;padding:16px 20px;min-width:120px}
.s .v{font-size:22px;font-weight:700}.s .l{font-size:11px;color:#555;margin-top:4px}
.pos{color:#22c55e}.neg{color:#ef4444}table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#555;padding:8px;text-align:left;border-bottom:1px solid #222}td{padding:9px 8px;border-bottom:1px solid #1a1a1a}</style></head><body>
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

// ── Reset / Einzahlung / Auszahlung ───────────────────────────────────────
app.post('/api/reset', (req, res) => {
  ALLE_STRATEGIEN.forEach(n => { performance[n] = neuPerf(); letzteEquity[n] = STRATEGIEN[n].startEquity; });
  letzteAktualisierung = new Date().toISOString();
  res.json({ status: 'ok' });
});

app.get('/api/einzahlung', (req, res) => {
  const betrag = parseFloat(req.query.betrag), strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  const targets = strategie === 'alle' ? ALLE_STRATEGIEN : [strategie];
  for (const n of targets) {
    if (STRATEGIEN[n]) { STRATEGIEN[n].startEquity += betrag; letzteEquity[n] += betrag; }
  }
  sendTelegram(`💰 <b>Einzahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

app.get('/api/auszahlung', (req, res) => {
  const betrag = parseFloat(req.query.betrag), strategie = req.query.strategie;
  if (!betrag || betrag <= 0) return res.status(400).json({ error: 'Ungültiger Betrag' });
  const targets = strategie === 'alle' ? ALLE_STRATEGIEN : [strategie];
  for (const n of targets) {
    if (STRATEGIEN[n]) { STRATEGIEN[n].startEquity -= betrag; letzteEquity[n] -= betrag; }
  }
  sendTelegram(`💸 <b>Auszahlung</b>\nBetrag: <b>${betrag}€</b>\nStrategie: <b>${strategie}</b>`);
  res.json({ status: 'ok', betrag, strategie });
});

// ── Test ───────────────────────────────────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    if (!KONTO_MITTEL.cst) await login(KONTO_MITTEL);
    const em = await getEquity(KONTO_MITTEL);
    res.json({ status: '✅ Verbunden', equityMittel: em + '€' });
  } catch (err) { res.json({ status: '❌ Fehler', fehler: err.message }); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────
const KARTEN_CONFIG = [
  { id: 'mittel',      label: 'Mittel',       color: '#60a5fa', bg: '#1e3a5f' },
  { id: 'aggressiv',   label: 'Aggressiv',    color: '#fb923c', bg: '#3b1f00' },
  { id: 'smart',       label: 'Smart ✦',      color: '#2dd4bf', bg: '#0f2a28' },
  { id: 'test',        label: 'Test 1M',       color: '#4ade80', bg: '#1a3a1a' },
  { id: 'konservativ', label: 'Konservativ',   color: '#34d399', bg: '#1f3b2e' },
  { id: 'optimiert',   label: 'Optimiert ✨', color: '#f472b6', bg: '#2a1f3b' },
  { id: 'test2',       label: 'Test2 Adaptiv', color: '#38bdf8', bg: '#0c2a3b' },
  { id: 'steady',      label: 'Steady',       color: '#86efac', bg: '#0f2a1a' },
];

const kartenHTML = KARTEN_CONFIG.map(k => `
  <div class="card" style="border-color:${k.bg}" onclick="openModal('${k.id}')">
    <h2><span class="tag" style="background:${k.bg};color:${k.color}">${k.label}</span><span class="hint">Trades →</span></h2>
    <div class="equity" id="${k.id}-equity">—</div>
    <div class="stat"><span class="stat-label">Trades</span><span class="stat-value" id="${k.id}-trades">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="${k.id}-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt P&L</span><span class="stat-value" id="${k.id}-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="${k.id}-dd">-</span></div>
    <div class="dir-bars" id="${k.id}-dirs"></div>
    <div id="${k.id}-openpos"></div>
  </div>`).join('\n');

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
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-bottom:20px}
.card{background:#1a1a1a;border-radius:12px;padding:22px;border:1px solid #222;cursor:pointer;transition:border-color .15s}
.card:hover{border-color:#444}
.card h2{font-size:12px;color:#666;margin-bottom:14px;text-transform:uppercase;letter-spacing:1px;display:flex;justify-content:space-between;align-items:center}
.card h2 span.hint{font-size:10px;color:#333;text-transform:none;letter-spacing:0}
.equity{font-size:28px;font-weight:700;margin-bottom:14px;color:#22c55e}
.stat{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1e1e}
.stat:last-of-type{border-bottom:none}
.stat-label{color:#666;font-size:13px}.stat-value{font-size:13px;font-weight:600}
.pos{color:#22c55e}.neg{color:#ef4444}
.tag{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700}
.btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;margin-right:8px}
.dir-bars{margin-top:10px;padding-top:10px;border-top:1px solid #1e1e1e}
.dir-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px}
.dir-label{width:38px;color:#555}
.dir-bar-wrap{flex:1;background:#111;border-radius:4px;height:5px;overflow:hidden}
.dir-bar{height:100%;border-radius:4px}
.dir-bar-buy{background:#22c55e}.dir-bar-sell{background:#ef4444}
.dir-pct{width:40px;text-align:right;color:#444}
.chart-wrap{overflow:hidden;transition:max-height .4s;max-height:200px}
.chart-wrap.expanded{max-height:520px}
.chart-controls{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.chart-controls input[type=range]{flex:1;min-width:100px;accent-color:#4ade80}
.chart-controls button,.chart-controls span{background:#222;border:1px solid #333;color:#aaa;padding:5px 11px;border-radius:7px;font-size:12px;cursor:pointer}
.chart-controls span{cursor:default;color:#555}
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-bar button{background:#1a1a1a;border:1px solid #282828;color:#888;padding:6px 14px;border-radius:20px;font-size:12px;cursor:pointer;transition:all .15s}
.filter-bar button.active,.filter-bar button:hover{background:#222;border-color:#444;color:#fff}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:200;align-items:center;justify-content:center;padding:16px}
.overlay.on{display:flex}
.modal{background:#161616;border:1px solid #2a2a2a;border-radius:16px;width:100%;max-width:760px;max-height:90vh;overflow-y:auto;padding:26px}
.modal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.modal-top h2{font-size:17px;font-weight:600}
.modal-close{background:#222;border:none;color:#777;font-size:18px;padding:3px 10px;border-radius:7px;cursor:pointer}
.date-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.date-bar input{background:#222;border:1px solid #333;color:#fff;padding:7px 11px;border-radius:8px;font-size:13px}
.date-bar button{background:#262626;border:1px solid #333;color:#aaa;padding:7px 13px;border-radius:8px;font-size:12px;cursor:pointer}
.date-bar button:hover{color:#fff;border-color:#555}
.modal-tabs{display:flex;gap:6px;margin-bottom:14px}
.modal-tab{background:#1a1a1a;border:1px solid #222;color:#555;padding:5px 14px;border-radius:16px;font-size:12px;cursor:pointer}
.modal-tab.active{background:#222;border-color:#444;color:#fff}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.sbox{background:#1e1e1e;border-radius:10px;padding:14px;text-align:center}
.sbox .v{font-size:20px;font-weight:700}.sbox .l{font-size:11px;color:#555;margin-top:3px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#444;font-weight:500;padding:7px 8px;text-align:left;border-bottom:1px solid #222}
td{padding:8px 8px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
tr:last-child td{border:none}
.badge{display:inline-block;padding:2px 7px;border-radius:20px;font-size:11px;font-weight:700}
.buy-b{background:#1a3a1a;color:#4ade80}.sell-b{background:#3a1a1a;color:#ef4444}
.empty{text-align:center;padding:36px;color:#333;font-size:14px}
.open-pos{background:#1a1a2e;border:1px solid #2d2d5e;border-radius:10px;padding:12px 16px;margin-top:10px;font-size:13px}
.open-pos .op-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.open-pos .op-tag{font-size:11px;color:#818cf8;font-weight:700}
.btn-close-pos{background:#3a1a1a;color:#ef4444;border:none;padding:4px 10px;border-radius:7px;font-size:12px;cursor:pointer}
.analyse-tbl td,.analyse-tbl th{padding:6px 8px;font-size:12px}
.analyse-pos{color:#22c55e}.analyse-neg{color:#ef4444}
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

<!-- Equity Chart -->
<div class="card" style="margin-bottom:20px;cursor:default">
  <h2>Equity Kurve — Alle Strategien</h2>
  <div class="chart-wrap" id="chartWrap"><canvas id="equityChart"></canvas></div>
  <div class="chart-controls">
    <input type="range" id="zoomSlider" min="10" max="100" value="100" oninput="onZoom(this.value)">
    <span id="zoomLabel">100%</span>
    <button id="expandBtn" onclick="toggleChart()">Ausklappen</button>
    <button onclick="ladeChart()">Neu laden</button>
  </div>
</div>

<!-- Strategie Karten -->
<div class="cards-grid">
${kartenHTML}
</div>

<!-- Einzahlung -->
<div class="card" style="margin-bottom:16px;cursor:default">
  <h2 style="margin-bottom:14px">EIN- / AUSZAHLUNG</h2>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><div style="color:#555;font-size:11px;margin-bottom:5px">BETRAG (€)</div>
      <input type="number" id="betrag" placeholder="500" style="background:#222;border:1px solid #333;color:#fff;padding:9px 11px;border-radius:8px;width:120px;font-size:14px"></div>
    <div><div style="color:#555;font-size:11px;margin-bottom:5px">STRATEGIE</div>
      <select id="strategie-sel" style="background:#222;border:1px solid #333;color:#fff;padding:9px 11px;border-radius:8px;font-size:13px">
        ${ALLE_STRATEGIEN.map(n => `<option value="${n}">${n}</option>`).join('')}
        <option value="alle">Alle</option>
      </select></div>
    <button class="btn" style="background:#1a3a1a;color:#22c55e" onclick="einzahlung()">Einzahlen</button>
    <button class="btn" style="background:#3a1a1a;color:#ef4444" onclick="auszahlung()">Auszahlen</button>
  </div>
  <div id="zahlung-status" style="margin-top:10px;font-size:12px;color:#555"></div>
</div>
<button class="btn" style="background:#222;color:#fff" onclick="laden()">Aktualisieren</button>
<button class="btn" style="background:#1a0000;color:#ef4444" onclick="resetBot()">Reset</button>

<!-- Modal -->
<div class="overlay" id="overlay" onclick="bgClose(event)">
  <div class="modal">
    <div class="modal-top">
      <h2 id="modal-titel">Trades</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-tabs">
      <button class="modal-tab active" id="tab-trades" onclick="switchModalTab('trades')">Trades</button>
      <button class="modal-tab" id="tab-analyse" onclick="switchModalTab('analyse')">Stundenanalyse</button>
    </div>
    <!-- Trades Tab -->
    <div id="modal-trades-pane">
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
    <!-- Analyse Tab -->
    <div id="modal-analyse-pane" style="display:none">
      <div id="modal-analyse-body"><p style="color:#555;padding:20px">Klicke "Stundenanalyse" um Daten zu laden.</p></div>
    </div>
  </div>
</div>

<script>
const KARTEN = ${JSON.stringify(KARTEN_CONFIG)};
let aktStrat     = 'test';
let filterTage   = 7;
let chartInst    = null;
let allChartData = {};
let chartExpanded = false;
let zoomPct      = 100;

const farbenMap = {};
KARTEN.forEach(k => { farbenMap[k.id] = k.color; });

function pf(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }

function setFilter(tage) {
  filterTage = tage;
  ['f7','f30','f0'].forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById(tage===7?'f7':tage===30?'f30':'f0').classList.add('active');
  ladeChart();
}

function dirBars(d, id) {
  const el = document.getElementById(id);
  if (!el) return;
  const tot = (d.buyTrades||0) + (d.sellTrades||0);
  if (tot === 0) { el.innerHTML = ''; return; }
  const bp = Math.round((d.buyTrades||0)/tot*100);
  const bpnl = (d.buyPnL||0) >= 0 ? '+' : '';
  const spnl = (d.sellPnL||0) >= 0 ? '+' : '';
  el.innerHTML = \`
    <div class="dir-row"><span class="dir-label">LONG</span><div class="dir-bar-wrap"><div class="dir-bar dir-bar-buy" style="width:\${bp}%"></div></div><span class="dir-pct">\${bpnl}\${(d.buyPnL||0).toFixed(0)}€</span></div>
    <div class="dir-row"><span class="dir-label">SHORT</span><div class="dir-bar-wrap"><div class="dir-bar dir-bar-sell" style="width:\${100-bp}%"></div></div><span class="dir-pct">\${spnl}\${(d.sellPnL||0).toFixed(0)}€</span></div>
  \`;
}

function fillKarte(k, d) {
  if (!d) return;
  const eq = d.aktuellesEquity;
  const eqEl = document.getElementById(k.id+'-equity');
  if (eqEl) { eqEl.textContent = eq != null ? parseFloat(eq).toFixed(2)+' €' : '—'; eqEl.className = 'equity ' + (eq != null && eq >= (d.startEquity||1000) ? 'pos' : 'neg'); }
  const t = document.getElementById(k.id+'-trades'); if (t) t.textContent = d.trades;
  const wr = document.getElementById(k.id+'-winrate'); if (wr) wr.textContent = d.winRate+'%';
  const pe = document.getElementById(k.id+'-pnl');
  if (pe) {
    const pnlV = parseFloat(d.gesamtPnL);
    pe.textContent = (pnlV >= 0 ? '+' : '')+pnlV.toFixed(2)+' €';
    pe.className = 'stat-value '+pf(pnlV);
  }
  const dd = document.getElementById(k.id+'-dd'); if (dd) dd.textContent = d.drawdown+'%';
  dirBars(d, k.id+'-dirs');
}

async function laden() {
  try {
    const r = await fetch('/api/performance');
    if (!r.ok) throw new Error('HTTP '+r.status);
    const d = await r.json();
    document.getElementById('updatezeit').textContent = 'Letzte Aktualisierung: '+new Date(d.letzteAktualisierung).toLocaleString('de-DE');
    KARTEN.forEach(k => { fillKarte(k, d[k.id]||{}); ladeOffenePosition(k.id, k.id+'-openpos'); });
    ladeSmartRegime();
  } catch(e) { document.getElementById('updatezeit').textContent = '❌ '+e.message; }
}

async function ladeSmartRegime() {
  try {
    const r = await fetch('/api/smart-status');
    const s = await r.json();
    const el = document.getElementById('smart-openpos');
    if (!el) return;
    const modusMap = { AKTIV: ['🟢 AKTIV', '#22c55e'], VORSICHTIG: ['🟡 VORSICHTIG', '#eab308'], PAUSE: ['🔴 PAUSE', '#ef4444'] };
    const [label, color] = modusMap[s.modus] || ['—', '#666'];
    const pauseInfo = s.pauseMinLeft > 0 ? \` · ⏸ noch \${s.pauseMinLeft} Min.\` : '';
    el.innerHTML = \`<div style="background:#0f2a28;border:1px solid #1a4a44;border-radius:8px;padding:10px 14px;margin-top:10px;font-size:12px">
      <span style="color:#2dd4bf;font-weight:700;font-size:11px">REGIME</span>
      <span style="color:\${color};font-weight:700;margin-left:8px">\${label}\${pauseInfo}</span>
      <span style="color:#444;margin-left:12px">WR \${s.rollendeWinRate != null ? s.rollendeWinRate+'%' : '—'} · \${s.konsekVerluste} Verl.</span>
    </div>\`;
  } catch(e) {}
}

async function ladeOffenePosition(strat, elId) {
  try {
    const r = await fetch('/api/offene-position/'+strat);
    const d = await r.json();
    const el = document.getElementById(elId);
    if (!el) return;
    if (!d.position) { el.innerHTML = ''; return; }
    const pos = d.position, cl = pos.pnl >= 0 ? 'pos' : 'neg';
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
    alert(d.status === 'ok' ? '✅ Position geschlossen' : 'ℹ️ '+d.status);
    laden();
  } catch(e) { alert('❌ Fehler: '+e.message); }
}

// ── Equity Chart ─────────────────────────────────────────────────────────
function onZoom(val) {
  zoomPct = parseInt(val);
  document.getElementById('zoomLabel').textContent = val+'%';
  if (chartInst) renderChart();
}

function toggleChart() {
  chartExpanded = !chartExpanded;
  document.getElementById('chartWrap').className = 'chart-wrap'+(chartExpanded?' expanded':'');
  document.getElementById('expandBtn').textContent = chartExpanded ? 'Einklappen' : 'Ausklappen';
  if (chartInst) chartInst.resize();
}

async function ladeChart() {
  try {
    const vonDate = filterTage > 0 ? new Date(Date.now()-filterTage*86400000).toISOString().slice(0,10) : null;
    allChartData = {};
    for (const k of KARTEN) {
      const r = await fetch('/api/trades/'+k.id+(vonDate?'?von='+vonDate:''));
      const d = await r.json();
      if (!d.trades || !d.trades.length) continue;
      let eq = 1000;
      const pts = [{ ts: new Date(d.trades[0].datum).getTime() - 1, y: 1000 }];
      for (const t of d.trades) {
        eq = parseFloat((eq + t.pnl).toFixed(2));
        pts.push({ ts: new Date(t.datum).getTime(), y: eq });
      }
      allChartData[k.id] = { pts, farbe: k.color };
    }
    renderChart();
  } catch(e) { console.error('Chart Fehler:', e.message); }
}

function renderChart() {
  const ctx = document.getElementById('equityChart').getContext('2d');
  if (chartInst) { chartInst.destroy(); chartInst = null; }

  // Sammle alle Timestamps aller Strategien
  const allTsSet = new Set();
  for (const data of Object.values(allChartData)) {
    for (const p of data.pts) allTsSet.add(p.ts);
  }
  const sortedTs = [...allTsSet].sort((a, b) => a - b);
  if (!sortedTs.length) return;

  // Zoom anwenden
  const n = Math.max(2, Math.floor(sortedTs.length * zoomPct / 100));
  const visibleTs = sortedTs.slice(-n);
  const labels    = visibleTs.map(ts => new Date(ts).toLocaleDateString('de-DE'));

  const datasets = [];
  for (const [name, data] of Object.entries(allChartData)) {
    const tsToY  = Object.fromEntries(data.pts.map(p => [p.ts, p.y]));
    const firstTs = data.pts[0]?.ts || 0;
    const yData  = visibleTs.map(ts => ts >= firstTs && tsToY[ts] !== undefined ? tsToY[ts] : null);
    datasets.push({
      label: name, data: yData,
      borderColor: data.farbe, backgroundColor: data.farbe+'14',
      tension: 0.3, fill: false,
      pointRadius: visibleTs.length > 150 ? 0 : 2,
      spanGaps: false
    });
  }
  if (!datasets.length) return;

  chartInst = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#555', font: { size: 11 } } },
        tooltip: {
          mode: 'index', intersect: false,
          filter: item => item.parsed.y !== null,
          callbacks: {
            label: ctx => ctx.parsed.y !== null ? ctx.dataset.label+': '+ctx.parsed.y.toFixed(2)+'€' : null
          }
        }
      },
      scales: {
        x: { ticks: { color: '#444', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: '#1a1a1a' } },
        y: { ticks: { color: '#555', callback: v => v.toFixed(0)+'€', font: { size: 10 } }, grid: { color: '#1a1a1a' } }
      }
    }
  });
}

// ── Modal ────────────────────────────────────────────────────────────────
let aktModalTab = 'trades';

function switchModalTab(tab) {
  aktModalTab = tab;
  document.getElementById('tab-trades').classList.toggle('active', tab === 'trades');
  document.getElementById('tab-analyse').classList.toggle('active', tab === 'analyse');
  document.getElementById('modal-trades-pane').style.display = tab === 'trades' ? '' : 'none';
  document.getElementById('modal-analyse-pane').style.display = tab === 'analyse' ? '' : 'none';
  if (tab === 'analyse') ladeModalAnalyse();
}

function datumStr(offset) { const d=new Date(); d.setDate(d.getDate()+offset); return d.toISOString().slice(0,10); }
function setTag(offset)   { document.getElementById('modal-datum').value = datumStr(offset); }

function openModal(strat) {
  aktStrat = strat;
  const k = KARTEN.find(x => x.id === strat);
  document.getElementById('modal-titel').textContent = (k?.label||strat)+' — Trades';
  document.getElementById('overlay').classList.add('on');
  switchModalTab('trades');
  setTag(0);
  ladeModalTrades();
  ladeOffenePosition(strat, 'modal-openpos');
}
function closeModal() { document.getElementById('overlay').classList.remove('on'); }
function bgClose(e) { if (e.target === document.getElementById('overlay')) closeModal(); }

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
    if (!d.trades.length) { body.innerHTML='<div class="empty">Keine Trades an diesem Tag</div>'; return; }
    let h = '<table><thead><tr><th>Zeit</th><th>Richtung</th><th>P&L</th><th>Equity</th><th>SL</th><th>TP</th></tr></thead><tbody>';
    for (const t of d.trades) {
      const z = new Date(t.datum).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const cl = t.pnl>0?'pos':'neg';
      h += \`<tr><td>\${z}</td><td><span class="badge \${t.seite==='BUY'?'buy-b':'sell-b'}">\${t.seite}</span></td><td class="\${cl}">\${t.pnl>=0?'+':''}\${t.pnl.toFixed(2)}€</td><td>\${t.equity.toFixed(2)}€</td><td>\${t.sl}</td><td>\${t.tp}</td></tr>\`;
    }
    body.innerHTML = h+'</tbody></table>';
  } catch(e) { document.getElementById('modal-body').innerHTML = '<div class="empty">Fehler: '+e.message+'</div>'; }
}

async function ladeModalAnalyse() {
  const body = document.getElementById('modal-analyse-body');
  body.innerHTML = '<p style="color:#555;padding:12px">Lade...</p>';
  try {
    const r = await fetch('/api/analyse/'+aktStrat);
    const d = await r.json();
    let h = '<p style="color:#555;font-size:11px;margin-bottom:8px">Trades nach Uhrzeit (UTC)</p>';
    h += '<table class="analyse-tbl"><thead><tr><th>Stunde</th><th>Trades</th><th>Win%</th><th>Ø P&L</th><th>Gesamt</th></tr></thead><tbody>';
    for (const s of d.stunden) {
      if (s.trades === 0) continue;
      const cl = s.avgPnL >= 0 ? 'analyse-pos' : 'analyse-neg';
      h += \`<tr><td>\${String(s.stunde).padStart(2,'0')}:00</td><td>\${s.trades}</td><td>\${s.winRate}%</td><td class="\${cl}">\${s.avgPnL>=0?'+':''}\${s.avgPnL}€</td><td class="\${cl}">\${s.gesamtPnL>=0?'+':''}\${s.gesamtPnL}€</td></tr>\`;
    }
    h += '</tbody></table>';
    h += '<p style="color:#555;font-size:11px;margin:14px 0 8px">Trades nach Wochentag</p>';
    h += '<table class="analyse-tbl"><thead><tr><th>Tag</th><th>Trades</th><th>Win%</th><th>Ø P&L</th><th>Gesamt</th></tr></thead><tbody>';
    for (const w of d.wochentage) {
      if (w.trades === 0) continue;
      const cl = w.avgPnL >= 0 ? 'analyse-pos' : 'analyse-neg';
      h += \`<tr><td>\${w.tag}</td><td>\${w.trades}</td><td>\${w.winRate}%</td><td class="\${cl}">\${w.avgPnL>=0?'+':''}\${w.avgPnL}€</td><td class="\${cl}">\${w.gesamtPnL>=0?'+':''}\${w.gesamtPnL}€</td></tr>\`;
    }
    h += '</tbody></table>';
    body.innerHTML = h;
  } catch(e) { body.innerHTML = '<div class="empty">Fehler: '+e.message+'</div>'; }
}

async function resetBot() { if(!confirm('Wirklich zurücksetzen?')) return; await fetch('/api/reset',{method:'POST'}); laden(); }
async function einzahlung() {
  const b=document.getElementById('betrag').value, s=document.getElementById('strategie-sel').value;
  if(!b) return alert('Betrag eingeben');
  await fetch('/api/einzahlung?betrag='+b+'&strategie='+s);
  document.getElementById('zahlung-status').textContent='✅ Einzahlung '+b+'€ für '+s; laden();
}
async function auszahlung() {
  const b=document.getElementById('betrag').value, s=document.getElementById('strategie-sel').value;
  if(!b) return alert('Betrag eingeben');
  await fetch('/api/auszahlung?betrag='+b+'&strategie='+s);
  document.getElementById('zahlung-status').textContent='💸 Auszahlung '+b+'€ für '+s; laden();
}

laden(); ladeChart();
</script>
</body>
</html>`);
});

// ── Berliner Mitternachts-Reset (setInterval 60s) ──────────────────────────
let letzterBerlinTag = null;
setInterval(() => {
  const heuteBerlin = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  if (letzterBerlinTag && letzterBerlinTag !== heuteBerlin) {
    ALLE_STRATEGIEN.forEach(n => { tagesStartEquity[n] = null; });
    console.log(`🔄 Tages-Equity zurückgesetzt (Berliner Mitternacht: ${heuteBerlin})`);
  }
  letzterBerlinTag = heuteBerlin;
}, 60000);

// ── Tägliche Telegram Zusammenfassung um 22:00 UTC ────────────────────────
async function sendTageszusammenfassung() {
  try {
    const datum = datumBerlin(new Date().toISOString());
    let msg = `📊 <b>Tages-Zusammenfassung ${datum}</b>\n`;
    for (const name of ALLE_STRATEGIEN) {
      const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) === datum);
      if (!trades.length) continue;
      const pnl    = trades.reduce((s, t) => s + t.pnl, 0);
      const gewinn = trades.filter(t => t.pnl > 0).length;
      const wr     = ((gewinn / trades.length) * 100).toFixed(0);
      const best   = Math.max(...trades.map(t => t.pnl));
      const worst  = Math.min(...trades.map(t => t.pnl));
      // Fix #1: Gesamt P&L direkt aus Equity
      const gesamtPnL = letzteEquity[name] - STRATEGIEN[name].startEquity;
      msg += `\n<b>${name}</b>: ${trades.length}T | Tages-P&L: ${pnl>=0?'+':''}${pnl.toFixed(2)}€ | Win: ${wr}% | Best: +${best.toFixed(2)}€ | Worst: ${worst.toFixed(2)}€ | Equity: ${letzteEquity[name].toFixed(2)}€ | Gesamt: ${gesamtPnL>=0?'+':''}${gesamtPnL.toFixed(2)}€`;
    }
    await sendTelegram(msg);
  } catch (err) { console.error('❌ Tageszusammenfassung:', err.message); }
}
function schedule22Uhr() {
  const now = new Date(), next = new Date(now);
  next.setUTCHours(22, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { sendTageszusammenfassung(); schedule22Uhr(); }, next - now);
}
schedule22Uhr();

// ── Tägliches Backup um 23:00 UTC ─────────────────────────────────────────
async function sendeBackup() {
  try {
    const datum = new Date().toISOString().slice(0, 10);
    const berichte = '/data/berichte';
    if (!fs.existsSync(berichte)) fs.mkdirSync(berichte, { recursive: true });

    const einstellungen = ALLE_STRATEGIEN.map(n => {
      const s = STRATEGIEN[n];
      return `${n}: riskPct=${s.riskPct}%, leverage=${s.leverage}, maxDrawdown=${s.maxDrawdownPct}%, tagsStop=${s.tagsStopPct||5}%`;
    }).join('\n');

    let tagesPnL = 0, tagesTotalTrades = 0, tagesGewinn = 0;
    for (const name of ALLE_STRATEGIEN) {
      const trades = (tradeVerlauf[name] || []).filter(t => datumBerlin(t.datum) === datum);
      tagesPnL += trades.reduce((s, t) => s + t.pnl, 0);
      tagesGewinn += trades.filter(t => t.pnl > 0).length;
      tagesTotalTrades += trades.length;
    }
    const winRate      = tagesTotalTrades > 0 ? ((tagesGewinn / tagesTotalTrades) * 100).toFixed(1) : '0';
    const einschaetzung = tagesPnL > 0 ? 'Profitabler Tag ✅' : tagesPnL < 0 ? 'Verlusttag ❌' : 'Neutraler Tag ⚪';
    const equityLines  = ALLE_STRATEGIEN.map(n => `  - ${n}: ${letzteEquity[n].toFixed(2)}€`).join('\n');

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
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      const readme = `# Trading Bot Backup ${datum}\n\nEinstellungen:\n${einstellungen}\n\nAPI-Keys: NICHT GESPEICHERT\n`;
      await transporter.sendMail({
        from: process.env.EMAIL_USER, to: process.env.EMAIL_TO,
        subject: `Trading Bot Backup ${datum}`,
        text: `Tägliches Backup ${datum}.\nP&L: ${tagesPnL>=0?'+':''}${tagesPnL.toFixed(2)}€ | Trades: ${tagesTotalTrades} | Win Rate: ${winRate}%`,
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
  const now = new Date(), next = new Date(now);
  next.setUTCHours(23, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { sendeBackup(); schedule23Uhr(); }, next - now);
}
schedule23Uhr();

// ── Freitag 23:00 UTC — Wochenend-Schluss ─────────────────────────────────
function scheduleWochenendSchluss() {
  const now = new Date(), next = new Date(now);
  const tag = next.getUTCDay();
  const daysUntil = (5 - tag + 7) % 7 || 7;
  next.setUTCDate(next.getUTCDate() + daysUntil);
  next.setUTCHours(23, 0, 0, 0);
  if (tag === 5 && now.getUTCHours() < 23) { next.setUTCDate(now.getUTCDate()); next.setUTCHours(23, 0, 0, 0); }
  console.log(`📅 Wochenend-Schluss geplant: ${next.toUTCString()}`);
  setTimeout(async () => { await schliesseAllePositionen(); scheduleWochenendSchluss(); }, next - now);
}
scheduleWochenendSchluss();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf http://localhost:${PORT}`));
