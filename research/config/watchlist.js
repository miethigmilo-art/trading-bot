// Beobachtungsliste für den täglichen Data Collector.
// Symbol hinzufügen/entfernen genügt — der Collector übernimmt den Rest.
// Auswahl: historisch bekannte Short-Squeeze-Kandidaten (hoher Short Float,
// kleiner Float, volatile Kursverläufe) — alle gegen Yahoo Finance verifiziert.
module.exports = [
  'GME',
  'AMC',
  'KOSS',
  'BBBY', // ACHTUNG: seit 2023 Ticker von "Beyond, Inc." (ex-Overstock.com), NICHT der ursprünglichen, insolventen Bed Bath & Beyond Inc. — siehe squeeze_events "BBBY-2022" für den historischen Fall.
  'ATER',
  'CVNA',
  'UPST',
  'BYND',
  'CLOV',
];
