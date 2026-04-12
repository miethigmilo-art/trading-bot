process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const axios = require('axios');
const app = express();
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

const STRATEGIEN = {
  mittel: {
    konto:          KONTO_MITTEL,
    epic:           'GOLD',
    riskPct:        1.7,
    reservePct:     100,
    leverage:       10,
    maxDrawdownPct: 20,
    startEquity:    1000
  },
  aggressiv: {
    konto:          KONTO_AGGRESSIV,
    epic:           'GOLD',
    riskPct:        3.1,
    reservePct:     100,
    leverage:       10,
    maxDrawdownPct: 30,
    startEquity:    1000
  }
};

let performance = {
  mittel:    { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
  aggressiv: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 }
};

let letzteEquity = { mittel: 1000, aggressiv: 1000 };
let letzteAktualisierung = new Date().toISOString();

async function login(konto) {
  const res = await axios.post(`${konto.baseUrl}/session`, {
    identifier: konto.email,
    password:   konto.password
  }, { headers: { 'X-CAP-API-KEY': konto.apiKey } });
  konto.cst   = res.headers['cst'];
  konto.token = res.headers['x-security-token'];
  console.log(`✅ Login erfolgreich: ${konto.email}`);
}

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
    const equity = account?.balance?.equity
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

function checkDrawdown(equity, strategie, strategieName) {
  if (performance[strategieName].trades === 0) return false;
  const drawdown = ((strategie.startEquity - equity) / strategie.startEquity) * 100;
  console.log(`📉 [${strategieName}] Drawdown: ${drawdown.toFixed(2)}%`);
  return drawdown >= strategie.maxDrawdownPct;
}

function calcSize(equity, sl, tp, strategie) {
  const riskCapital = equity * (strategie.riskPct / 100) * strategie.leverage;
  const slDistance  = Math.abs(parseFloat(tp) - parseFloat(sl));
  let size = riskCapital / slDistance;
  const maxSize = (equity * strategie.leverage) / parseFloat(sl);
  size = Math.min(size, maxSize);
  return Math.max(1, parseFloat(size.toFixed(1)));
}

