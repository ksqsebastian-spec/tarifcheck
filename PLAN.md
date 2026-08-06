# Tarifcheck — Plan

Tarifvertrags-Dashboard auf Cloudflare mit OAuth-MCP für Claude.

---

## 1. Kontext

Heute läuft die Tarifvertrags-Überwachung als `tarif-sync.sh` auf einem Rechner, der
durchlaufen muss. Das Skript lädt PDFs, erkennt Änderungen per SHA-256 und schreibt ein
`AENDERUNGEN.md`. Nachteile: es braucht eine laufende Maschine, die Ergebnisse liegen als
PDF in einem Ordner, und niemand kann Claude fragen „was ist neu bei den Tischlern".

Ziel ist ein Dienst, der

1. alle Tarifquellen der Gruppenwerk-Gewerke **automatisch aktuell hält**,
2. jedes Dokument zusätzlich als **Markdown** vorhält,
3. diesen Bestand über einen **OAuth-MCP** an Claude anbindet, sodass
   „hey, was ist neu bei Tischlern, nutz den MCP" direkt funktioniert,
4. ein **Dashboard** bietet, auf dem man den Stand sieht und Dokumente
   **manuell hoch- und runterladen** kann.

Der letzte Punkt ist kein Komfort-Feature, sondern trägt den Kern des Problems:
**Tischlerhandwerk hat keine öffentliche Volltextquelle.** Es gibt keine
Allgemeinverbindlicherklärung, die Verträge liegen im Mitgliederbereich von Tischler Nord.
Gleiches gilt für den Lohn-TV Gerüstbau. Für diese Gewerke kann das System nur die
Downloadseite auf Änderungen überwachen und dann sagen: „hier musst du ran". Der manuelle
Upload ist der Weg, wie das Dokument trotzdem in den Bestand und damit in den MCP kommt.

---

## 2. Architektur

Ein einziger Worker, `assets` für das Dashboard, alles andere über Bindings.

```
                         ┌──────────────── Cron (06:15 UTC) ────────────────┐
                         │  fan-out: 1 Self-Request pro Quelle              │
                         ▼                                                  │
  Quelle (zoll.de, soka-bau, …) ──fetch──▶ Worker ──stream──▶ R2  raw/…pdf  │
                                             │                              │
                                             ├─ env.AI.toMarkdown() ──▶ R2  md/…md
                                             └─ D1: documents, versions, events
                                                                            │
  Browser ──Cloudflare Access──▶ /  Dashboard (Assets + JSON-API)           │
  Claude  ──OAuth (DCR)────────▶ /mcp  MCP-Server ──liest──▶ D1 + R2 ───────┘
```

**Warum ein Worker und nicht mehrere:** Dashboard, MCP und Sync teilen sich dieselbe
Datenbank, dasselbe R2 und dieselbe Quellenliste. Getrennte Worker würden nur
Service-Bindings und dreifache Deploys erzeugen, ohne etwas zu entkoppeln.

### Bindings

| Binding | Typ | Zweck |
|---|---|---|
| `R2` | R2 Bucket `tarifcheck` | Originaldateien (`raw/`) und Markdown (`md/`) |
| `DB` | D1 `tarifcheck` | Quellen, Dokumente, Versionen, Ereignisse |
| `OAUTH_KV` | KV | Token-/Grant-Store von `workers-oauth-provider` |
| `AI` | Workers AI | `toMarkdown()` für PDF → Markdown |
| `ASSETS` | Static Assets | Dashboard-Frontend |

Bewusst **nicht** verwendet: Queues (nur Paid), Durable Objects (durch den stateless
MCP-Handler nicht nötig), Workflows (Overkill für ~15 Quellen).

---

## 3. Kostenrahmen — läuft auf Workers Free

Nachgeprüft, nicht geschätzt:

