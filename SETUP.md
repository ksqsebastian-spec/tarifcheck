# Einrichten

Von null bis laufender Seite. Alles bis auf Schritt 6 läuft im kostenlosen Cloudflare-Tarif.

Voraussetzung: Node 20+ und ein Cloudflare-Konto.

```bash
npm install
npx wrangler login
```

## 1. Speicher und Datenbank anlegen

```bash
npx wrangler r2 bucket create tarifcheck
npx wrangler d1 create tarifcheck
```

`d1 create` gibt eine `database_id` aus. Diese in `wrangler.jsonc` bei
`d1_databases[0].database_id` eintragen — dort steht noch ein Platzhalter.

**Die ID gut aufheben.** Der MCP-Server im `mcpee`-Repo braucht genau dieselbe, siehe
`MCP-CONTRACT.md`.

## 2. Schema anlegen

```bash
npm run migrate          # remote
npm run migrate:local    # fürs lokale Ausprobieren
```

## 3. Quellen einspielen

Liest `data/tarif-quellen.tsv` und schreibt sie in die Datenbank:

```bash
npm run seed
npm run seed:local
```

Der Befehl ist mehrfach ausführbar. Er zieht geänderte Adressen und Titel nach und lässt
bestehende Versionen und Meldungen in Ruhe. Nach dem Anpassen der TSV also einfach
nochmal laufen lassen.

## 4. Veröffentlichen

```bash
npm run deploy
```

Die Seite liegt danach auf `https://tarifcheck.<konto>.workers.dev`.

**Vor Schritt 5 ist sie offen im Netz.** Also gleich weitermachen.

## 5. Anmeldung einrichten (Cloudflare Access)

Ohne diesen Schritt kann jeder die Seite aufrufen und Dateien hochladen.

1. Im Cloudflare-Dashboard auf **Zero Trust → Access controls → Applications**
2. **Create new application → Self-hosted**
3. Als Adresse die Worker-Domain eintragen (`tarifcheck.<konto>.workers.dev`)
4. Policy anlegen, zum Beispiel: *Include → Emails ending in →* `@gruppenwerk.de`
5. Als Anmeldeverfahren genügt **One-time PIN** — dann bekommt man einen Code per Mail
   und braucht nichts weiter einzurichten.

Zero Trust ist bis 50 Nutzer kostenlos.

Danach steht in jeder Anfrage die Mailadresse des Angemeldeten. Die Seite nutzt sie, um
Uploads zuzuordnen — sichtbar in der Meldung „Hochgeladen von …".

### Warum der Cron trotzdem durchkommt

Access schützt die öffentliche Adresse. Der tägliche Abruf ruft sich über eine
Selbstbindung auf, also am Netzwerk und damit auch an Access vorbei. Der interne Weg
verlangt zusätzlich eine Kopfzeile, die von außen nicht gesetzt werden kann.

## 6. Ausprobieren

```bash
npx wrangler dev
```

Lokal fehlt Workers AI der Zugang — die Textumwandlung schlägt dann mit
„Binding AI needs to be run remotely" fehl. Das ist erwartbar und kein Fehler im Code;
Abruf, Speichern und Änderungserkennung lassen sich trotzdem prüfen. Für einen echten
Durchlauf `npx wrangler dev --remote` nehmen.

Einzelne Quelle von Hand anstoßen:

```bash
curl -X POST -H "x-tarifcheck-intern: 1" \
  "http://localhost:8787/intern/sync/BAU%2FBRTV"
```

Der wichtigste Test: **zweimal hintereinander aufrufen.** Der erste Aufruf muss `ok`
liefern, der zweite `unveraendert`. Entsteht beim zweiten Mal eine zweite Version, ist die
Änderungserkennung kaputt — daran hängt alles andere.

```bash
npx wrangler d1 execute tarifcheck --local \
  --command "SELECT dokument_id, erfasst_am, bytes FROM versionen"
```

Den Cron lokal auslösen:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

## 7. Nach dem ersten echten Lauf

Zwei Dinge einmal nachsehen:

- **Rechenzeit** unter Workers → tarifcheck → Metrics. Der kostenlose Tarif erlaubt 10 ms
  pro Aufruf. Liegt der Wert dicht darunter, in `wrangler.jsonc` die auskommentierte Zeile
  `"limits": { "cpu_ms": 30000 }` aktivieren — das setzt Workers Paid voraus (5 $/Monat).
- **KI-Kontingent** unter AI → Workers AI. Der kostenlose Tarif gibt 10.000 Neuronen pro
  Tag. Umgewandelt wird nur, was sich geändert hat, das sollte also weit darunter bleiben.

## 8. Betrieb

**Neue Quelle aufnehmen:** Zeile in `data/tarif-quellen.tsv` ergänzen, `npm run seed`.

**Adresse hat sich geändert:** direkt auf der Seite unter „Quellen" korrigieren. Wer es
dauerhaft haben will, zieht es zusätzlich in der TSV nach — sonst überschreibt das
nächste `seed` die Korrektur wieder.

**Dokument hochladen:** auf der Seite unter „Hochladen". Nötig für Tischler und den
Lohn-TV Gerüstbau, für die es keine öffentliche Quelle gibt.

**Cron ändern:** `triggers.crons` in `wrangler.jsonc`. Steht in UTC, also ist `15 6 * * *`
im Sommer 08:15 deutscher Zeit und im Winter 07:15.
