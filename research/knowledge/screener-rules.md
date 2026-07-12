# PROJECT SQUEEZE — Screener-Regeln

Übersetzung der aktuell besten Backtest-Regeln in Filterkriterien für externe
Aktien-Screener (Finviz, TradingView, Trade Ideas etc.). Diese Plattform
findet und validiert die Regel gegen die eigene Wissensdatenbank — sie kann
aber nur die ~86 selbst getrackten Symbole scannen, keinen ganzen Markt. Für
die tägliche Suche über alle Aktien braucht es einen externen Screener mit
diesen Kriterien.

Stand: Backtest-Lauf mit Lookahead 10 Handelstage, 924 Fälle in der
Wissensdatenbank (235 kuratiert + 689 automatisch erkannt). Basisrate (wie
oft irgendwann ohnehin ein Squeeze folgt): ~4,2% aller Tage. Alle Werte sind
Trefferquoten aus historischem Backtest, keine Garantie — bei kleinen
Stichproben (n) entsprechend vorsichtig gewichten.

## Regel A — breiter, robuster (empfohlen als Startpunkt)

**RVOL > 5 UND 20-Tage-Breakout UND Trendstruktur: Uptrend**
Trefferquote: 12% (n=124) — mit zusätzlich "EMA20 > EMA50": 14% (n=95)

Screener-Übersetzung:
- **Relative Volume**: über 5 (Finviz: Filter "Relative Volume" → "Over 5")
- **20-Day High**: "New High" (Finviz: Filter "20-Day High/Low" → "New High")
- Trendstruktur/Uptrend: Kurs über SMA50, optional SMA20 über SMA50 für den zusätzlichen EMA-Filter

## Regel B — enger, höhere Trefferquote, kleinere Stichprobe

**RVOL > 3 UND Days to Cover > 10 UND Trendstruktur: Uptrend UND Bullish Engulfing**
Trefferquote: 25% (n=8) — kleine Stichprobe, vorsichtig interpretieren

Screener-Übersetzung:
- **Relative Volume**: über 3 (Finviz: Filter "Relative Volume" → "Over 3"; die meisten Screener haben das direkt)
- **Short Interest Ratio**: über 10 (Finviz: Filter "Short Interest Ratio" → "Over 10"; andere Screener nennen es "Days to Cover" oder "Short Ratio")
- Trendstruktur/Uptrend: über SMA50, SMA20 > SMA50
- **Bullish Engulfing**: auf Finviz Free NICHT als Filter verfügbar — TradingView (bezahlte Screener-Stufe) hat "Candlestick Patterns"; sonst manuell im Chart bestätigen

## Stop-Loss / Take-Profit — Kalibrierung aus allen kuratierten Fällen

`node research/cli.js risk:knowledge-base 10` — Entry angenommen 10
Handelstage vor dem erfassten Squeeze-Start, Basis: 232 von 235 kuratierten
Fällen mit auswertbaren Kursdaten (manuell recherchierte + aus den
hochgeladenen Listen verifizierte, ohne die 689 blind erkannten Fälle).
Das ist eine viel breitere, robustere Stichprobe als die regel-spezifische
Analyse oben (dort nur 5-124 echte Signale je Regel).

| Kennzahl | Wert |
|---|---|
| Median-Rückgang nach Entry vor Squeeze-Start | −13,7% |
| Schlechteste 10% der Fälle fielen mindestens | −37,3% |
| Schlechtester Einzelfall | −82,6% |
| Median Handelstage bis zum Tiefpunkt | 10 |
| Median-Gewinn vom Entry bis zum Peak | +150,7% |
| Schwächste 10% der Fälle erreichten höchstens | +29,0% |
| Median Handelstage bis zum Peak | 45 |
| Längste beobachtete Zeit bis zum Peak | 60 Handelstage |

**Grobe Faustregel daraus:** Stop-Loss bei ca. **35-40%** unter Entry, Take-Profit-Zone ab ca. **+29-30%** (erste Teilgewinne realistisch), mit Geduld für mehrere Wochen bis zum eigentlichen Peak (Median ~9 Wochen). Der schlechteste Einzelfall (−82,6%) zeigt: kein SL macht das Risiko vollständig beherrschbar, das bleibt spekulativ. Diese Zahlen sind bereits über zwei Ausbaustufen der Wissensdatenbank (175 → 235 kuratierte Fälle) auffällig stabil geblieben — ein gutes Zeichen für echte Konvergenz statt Zufall. Wachsen weiter mit jedem neuen Fall — bei Bedarf neu laufen lassen und hier aktualisieren.

## Kandidaten, die man findet, danach hier prüfen

Sobald der externe Screener Kandidaten liefert: Ticker durch
`node research/cli.js scan` laufen lassen (falls das Symbol schon getrackt
wird), `node research/cli.js risk:knowledge-base` für die allgemeine SL/TP-
Kalibrierung oben konsultieren, oder `node research/cli.js risk:analyze`
für eine regel-spezifische (aber kleinere Stichprobe) Einordnung.

## Einschränkungen

- Days-to-Cover-Daten (FINRA) werden nur zweimal im Monat aktualisiert —
  auch externe Screener beziehen das meist aus derselben Quelle, ist also
  vergleichbar "verspätet".
- Kerzenmuster (Bullish Engulfing, Hammer) sind in kostenlosen Screenern
  selten filterbar — hier bleibt oft nur die manuelle Chart-Kontrolle.
- Diese Regeln stammen aus einer noch kleinen, wachsenden Wissensdatenbank
  (siehe research/knowledge/) — sie werden sich ändern, sobald mehr Fälle
  und die Catalyst-/Kontrollgruppen-Daten fertig sind. Diese Datei wird bei
  Bedarf neu generiert, nicht von Hand aktuell gehalten.