| Limit | Free | Bedarf hier |
|---|---|---|
| CPU-Zeit pro Invocation | **10 ms** | die einzige echte Hürde, siehe unten |
| Externe Subrequests / Invocation | 50 | 1–3 pro Quelle bei Fan-out |
| Subrequests an CF-Dienste (R2/D1/KV/AI) | 1.000 | unkritisch |
| Requests / Tag | 100.000 | ~50 |
| Cron Triggers / Account | 5 | 1 |
| R2 Speicher | 10 GB | < 200 MB |
| D1 | 5 GB | < 10 MB |
| Workers AI | 10.000 Neuronen/Tag | nur bei echten Änderungen |

**Die 10 ms CPU sind der ganze Trick.** Drei Regeln halten uns darunter:

1. **Fan-out statt Schleife.** Der Cron-Handler arbeitet die Quellen nicht selbst ab, er
   feuert pro Quelle einen Self-Request auf `/internal/sync/:id`. Jede Quelle bekommt so
   ihr eigenes frisches 10-ms-Budget. Nebeneffekt: eine kaputte Quelle reißt die anderen
   nicht mit, und Retries sind pro Quelle möglich.
2. **Nicht lokal hashen.** Änderungserkennung läuft in zwei Stufen: erst ein bedingter GET
   mit `If-None-Match` / `If-Modified-Since` aus den gespeicherten Header-Werten — ein
   `304` kostet praktisch null CPU. Wo der Server keine Validatoren schickt, wird die Datei
   nach R2 geschrieben und der von R2 zurückgegebene **MD5-etag** mit dem der Vorversion
   verglichen. Kein `crypto.subtle.digest` über mehrere MB im Worker.
3. **Nicht im Sync-Pfad diffen.** Der Cron vermerkt nur *ob* sich etwas geändert hat. Der
   eigentliche Markdown-Diff wird erst berechnet, wenn ihn jemand anfragt (Dashboard oder
   MCP-Tool), und dann in D1 zwischengespeichert.

Der Download selbst ist `R2.put(key, response.body)` — reines I/O-Durchreichen, kaum CPU.
`toMarkdown()` ist ein Binding-Aufruf, die Arbeit passiert außerhalb unseres CPU-Budgets.

**Falls es doch reißt:** `limits.cpu_ms` in `wrangler.jsonc` hochsetzen. Das setzt Workers
Paid (5 $/Monat) voraus — ist aber eine Zeile, kein Umbau. Ich lege die Zeile
auskommentiert mit ins Repo.

Ein Restrisiko bleibt ehrlich benannt: die Neuronen-Kosten von `toMarkdown()` für PDFs sind
in der Preisliste nicht separat ausgewiesen (AI-Modelle kommen dort nur für
Bildbeschreibungen zum Einsatz). Bei ~14 Dokumenten, die sich selten ändern, erwarte ich
das unkritisch — den Zähler im AI-Dashboard sollte man in der ersten Woche trotzdem
anschauen.

---

## 4. Datenmodell (D1)

```sql
-- Quellen: gepflegte Liste, seed aus data/tarif-quellen.tsv
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,      -- "BAU/BRTV"
  gewerk        TEXT NOT NULL,         -- BAU | GERUESTBAU | MALER | TISCHLER | UEBERGREIFEND
  firmen        TEXT NOT NULL,
  kuerzel       TEXT NOT NULL,
  typ           TEXT NOT NULL,         -- 'pdf' | 'watch'
  url           TEXT NOT NULL,
  dateiname     TEXT NOT NULL,
  aktiv         INTEGER NOT NULL DEFAULT 1,
  hinweis       TEXT                   -- z.B. "nur Mitgliederbereich"
);

-- Ein Dokument = eine Quelle ODER ein manueller Upload
CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES sources(id),   -- NULL bei manuellem Upload
  gewerk        TEXT NOT NULL,
  titel         TEXT NOT NULL,
  herkunft      TEXT NOT NULL,         -- 'auto' | 'manuell'
  gueltig_ab    TEXT,                  -- manuell pflegbar, siehe §7
  current_version_id TEXT,
  letzte_pruefung    TEXT,
  letzter_status     TEXT,             -- 'ok' | 'unveraendert' | 'fehler'
  letzter_fehler     TEXT
);

CREATE TABLE versions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id),
  erfasst_am    TEXT NOT NULL,
  r2_raw_key    TEXT NOT NULL,         -- raw/<gewerk>/<doc>/<ts>.pdf
  r2_md_key     TEXT,                  -- md/<gewerk>/<doc>/<ts>.md
  bytes         INTEGER,
  etag          TEXT,                  -- R2-MD5, Basis des Vergleichs
  http_etag     TEXT,                  -- vom Ursprungsserver
  http_last_modified TEXT,
  hochgeladen_von TEXT                 -- E-Mail bei manuellem Upload
);

-- Changelog. Speist Dashboard und das MCP-Tool "was ist neu"
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  zeitpunkt     TEXT NOT NULL,
  gewerk        TEXT,
  document_id   TEXT,
  art           TEXT NOT NULL,         -- 'neu' | 'geaendert' | 'seite_geaendert'
                                       -- | 'fehler' | 'upload' | 'geloescht'
  beschreibung  TEXT NOT NULL
);
```

