-- Tarifcheck: Grundschema.
-- Tabellen- und Spaltennamen sind bewusst deutsch, weil der MCP im mcpee-Repo
-- direkt auf dieser Datenbank liest. Siehe MCP-CONTRACT.md - Aenderungen hier
-- brechen dort etwas.

-- Gepflegte Quellenliste. Seed kommt aus data/tarif-quellen.tsv.
CREATE TABLE quellen (
  id         TEXT PRIMARY KEY,          -- "BAU/BRTV"
  gewerk     TEXT NOT NULL,             -- BAU | GERUESTBAU | MALER | TISCHLER | UEBERGREIFEND
  firmen     TEXT NOT NULL,
  kuerzel    TEXT NOT NULL,
  typ        TEXT NOT NULL CHECK (typ IN ('pdf', 'watch')),
  url        TEXT NOT NULL,
  dateiname  TEXT NOT NULL,
  aktiv      INTEGER NOT NULL DEFAULT 1,
  hinweis    TEXT
);

-- Ein Dokument ist ein Tarifvertrag: entweder automatisch geholt (quelle_id
-- gesetzt) oder von Hand hochgeladen (quelle_id NULL).
CREATE TABLE dokumente (
  id                  TEXT PRIMARY KEY,
  quelle_id           TEXT REFERENCES quellen(id),
  gewerk              TEXT NOT NULL,
  kuerzel             TEXT NOT NULL,
  titel               TEXT NOT NULL,
  herkunft            TEXT NOT NULL CHECK (herkunft IN ('auto', 'manuell')),
  -- Von Hand pflegbar. Wird nicht aus dem PDF geraten: lieber leer als falsch.
  gueltig_ab          TEXT,
  -- z.B. "Keine Allgemeinverbindlicherklaerung" - der MCP gibt das mit aus.
  hinweis             TEXT,
  aktuelle_version_id TEXT,
  letzte_pruefung     TEXT,
  letzter_status      TEXT CHECK (letzter_status IN ('ok', 'unveraendert', 'fehler')),
  letzter_fehler      TEXT,
  erstellt_am         TEXT NOT NULL
);

CREATE INDEX idx_dokumente_gewerk ON dokumente (gewerk);
CREATE INDEX idx_dokumente_quelle ON dokumente (quelle_id);

-- Jede Fassung bleibt erhalten. Nichts wird ueberschrieben, nichts geloescht.
-- Das ist die Entsprechung zum archiv/-Ordner des alten Shell-Skripts.
CREATE TABLE versionen (
  id                 TEXT PRIMARY KEY,
  dokument_id        TEXT NOT NULL REFERENCES dokumente(id),
  erfasst_am         TEXT NOT NULL,
  r2_raw_key         TEXT,              -- raw/<gewerk>/<dokument_id>/<ts>.<ext>
  r2_md_key          TEXT,              -- md/<gewerk>/<dokument_id>/<ts>.md
  bytes              INTEGER,
  -- Pruefsumme, die R2 beim Schreiben zurueckgibt. Basis des Versionsvergleichs.
  -- Bewusst nicht selbst berechnet, das wuerde das CPU-Budget sprengen.
  etag               TEXT,
  http_etag          TEXT,              -- vom Ursprungsserver, fuer bedingte Abrufe
  http_last_modified TEXT,
  quelle_url         TEXT,
  hochgeladen_von    TEXT               -- Mailadresse, nur bei manuellem Upload
);

CREATE INDEX idx_versionen_dokument ON versionen (dokument_id, erfasst_am DESC);

-- Benachrichtigungen. Die zentrale Ansicht der Seite und zugleich das,
-- was der MCP fuer "was ist neu" ausliest.
CREATE TABLE meldungen (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  zeitpunkt    TEXT NOT NULL,
  gewerk       TEXT,
  dokument_id  TEXT,
  art          TEXT NOT NULL CHECK (art IN (
                 'neu', 'geaendert', 'seite_geaendert',
                 'neuer_link', 'fehler', 'upload'
               )),
  titel        TEXT NOT NULL,
  beschreibung TEXT,
  gelesen      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_meldungen_zeit ON meldungen (zeitpunkt DESC);
CREATE INDEX idx_meldungen_ungelesen ON meldungen (gelesen, zeitpunkt DESC);

-- Volltextindex ueber die umgewandelten Texte. Traegt die Suche im MCP.
-- Stichwortsuche statt Embeddings: der Korpus ist klein und die Fragen sind
-- woertlich ("Urlaubsgeld", "Wegezeit"), da ist FTS treffsicherer und billiger.
CREATE VIRTUAL TABLE dokumente_fts USING fts5(
  dokument_id UNINDEXED,
  gewerk      UNINDEXED,
  titel,
  inhalt,
  tokenize = 'unicode61 remove_diacritics 2'
);
