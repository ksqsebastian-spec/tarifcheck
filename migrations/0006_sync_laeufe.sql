CREATE TABLE IF NOT EXISTS sync_laeufe (
 id TEXT PRIMARY KEY,
 gestartet_am TEXT NOT NULL,
 beendet_am TEXT,
 status TEXT NOT NULL DEFAULT 'laeuft',
 ergebnisse TEXT
);
CREATE TABLE IF NOT EXISTS sync_sperren (
 quelle_id TEXT PRIMARY KEY,
 inhaber TEXT NOT NULL,
 bis INTEGER NOT NULL
);