Alte Fassungen werden nie gelöscht — `versions` ist die Entsprechung zum `archiv/`-Ordner
des Shell-Skripts, und das war beim bisherigen Ablauf die wertvollste Eigenschaft.

---

## 5. Der Sync

### `pdf`-Quellen
1. Bedingter GET mit gespeichertem `ETag`/`Last-Modified`. Bei `304` → `unveraendert`,
   fertig.
2. Sonst Body direkt nach `R2.put()` streamen, Ziel `raw/<gewerk>/<doc>/<ts>.pdf`.
3. Den von R2 gelieferten MD5-etag mit dem der letzten Version vergleichen. Gleich →
   Objekt wieder löschen, `unveraendert`.
4. Unterschiedlich → `env.AI.toMarkdown()`, Markdown nach `md/…`, neue `versions`-Zeile,
   `documents.current_version_id` umbiegen, `events`-Eintrag `geaendert` (bzw. `neu`).

### `watch`-Quellen
Für Tischler Nord, Gerüstbau-Bundesinnung und die Malerkasse-Tarifseite:
HTML holen → `toMarkdown()` mit `conversionOptions.html.cssSelector` auf den Inhaltsbereich,
damit Navigation und Cookie-Banner den Vergleich nicht ständig verfälschen. Der
Markdown-Text ist die Vergleichsbasis, nicht das rohe HTML — genau das behebt die
Fehlalarme, die im bisherigen README unter „Wichtig" stehen.

Zusätzlich werden PDF-Links aus der Seite extrahiert. Taucht ein neuer auf, wird er als
Dokument-Kandidat vorgeschlagen. Bei Tischler Nord wird das hinter dem Login ins Leere
laufen — die Seitenänderung selbst ist dort das Signal, und der Event heißt entsprechend
`seite_geaendert` mit dem Hinweis „Volltext nur im Mitgliederbereich, bitte manuell
hochladen".

### Fehlerbehandlung
Fehler brechen nichts ab, sie landen in `documents.letzter_fehler` und als `events`-Zeile.
Das Dashboard zeigt sie oben. Wenn eine deutsche Behördenseite Cloudflare-IPs abweist
(bei `zoll.de`/`bmas.de` nicht auszuschließen), sieht man das dort sofort, statt es in
einem Logfile zu verpassen. Realistischer Fallback in dem Fall: die Quelle auf `watch`
stellen und das PDF manuell hochladen.

---

## 6. Dashboard

Statisches Frontend (`ASSETS`) plus JSON-API im Worker. Kein Framework-Aufbau nötig —
eine Seite, deutschsprachig:

- **Statusübersicht** pro Gewerk: grün (aktuell), gelb (Seite geändert, Handlungsbedarf),
  rot (Abruf fehlgeschlagen). Datum der letzten Prüfung.
- **Dokumentliste** mit Download als PDF *und* als Markdown, plus Versionshistorie.
- **Changelog** aus `events`, das Gegenstück zu `AENDERUNGEN.md`.
- **Upload**: Datei + Gewerk + Titel + Gültigkeitsdatum. Läuft durch dieselbe
  `toMarkdown()`-Pipeline, landet also als vollwertige Version im selben Bestand und ist
  damit sofort über den MCP sichtbar. Das ist der Weg für Tischler und Lohn-TV Gerüstbau.
