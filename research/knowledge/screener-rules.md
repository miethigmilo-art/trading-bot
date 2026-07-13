# PROJECT SQUEEZE — Screener-Regeln

Übersetzung der aktuell besten Backtest-Regeln in Filterkriterien für externe
Aktien-Screener (Finviz, TradingView, Trade Ideas etc.). Diese Plattform
findet und validiert die Regel gegen die eigene Wissensdatenbank — sie kann
aber nur die ~86 selbst getrackten Symbole scannen, keinen ganzen Markt. Für
die tägliche Suche über alle Aktien braucht es einen externen Screener mit
diesen Kriterien.

Stand: Backtest-Lauf mit Lookahead 10 Handelstage, 1.120 Fälle in der
Wissensdatenbank (335 kuratiert + 785 automatisch erkannt). Basisrate (wie
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

Basis: 332 von 335 kuratierten Fällen mit auswertbaren Kursdaten.

| Kennzahl | Wert |
|---|---|
| Median-Rückgang nach Entry vor Squeeze-Start | −13,1% |
| Schlechteste 10% der Fälle fielen mindestens | −40,3% |
| Schlechtester Einzelfall | −82,6% |
| Median Handelstage bis zum Tiefpunkt | 10 |
| Median-Gewinn vom Entry bis zum Peak | +148,0% |
| Schwächste 10% der Fälle erreichten höchstens | +27,5% |
| Median Handelstage bis zum Peak | 44 |
| Längste beobachtete Zeit bis zum Peak | 60 Handelstage |

**Grobe Faustregel daraus:** Stop-Loss bei ca. **35-40%** unter Entry, Take-Profit-Zone ab ca. **+28-30%** (erste Teilgewinne realistisch), mit Geduld für mehrere Wochen bis zum eigentlichen Peak (Median ~9 Wochen). Der schlechteste Einzelfall (−82,6%) zeigt: kein SL macht das Risiko vollständig beherrschbar, das bleibt spekulativ. Diese Zahlen sind über DREI Ausbaustufen der Wissensdatenbank (172 → 232 → 332 auswertbare kuratierte Fälle) auffällig stabil geblieben (Median-Rückgang −13,7/−13,6/−13,1%, Median-Gewinn +150,7/+150,5/+148,0%) — ein starker Beleg für echte Konvergenz statt Zufall.

## Recall-Diagnose: Wie sieht der Tag VOR dem Anstieg aus? (230 Fälle)

`node research/cli.js stats:pre-event` — misst die Feature-Verteilung am
Handelstag unmittelbar vor dem erfassten Anstiegs-Beginn, verglichen mit
normalen Handelstagen. Erklärt das Recall-Problem der bullischen Regeln:

| Merkmal am Vortag | Echte Fälle | Normale Tage | Lift |
|---|---|---|---|
| 5-Tage-Rückgang > 10% (Kapitulation) | 37% | 17% | **2,2x** |
| RVOL > 2 (Volumen zieht schon an) | 13% | 7% | **1,9x** |
| EMA20 > EMA50 (bullisch) | 44% | 32% | 1,4x |
| Trendstruktur: Uptrend | 30% | 21% | 1,4x |
| Trendstruktur: Downtrend | 29% | 34% | 0,9x |
| Dry Volume (RVOL < 0.7) | 36% | 39% | 0,9x |
| Days to Cover > 5 | 38% | 49% | 0,8x |

**Kernerkenntnisse:**
- Das stärkste Vorlauf-Signal ist die **Kapitulation** — ein scharfer
  5-Tage-Absturz von >10% ging 37% der echten Fälle unmittelbar voraus
  (2,2x häufiger als an normalen Tagen). Das deckt sich mit der
  SL-Analyse (Median −13,7% in den 10 Tagen vor dem Start).
- "Dry Volume" allein ist entgegen der Intuition KEIN Signal (0,9x) —
  aber bei 13% der Fälle zieht das Volumen schon am Vortag an (1,9x).
- Days to Cover am Vortag ist sogar leicht UNTER Baseline — der hohe
  Short-Interest-Wert allein sagt nichts über das Timing.
- Es gibt offenbar (mind.) zwei Vorphasen-Typen: Kapitulations-Reversal
  (Absturz → V-förmige Explosion) und Momentum-Fortsetzung (Anstieg beginnt
  aus bestehendem Uptrend mit anziehendem Volumen).

## Präzision-Recall-Spektrum: die Kapitulations-Regeln (Backtest, Lookahead 10 Tage)

Konsequenz aus der Recall-Diagnose oben — mit den neuen Kapitulations-Features
gibt es erstmals Regeln, die einen nennenswerten Anteil der echten Anstiege
IM VORAUS erfassen. Man wählt auf diesem Spektrum zwischen "viele Fälle
erwischen, viele Fehlalarme" und "wenig Fehlalarme, fast alles verpassen":

| Regel | Trefferquote | Recall | Signale |
|---|---|---|---|
| 5-Tage-Rückgang > 10% (allein) | 7,0% (1,7x Basis) | **31%** | 35.769 |
| Downtrend (LH+LL) + Kapitulation | 7,8% (1,9x) | 12,5% | 12.599 |
| Days to Cover > 5 + Kapitulation | 7,2% (1,7x) | 13,5% | 7.955 |
| RVOL > 3 + Kapitulation | 8,7% (2,1x) | 1,6% | 1.459 |
| RVOL > 3 + DTC > 5 + Downtrend + Kapitulation | **12,0% (2,9x)** | 0,4% | 133 |

Screener-Übersetzung der Kapitulations-Basisregel:
- **Performance (Woche)**: unter −10% (Finviz: "Performance" → "Week -10%")
- Optional Downtrend: Kurs unter SMA50 (Annäherung an unsere LH+LL-Struktur)
- Optional Short Interest Ratio > 5 für die DTC-Variante

Ehrliche Einordnung: 7-8% Trefferquote heißt >90% Fehlalarme — als
alleiniges Kaufsignal unbrauchbar, aber als VORWARN-Filter sinnvoll
(Watchlist der Kapitulations-Kandidaten bilden, dann auf den Zünder warten).
Die alten bullischen Regeln (oben) bleiben als Bestätigungs-Signale nützlich,
erkennen den Einstieg aber erst, wenn die Bewegung schon läuft.

### Zünder-Analyse: Zwei-Stufen-Test (`ignition:test`)

Setup = "Kapitulation in den letzten 10 Handelstagen". Ergebnis:

- **Das Setup allein definiert den Kandidaten-Pool: 70% aller echten
  Anstiege starten aus diesem Zustand heraus** (5,3% Trefferquote, 1,3x
  Basisrate, ~108.000 Signal-Tage). Das ist die Screener-Vorstufe.
- Preisbasierte Zünder verbessern die Präzision nur moderat: bester Wert
  ist RVOL > 3 im Setup (7,5% @ 3% Recall). Grüne Erholungstage nach der
  Kapitulation sind KEIN Zünder (4,6% — kaum über Basisrate): die erste
  grüne Kerze ist statistisch öfter Dead-Cat-Bounce als Start.
- Schlussfolgerung: der eigentliche Zünder steckt offenbar NICHT im
  Kursbild, sondern im Katalysator (News/Social) — genau das, was Modul 4
  (Catalyst Engine) gerade an historischen Daten sammelt. Sobald die
  News-Abdeckung vollständig ist, ist "Kapitulations-Setup + News-Spike"
  die wichtigste zu testende Hypothese.

## Universalitäts-Validierung: hält die Regel in jedem Marktregime?

`node research/cli.js validate:rules` — die Kernregeln getrennt in drei
Marktregimen getestet (Meme-Ära bis 2021, Bärenmarkt 2022–2023,
KI/Quantum-Ära 2024+). Maßstab ist der Lift gegenüber der Basisrate der
jeweiligen Ära:

Stand: 1.120 Fälle in der Wissensdatenbank.

| Regel | bis 2021 | 2022–23 | 2024+ | Urteil |
|---|---|---|---|---|
| Kapitulation (5d < −10%) | 1,7x | 1,7x | 1,6x | **universell** |
| Downtrend + Kapitulation | 1,9x | 2,0x | 1,7x | **universell** |
| Days to Cover > 5 + Kapitulation | 1,3x | 1,4x | 1,4x | **universell** |
| RVOL>5 + 20d-Breakout + Uptrend | 2,5x (n=55) | 1,4x (n=36) | 2,9x (n=62) | positiv, aber n klein |
| DTC>10 + 52w-Breakout + Uptrend | 3,3x (n=14) | n=0 | 0,0x (n=19) | **nicht belastbar** |

**Fazit:** Die Kapitulations-Familie ist regime-unabhängig — der Lift
schwankt nur zwischen 1,3x und 2,0x über drei völlig verschiedene
Marktphasen, und dieses Bild ist über den Ausbau der Wissensdatenbank
(924 → 1.120 Fälle) praktisch unverändert geblieben. Das ist die bislang
beste Annäherung an eine "universelle Regel", die diese Plattform belegen
kann. Die bullischen Hochpräzisions-Regeln sind dagegen selten und
era-abhängig (im Bärenmarkt 2022–23 feuerte die 52-Wochen-Hoch-Regel exakt
null Mal, 2024+ null Treffer bei 19 Signalen) — als Bestätigungs-Signal
brauchbar, als universelle Regel nicht.

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
