// Breites Symbol-Universum NUR für die historische Squeeze-Erkennung
// (research/analysis/squeezeDetector.js) — bewusst getrennt von der kleinen
// watchlist.js, die täglich neu abgefragt wird. Diese Liste wird einmalig
// (oder gelegentlich) über mehrere Jahre zurück befüllt (siehe
// `node research/cli.js universe:backfill`) und dann nach Squeeze-Mustern
// durchsucht (`node research/cli.js knowledge:scan`).
//
// Zusammengestellt aus historisch volatilen/short-squeeze-anfälligen
// Small-Caps über mehrere Sektoren (Meme/Retail, Krypto-Mining, EV,
// Space/Quantum-Hype, Biotech, Cannabis, Shipping) und einzeln gegen Yahoo
// Finance verifiziert (Stand: Backfill-Zeitpunkt) — Ticker ohne Kursdaten
// wurden vorab aussortiert (u.a. EXPR, NAKD, WISH, PROG, ZOM, MMAT, DWAC,
// RIDE, NKLA, MULN, FSR — inzwischen delistet/nicht mehr über Yahoo abrufbar).
module.exports = [
  // Meme / Retail
  'BB', 'NOK', 'SNDL', 'TLRY', 'CTRM', 'TOPS', 'SHIP', 'GLBS', 'VXRT', 'INO',
  'OCGN', 'SENS', 'BNGO', 'PHUN', 'BKKT', 'XELA', 'GREE', 'BBIG', 'GFAI', 'AEMD',
  'ENVB', 'FAMI', 'SNOA', 'BTAI', 'INDO',
  // Krypto-Mining
  'RIOT', 'MARA', 'SOS', 'CAN', 'EBON', 'BTBT', 'CLSK', 'HUT', 'CIFR', 'WULF',
  'HIVE', 'MIGI',
  // EV / Clean Transport
  'WKHS', 'HYLN', 'QS', 'STEM', 'CHPT', 'BLNK', 'EVGO', 'LIDR', 'OUST', 'MVIS',
  // Space / Quantum / AI-Hype
  'SPCE', 'ASTS', 'RDW', 'PL', 'BKSY', 'IONQ', 'RGTI', 'QUBT', 'BBAI', 'SOUN',
  'LAZR', 'INVZ',
  // Biotech / Pharma Small Float
  'IBIO', 'CYTK', 'ATOS', 'AVXL', 'PHIO', 'TNXP', 'BCTX', 'SLGL',
  // Cannabis
  'CGC', 'ACB', 'OGI', 'CRON',
  // Shipping
  'SBLK', 'EGLE',
  // Sonstige volatile Small Caps
  'FCEL', 'PLUG', 'TTOO', 'GSAT',
];