- **Quellenpflege**: URL einer Quelle korrigieren, wenn ein Betreiber seine Seite umbaut.

API-Routen: `GET /api/uebersicht`, `GET /api/dokumente`, `GET /api/dokumente/:id`,
`GET /api/events`, `POST /api/upload`, `PATCH /api/quellen/:id`,
`POST /api/sync` (manueller Anstoß).

---

## 7. MCP-Server

`createMcpHandler()` aus `agents/mcp/server` — die aktuell empfohlene, zustandslose
Variante mit Streamable HTTP. Zustandslos heißt: keine Durable Objects, was uns im
Free-Plan hält.

### Tools

| Tool | Zweck |
|---|---|
| `gewerke_auflisten` | Gewerke mit Dokumentzahl und Aktualitätsstand |
| `dokumente_auflisten` | Dokumente, filterbar nach Gewerk |
| `dokument_lesen` | Volltext-Markdown einer Version (Standard: aktuell) |
| `was_ist_neu` | Änderungen seit Datum X, optional pro Gewerk — **das Tool für die Beispielfrage** |
| `aenderung_anzeigen` | Diff zwischen zwei Versionen, lazy berechnet |
| `tarife_durchsuchen` | Volltextsuche über alle Markdown-Dokumente |

`tarife_durchsuchen` läuft über **D1 FTS5** — eine `documents_fts`-Tabelle, die beim
Speichern einer Version mitgeschrieben wird. Kein Vectorize, keine Embeddings: die Fragen
hier sind „was steht zum Urlaubsgeld drin", also Stichwortsuche in einem überschaubaren
Korpus. Semantische Suche wäre teurer und in der Sache schlechter.

Zusätzlich MCP-**Resources** pro Dokument (`tarif://<gewerk>/<kuerzel>`), damit Claude
Dokumente auch ohne Tool-Aufruf anheften kann.

### Wichtig für die Antwortqualität
Jedes Tool liefert Metadaten mit: Quelle, Abrufdatum, Gültigkeitsdatum und ob es sich um
eine amtliche Fassung oder einen manuellen Upload handelt. Bei Tischler-Dokumenten kommt
der Hinweis mit, dass keine Allgemeinverbindlicherklärung existiert. Das README warnt
zurecht, dass etwa beim Maler-Rahmentarifvertrag ältere Fassungen kursieren — Claude soll
das Gültigkeitsdatum mitnennen können, statt eine Zahl ohne Stand zu behaupten.

### OAuth
`workers-oauth-provider` als eigener Autorisierungsserver, mit Cloudflare Access als
vorgelagertem Login:

```
Claude ──DCR /register──▶ Worker (workers-oauth-provider)
Claude ──/authorize─────▶ Worker ──OIDC──▶ Cloudflare Access ──▶ Login (E-Mail-Code / SSO)
Claude ◀──eigenes Token── Worker
```

Der Worker muss ein eigenes Token ausstellen — Access für SaaS kennt keine Dynamic Client
Registration, Claude braucht sie aber. `workers-oauth-provider` löst genau das: es macht
DCR nach außen und spricht nach innen OIDC mit Access.

Nötige Secrets (Access-for-SaaS-App, OIDC, Redirect auf `/callback`):
`ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_AUTHORIZATION_URL`,
`ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL`, `COOKIE_ENCRYPTION_KEY`.