function updatePerformance(strategieName, pnl) {
  // ── Equity Kurve speichern ────────────────────────────
const fs   = require('fs');
const path = require('path');
const EQUITY_FILE = '/data/equity.json';

function ladeEquityDaten() {
  try {
    if (fs.existsSync(EQUITY_FILE)) {
      return JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('❌ Equity Datei laden fehlgeschlagen:', err.message);
  }
  return { mittel: [], aggressiv: [] };
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
  equityVerlauf[strategieName].push({
    datum: new Date().toISOString(),
    equity: parseFloat(equity)
  });
  speichereEquityDaten(equityVerlauf);
  console.log(`📈 Equity Punkt gespeichert [${strategieName}]: ${equity}€`);
}
const p = performance[strategieName];
  p.trades++;
  p.gesamtPnL += pnl;
  if (pnl > 0) p.gewinn++;
  else p.verlust++;
  if (pnl > p.bestesTrade) p.bestesTrade = pnl;
  if (pnl < p.schlechtestesTrade) p.schlechtestesTrade = pnl;
  letzteAktualisierung = new Date().toISOString();
}

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
    if (pnl !== 0) updatePerformance(strategieName, pnl);
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

app.post('/webhook/mittel',    (req, res) => handleWebhook(req, res, 'mittel'));
app.post('/webhook/aggressiv', (req, res) => handleWebhook(req, res, 'aggressiv'));

app.get('/api/performance', async (req, res) => {
  try {
    if (!KONTO_MITTEL.cst)    await login(KONTO_MITTEL);
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const equityMittel    = await getEquity(KONTO_MITTEL);
    const equityAggressiv = await getEquity(KONTO_AGGRESSIV);
    res.json({
      letzteAktualisierung,
      mittel: {
        ...performance.mittel,
        aktuellesEquity: equityMittel,
        gesamtPnL:       performance.mittel.gesamtPnL.toFixed(2),
        drawdown:        performance.mittel.trades === 0 ? '0.00' : (((STRATEGIEN.mittel.startEquity - equityMittel) / STRATEGIEN.mittel.startEquity) * 100).toFixed(2),
        winRate:         performance.mittel.trades > 0 ? ((performance.mittel.gewinn / performance.mittel.trades) * 100).toFixed(1) : '0'
      },
      aggressiv: {
        ...performance.aggressiv,
        aktuellesEquity: equityAggressiv,
        gesamtPnL:       performance.aggressiv.gesamtPnL.toFixed(2),
        drawdown:        performance.aggressiv.trades === 0 ? '0.00' : (((STRATEGIEN.aggressiv.startEquity - equityAggressiv) / STRATEGIEN.aggressiv.startEquity) * 100).toFixed(2),
        winRate:         performance.aggressiv.trades > 0 ? ((performance.aggressiv.gewinn / performance.aggressiv.trades) * 100).toFixed(1) : '0'
      }
    });
  } catch (err) {
    res.status(500).json({ fehler: err.message });
  }
});

app.post('/api/reset', (req, res) => {
  performance = {
    mittel:    { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 },
    aggressiv: { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bestesTrade: 0, schlechtestesTrade: 0, startEquity: 1000 }
  };
  letzteEquity = { mittel: 10500, aggressiv: 1000 };
  letzteAktualisierung = new Date().toISOString();
  res.json({ status: 'ok' });
});

app.get('/test', async (req, res) => {
  try {
    if (!KONTO_MITTEL.cst)    await login(KONTO_MITTEL);
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const equityMittel    = await getEquity(KONTO_MITTEL);
    const equityAggressiv = await getEquity(KONTO_AGGRESSIV);
    res.json({
      status:          '✅ Beide Konten verbunden',
      equityMittel:    equityMittel + '€',
      equityAggressiv: equityAggressiv + '€'
    });
  } catch (err) {
    res.json({ status: '❌ Fehler', fehler: err.message });
  }
});

app.get('/test/trade', async (req, res) => {
  try {
    if (!KONTO_AGGRESSIV.cst) await login(KONTO_AGGRESSIV);
    const equity = await getEquity(KONTO_AGGRESSIV);
    const marketRes = await axios.get(`${KONTO_AGGRESSIV.baseUrl}/markets/GOLD`, {
      headers: {
        'X-CAP-API-KEY':    KONTO_AGGRESSIV.apiKey,
        'CST':              KONTO_AGGRESSIV.cst,
        'X-SECURITY-TOKEN': KONTO_AGGRESSIV.token
      }
    });
    const currentPrice = marketRes.data.snapshot.offer;
    const sl   = (currentPrice * 0.99).toFixed(2);
    const tp   = (currentPrice * 1.02).toFixed(2);
    const size = calcSize(equity, sl, tp, STRATEGIEN.aggressiv);
    const order = {
      epic:           'GOLD',
      direction:      'BUY',
      size:           size,
      guaranteedStop: false,
      stopLevel:      parseFloat(sl),
      profitLevel:    parseFloat(tp)
    };
    await axios.post(`${KONTO_AGGRESSIV.baseUrl}/positions`, order, {
      headers: {
        'X-CAP-API-KEY':    KONTO_AGGRESSIV.apiKey,
        'CST':              KONTO_AGGRESSIV.cst,
        'X-SECURITY-TOKEN': KONTO_AGGRESSIV.token
      }
    });
    await sendTelegram(
      `🟢 <b>TEST LONG eröffnet</b>\n` +
      `Strategie: <b>Aggressiv</b>\n` +
      `Größe: <b>${size} Units</b>\n` +
      `SL: <b>${sl}$</b>\n` +
      `TP: <b>${tp}$</b>`
    );
    res.json({ status: '✅ Test Trade platziert!', size, sl, tp });
  } catch (err) {
    res.json({ fehler: err.response?.data || err.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #fff; padding: 24px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 6px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card { background: #1a1a1a; border-radius: 12px; padding: 24px; border: 1px solid #222; }
  .card h2 { font-size: 14px; color: #888; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; }
  .equity { font-size: 36px; font-weight: 700; }
  .stat { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #222; }
  .stat:last-child { border-bottom: none; }
  .stat-label { color: #888; font-size: 14px; }
  .stat-value { font-size: 15px; font-weight: 600; }
  .pos { color: #22c55e; }
  .neg { color: #ef4444; }
  .tag { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .tag-mittel { background: #1e3a5f; color: #60a5fa; }
  .tag-aggressiv { background: #3b1f00; color: #fb923c; }
  .btn { padding: 10px 20px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; margin-right: 8px; }
  .btn-refresh { background: #222; color: #fff; }
  .btn-reset { background: #2a0000; color: #ef4444; }
</style>
</head>
<body>
<h1>Trading Bot Dashboard</h1>
<p class="subtitle" id="updatezeit">Wird geladen...</p>

<div class="card" style="margin-bottom:16px">
  <h2>Equity Kurve</h2>
  <canvas id="equityChart" height="80"></canvas>
</div>
<div class="grid">
  <div class="card">
    <h2><span class="tag tag-mittel">Mittel</span></h2>
    <div class="equity pos" id="m-equity">...</div>
    <br>
    <div class="stat"><span class="stat-label">Trades gesamt</span><span class="stat-value" id="m-trades">-</span></div>
    <div class="stat"><span class="stat-label">Gewinn-Trades</span><span class="stat-value pos" id="m-gewinn">-</span></div>
    <div class="stat"><span class="stat-label">Verlust-Trades</span><span class="stat-value neg" id="m-verlust">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="m-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt PnL</span><span class="stat-value" id="m-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Bester Trade</span><span class="stat-value pos" id="m-best">-</span></div>
    <div class="stat"><span class="stat-label">Schlechtester Trade</span><span class="stat-value neg" id="m-worst">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="m-dd">-</span></div>
  </div>
  <div class="card">
    <h2><span class="tag tag-aggressiv">Aggressiv</span></h2>
    <div class="equity pos" id="a-equity">...</div>
    <br>
    <div class="stat"><span class="stat-label">Trades gesamt</span><span class="stat-value" id="a-trades">-</span></div>
    <div class="stat"><span class="stat-label">Gewinn-Trades</span><span class="stat-value pos" id="a-gewinn">-</span></div>
    <div class="stat"><span class="stat-label">Verlust-Trades</span><span class="stat-value neg" id="a-verlust">-</span></div>
    <div class="stat"><span class="stat-label">Win Rate</span><span class="stat-value" id="a-winrate">-</span></div>
    <div class="stat"><span class="stat-label">Gesamt PnL</span><span class="stat-value" id="a-pnl">-</span></div>
    <div class="stat"><span class="stat-label">Bester Trade</span><span class="stat-value pos" id="a-best">-</span></div>
    <div class="stat"><span class="stat-label">Schlechtester Trade</span><span class="stat-value neg" id="a-worst">-</span></div>
    <div class="stat"><span class="stat-label">Drawdown</span><span class="stat-value" id="a-dd">-</span></div>
  </div>
</div>
<div class="card" style="margin-bottom:16px;grid-column:1/-1">
  <h2>Ein- / Auszahlung</h2>
  <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
    <div>
      <div style="color:#888;font-size:12px;margin-bottom:6px">Betrag (€)</div>
      <input type="number" id="betrag" placeholder="z.B. 500" style="background:#222;border:1px solid #333;color:#fff;padding:10px;border-radius:8px;width:140px;font-size:14px">
    </div>
    <div>
      <div style="color:#888;font-size:12px;margin-bottom:6px">Strategie</div>
      <select id="strategie" style="background:#222;border:1px solid #333;color:#fff;padding:10px;border-radius:8px;font-size:14px">
        <option value="mittel">Mittel</option>
        <option value="aggressiv">Aggressiv</option>
        <option value="beide">Beide</option>
      </select>
    </div>
    <button class="btn" style="background:#1a3a1a;color:#22c55e" onclick="einzahlung()">Einzahlen</button>
    <button class="btn" style="background:#3a1a1a;color:#ef4444" onclick="auszahlung()">Auszahlen</button>
  </div>
  <div id="zahlung-status" style="margin-top:12px;font-size:13px;color:#888"></div>
</div>
<button class="btn btn-refresh" onclick="laden()">Aktualisieren</button>
<button class="btn btn-reset" onclick="reset()">Statistik zurücksetzen</button>
<script>
function pnlFarbe(val) { return val > 0 ? 'pos' : val < 0 ? 'neg' : ''; }

async function laden() {
  const res  = await fetch('/api/performance');
  const data = await res.json();
  document.getElementById('updatezeit').textContent = 'Letzte Aktualisierung: ' + new Date(data.letzteAktualisierung).toLocaleString('de-DE');
  const m = data.mittel;
  document.getElementById('m-equity').textContent  = parseFloat(m.aktuellesEquity).toFixed(2) + ' €';
  document.getElementById('m-trades').textContent  = m.trades;
  document.getElementById('m-gewinn').textContent  = m.gewinn;
  document.getElementById('m-verlust').textContent = m.verlust;
  document.getElementById('m-winrate').textContent = m.winRate + '%';
  const mPnl = document.getElementById('m-pnl');
  mPnl.textContent = (m.gesamtPnL >= 0 ? '+' : '') + parseFloat(m.gesamtPnL).toFixed(2) + ' €';
  mPnl.className   = 'stat-value ' + pnlFarbe(parseFloat(m.gesamtPnL));
  document.getElementById('m-best').textContent    = '+' + parseFloat(m.bestesTrade).toFixed(2) + ' €';
  document.getElementById('m-worst').textContent   = parseFloat(m.schlechtestesTrade).toFixed(2) + ' €';
  document.getElementById('m-dd').textContent      = m.drawdown + '%';
  const a = data.aggressiv;
  document.getElementById('a-equity').textContent  = parseFloat(a.aktuellesEquity).toFixed(2) + ' €';
  document.getElementById('a-trades').textContent  = a.trades;
  document.getElementById('a-gewinn').textContent  = a.gewinn;
  document.getElementById('a-verlust').textContent = a.verlust;
  document.getElementById('a-winrate').textContent = a.winRate + '%';
  const aPnl = document.getElementById('a-pnl');
  aPnl.textContent = (a.gesamtPnL >= 0 ? '+' : '') + parseFloat(a.gesamtPnL).toFixed(2) + ' €';
  aPnl.className   = 'stat-value ' + pnlFarbe(parseFloat(a.gesamtPnL));
  document.getElementById('a-best').textContent    = '+' + parseFloat(a.bestesTrade).toFixed(2) + ' €';
  document.getElementById('a-worst').textContent   = parseFloat(a.schlechtestesTrade).toFixed(2) + ' €';
  document.getElementById('a-dd').textContent      = a.drawdown + '%';
}

async function reset() {
  if (!confirm('Statistik wirklich zurücksetzen?')) return;
  await fetch('/api/reset', { method: 'POST' });
  laden();
async function ladeChart() {
  const res  = await fetch('/api/equity');
  const data = await res.json();

  const mittelDaten    = data.mittel    || [];
  const aggressivDaten = data.aggressiv || [];

  const labels = [...new Set([
    ...mittelDaten.map(p => new Date(p.datum).toLocaleDateString('de-DE')),
    ...aggressivDaten.map(p => new Date(p.datum).toLocaleDateString('de-DE'))
  ])].sort();

  const ctx = document.getElementById('equityChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label:           'Mittel',
          data:            mittelDaten.map(p => p.equity),
          borderColor:     '#60a5fa',
          backgroundColor: 'rgba(96,165,250,0.1)',
          tension:         0.3,
          fill:            true
        },
        {
          label:           'Aggressiv',
          data:            aggressivDaten.map(p => p.equity),
          borderColor:     '#fb923c',
          backgroundColor: 'rgba(251,146,60,0.1)',
          tension:         0.3,
          fill:            true
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#fff' } }
      },
      scales: {
        x: { ticks: { color: '#888' }, grid: { color: '#222' } },
        y: { ticks: { color: '#888', callback: v => v + '€' }, grid: { color: '#222' } }
      }
    }
  });
}
}

async function einzahlung() {
  const betrag    = document.getElementById('betrag').value;
  const strategie = document.getElementById('strategie').value;
  if (!betrag) return alert('Bitte Betrag eingeben!');
  await fetch('/api/einzahlung?betrag=' + betrag + '&strategie=' + strategie);
  document.getElementById('zahlung-status').textContent = '✅ Einzahlung: ' + betrag + '€ für ' + strategie;
  laden();
}

async function auszahlung() {
  const betrag    = document.getElementById('betrag').value;
  const strategie = document.getElementById('strategie').value;
  if (!betrag) return alert('Bitte Betrag eingeben!');
  await fetch('/api/auszahlung?betrag=' + betrag + '&strategie=' + strategie);
  document.getElementById('zahlung-status').textContent = '💸 Auszahlung: ' + betrag + '€ für ' + strategie;
  laden();
}

laden();
ladeChart();
</script>
</body>
</html>`);
});
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

  console.log(`📨 SL Update [${strategieName}]:`, req.body);

  if (action !== 'UPDATE_SL' || !sl) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }

  const strategie = STRATEGIEN[strategieName];
  if (!strategie) {
    return res.status(400).json({ error: 'Unbekannte Strategie' });
  }

  const konto = strategie.konto;

  try {
    if (!konto.cst) await login(konto);

    const position = await getOpenPosition(konto, strategie.epic);

    if (!position) {
      console.log(`⚠️ [${strategieName}] Keine offene Position gefunden`);
      return res.json({ status: 'keine Position offen' });
    }

    const dealId = position.position.dealId;

    await axios.put(`${konto.baseUrl}/positions/${dealId}`, {
      stopLevel: parseFloat(sl)
    }, {
      headers: {
        'X-CAP-API-KEY':    konto.apiKey,
        'CST':              konto.cst,
        'X-SECURITY-TOKEN': konto.token
      }
    });

    console.log(`✅ [${strategieName}] SL aktualisiert auf ${sl}`);

    await sendTelegram(
      `🔄 <b>SL aktualisiert</b>\n` +
      `Strategie: <b>${strategieName}</b>\n` +
      `Neuer SL: <b>${sl}$</b>`
    );

    res.json({ status: 'ok', neuerSL: sl });

  } catch (err) {
    if (err.response?.status === 401) {
      konto.cst = null;
      await login(konto);
      return res.status(500).json({ error: 'Session erneuert' });
    }
    console.error(`❌ SL Update Fehler:`, err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── Einzahlung ────────────────────────────────────────
app.get('/api/einzahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;

  if (!betrag || betrag <= 0) {
    return res.status(400).json({ error: 'Ungültiger Betrag' });
  }

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

  console.log(`💰 Einzahlung: ${betrag}€ für ${strategie}`);
  res.json({
    status: 'ok',
    betrag,
    strategie,
    neuesStartkapitalMittel:    STRATEGIEN.mittel.startEquity,
    neuesStartkapitalAggressiv: STRATEGIEN.aggressiv.startEquity
  });
});

// ── Auszahlung ────────────────────────────────────────
app.get('/api/auszahlung', (req, res) => {
  const betrag    = parseFloat(req.query.betrag);
  const strategie = req.query.strategie;

  if (!betrag || betrag <= 0) {
    return res.status(400).json({ error: 'Ungültiger Betrag' });
  }

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

  console.log(`💸 Auszahlung: ${betrag}€ für ${strategie}`);
  res.json({
    status: 'ok',
    betrag,
    strategie,
    neuesStartkapitalMittel:    STRATEGIEN.mittel.startEquity,
    neuesStartkapitalAggressiv: STRATEGIEN.aggressiv.startEquity
  });
});
app.get('/api/equity', (req, res) => {
  res.json(equityVerlauf);
});
app.listen(3000, () => console.log('🚀 Server läuft auf http://localhost:3000'));