Die Access-Policy (z.B. „E-Mail endet auf `@gruppenwerk.de`") gilt damit für Dashboard und
MCP gleichermaßen, an einer Stelle gepflegt. Zero Trust ist bis 50 Nutzer kostenlos.

Anbindung in Claude: Einstellungen → Connectors → eigener Connector,
URL `https://<worker>/mcp`. Beim ersten Aufruf öffnet sich der Access-Login.

---

## 8. Dateien

```
tarifcheck/
├─ wrangler.jsonc              Bindings, Cron "15 6 * * *", assets
├─ package.json
├─ SETUP.md                    Befehle: R2/D1/KV anlegen, Access-App, Secrets, Deploy
├─ data/tarif-quellen.tsv      Quellenliste (bereits im Repo)
├─ migrations/0001_init.sql    Schema + FTS5
├─ scripts/seed-sources.ts     TSV → D1
├─ src/
│  ├─ index.ts                 fetch + scheduled, Routing
│  ├─ auth/access.ts           OIDC-Handler gegen Cloudflare Access
│  ├─ auth/provider.ts         OAuthProvider-Konfiguration
│  ├─ sync/cron.ts             Fan-out
│  ├─ sync/source.ts           eine Quelle abarbeiten (pdf | watch)
│  ├─ sync/markdown.ts         toMarkdown-Aufrufe
│  ├─ lib/{db,storage,diff}.ts
│  ├─ api/{uebersicht,dokumente,upload,quellen}.ts
│  └─ mcp/{server,tools,resources}.ts
└─ public/                     Dashboard (index.html, app.js, style.css)
```

---

## 9. Reihenfolge

1. Gerüst: `wrangler.jsonc`, Migration, Seed aus dem TSV. Prüfbar mit `wrangler d1 execute`.
2. Sync für `pdf`-Quellen inkl. Fan-out und R2/D1-Schreiben.
3. `toMarkdown` anschließen, Markdown nach R2, FTS5 füllen.
4. `watch`-Quellen mit CSS-Selektor-Vergleich.
5. Dashboard: Übersicht, Download, Changelog.
6. Upload-Pfad (Tischler-Lücke geschlossen).
7. Cloudflare Access + `workers-oauth-provider`.
8. MCP-Tools und -Resources.
9. `SETUP.md` schreiben.

Nach Schritt 3 ist der Kernnutzen da, nach Schritt 8 die Beispielfrage beantwortbar.

---

## 10. Wie geprüft wird

- **Lokal:** `wrangler dev` mit lokalem D1/R2. `curl` auf `/internal/sync/BAU%2FBRTV`,
  dann `wrangler d1 execute --local --command "select * from versions"` — es muss genau
  eine Version entstehen. Zweiter Aufruf muss `unveraendert` liefern, nicht eine zweite
  Version. Das ist der Test, der die ganze Änderungserkennung trägt.
- **Markdown:** `wrangler r2 object get` auf den `md/`-Key, sichtprüfen, ob der BRTV-Text
  lesbar konvertiert ist. PDF-Layout-Konvertierung ist die Stelle, an der es real schiefgehen
  kann, und das sieht man nur, wenn man draufschaut.
- **CPU:** nach dem ersten echten Cron-Lauf die CPU-Zeit pro Invocation in den
  Worker-Metriken prüfen. Liegt sie nahe 10 ms, greift der `cpu_ms`-Schalter aus §3.
- **Upload:** eine Beispiel-PDF über das Dashboard hochladen, danach muss sie über
  `dokumente_auflisten` im MCP auftauchen.
- **MCP:** `npx @modelcontextprotocol/inspector` gegen `/mcp`, OAuth-Flow durchlaufen,
  jedes Tool einmal aufrufen.
- **Abnahme:** Connector in Claude einrichten und „was ist neu bei Tischlern, nutz den
  MCP" fragen. Die Antwort muss Gültigkeitsdatum und Quelle nennen.

---

## 11. Was das System nicht leisten kann

Kein Softwareproblem, sondern Rechtslage — steht hier, damit es nicht später als Bug
gemeldet wird:

- **Tischler:** keine Allgemeinverbindlicherklärung, kein öffentlicher Volltext.
  Automatisch geht nur die Überwachung der Downloadseite; der Volltext kommt per Upload
  rein. Dasselbe beim **Lohn-TV Gerüstbau** (Mitgliederbereich der Bundesinnung).
- **Layout-Umbauten** bei den Betreibern können Links brechen. Das System meldet den
  Fehler sichtbar im Dashboard, reparieren muss man die URL von Hand — dafür gibt es die
  Quellenpflege.
- **Gültigkeitsdaten** liest niemand automatisch verlässlich aus dem PDF. Das Feld ist
  pflegbar, und der MCP gibt aus, was gepflegt ist. Lieber ein leeres Feld als eine
  falsche Zahl.
