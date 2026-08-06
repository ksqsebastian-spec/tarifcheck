# Einrichten

**Die Seite läuft bereits:** <https://tarifcheck.ksqsebastian.workers.dev>

Alle 17 Verträge sind abgerufen und durchsuchbar, der tägliche Lauf ist auf 06:15 UTC
gestellt. Was noch fehlt, ist die Anmeldung — Schritte 3 und 5. **Bis dahin sind alle
schreibenden Zugriffe gesperrt** (Hochladen, Quellen ändern, Prüfung anstoßen); Lesen ist
offen.

Kosten: **Workers Paid, 5 $/Monat** fürs ganze Konto. Nötig, weil der Text mit pdf.js
gewonnen wird — die Begründung steht in `PLAN.md`, Abschnitt 4. Alles Übrige (R2, D1, KV,
Workers AI) liegt im kostenlosen Rahmen.

```bash
npm install
npx wrangler login
```

---

## 1. Speicher, Datenbank, KV

**Datenbank und KV sind bereits angelegt**, die IDs stehen in `wrangler.jsonc`:

| | |
|---|---|
| D1 `tarifcheck` | `c828eed8-fd67-4dfa-a196-6ed3fec8d640` (Region WEUR) |
| KV `tarifcheck-OAUTH_KV` | `58c20a25b82b4b3bace3ba4e0eb95ddf` |

Das Schema liegt schon auf der Datenbank, `npm run migrate` läuft also als No-op durch.

Der R2-Bucket `tarifcheck` ist ebenfalls angelegt. Er wird über den Namen angesprochen,
es ist nichts einzutragen.

## 2. Quellen einspielen

```bash
npm run seed        # data/tarif-quellen.tsv in die Datenbank
```

`seed` ist mehrfach ausführbar. Es zieht geänderte Adressen und Titel nach und lässt
bestehende Fassungen und Meldungen in Ruhe.

## 3. Anmeldung für den MCP vorbereiten (Access für SaaS)

Der MCP-Server stellt eigene Tokens aus, weil Claude sich per Dynamic Client Registration
anmeldet — das kennt Access nicht. Access ist dahinter das Anmeldeverfahren.

1. **Zero Trust → Access controls → Applications → Create new application → SaaS**
2. Name z. B. `Tarifcheck MCP`, Protokoll **OIDC**
3. **Redirect URL**: `https://tarifcheck.<konto>.workers.dev/callback`
4. Notieren: **Client ID**, **Client Secret**, **Authorization endpoint**, **Token endpoint**
5. Unter **Advanced settings** die **Refresh tokens** einschalten — sonst muss man sich in
   Claude alle paar Stunden neu anmelden
6. Policy anlegen, z. B. *Emails ending in* `@gruppenwerk.de`

Dann die Werte als Secrets setzen:

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
```

`COOKIE_ENCRYPTION_KEY` signiert den Zustand, der während der Anmeldung durch den Browser
des Nutzers läuft. Ohne ihn könnte jemand die Anfrage unterwegs umschreiben.

## 4. Veröffentlichen

```bash
npm run deploy
```

**Die Seite ist jetzt offen im Netz.** Schritt 5 gehört direkt hinterher.

## 5. Die Seite schützen (Access, selbst gehostet)

1. **Zero Trust → Access controls → Applications → Create new application → Self-hosted**
2. Domain: `tarifcheck.<konto>.workers.dev`
3. Policy: *Emails ending in* `@gruppenwerk.de`
4. Anmeldeverfahren: **One-time PIN** genügt — Code per Mail, sonst nichts einzurichten

### Schreibende Zugriffe freischalten

Die Seite prüft schreibende Zugriffe selbst, gegen das signierte Token von Access —
nicht bloß gegen die Kopfzeile `cf-access-authenticated-user-email`. Die ließe sich
nämlich einfach mitschicken, solange keine Access-Anwendung davorsteht.

Dafür fehlen zwei Angaben. Beide stehen in der eben angelegten **self-hosted** Anwendung:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # z.B. gruppenwerk.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # "Application Audience (AUD) Tag"
```

Den AUD-Tag findet man in der Anwendung unter **Overview**. Solange die beiden fehlen,
bleibt jeder schreibende Zugriff mit 403 gesperrt — absichtlich: wer die Adresse einer
Quelle ändern kann, bestimmt, was der Dienst morgen früh als Tarifvertrag ablegt.

### Wichtig: Bypass für die MCP-Pfade

Claude ruft die Anmeldepfade auf, **bevor** irgendjemand angemeldet ist. Liegt der
Access-Login davor, kann sich der Connector nie verbinden — die Anmeldung würde sich
selbst blockieren.

Also eine **zweite Access-Anwendung** anlegen, ebenfalls self-hosted, mit einer
**Bypass**-Policy (*Everyone*) und diesen Pfaden:

```
tarifcheck.<konto>.workers.dev/mcp
tarifcheck.<konto>.workers.dev/authorize
tarifcheck.<konto>.workers.dev/callback
tarifcheck.<konto>.workers.dev/token
tarifcheck.<konto>.workers.dev/register
tarifcheck.<konto>.workers.dev/.well-known
```

Pfadgenauere Anwendungen haben Vorrang vor der Anwendung auf der ganzen Domain.

Das ist kein Loch: hinter `/mcp` steht die Token-Prüfung des OAuth-Providers, und
`/authorize` leitet unmittelbar zur Access-Anmeldung weiter. Ungeschützt ist nur der Weg
dorthin.

### Warum der tägliche Abruf trotzdem durchkommt

Er ruft sich über eine Selbstbindung auf, also am Netzwerk und damit auch an Access
vorbei. Zusätzlich verlangt der interne Pfad eine Kopfzeile, die von außen nicht gesetzt
werden kann.

## 6. In Claude einbinden

**Einstellungen → Connectors → Connector hinzufügen**, URL:

```
https://tarifcheck.<konto>.workers.dev/mcp
```

Beim ersten Aufruf öffnet sich die Access-Anmeldung, danach eine Seite „Zugriff auf
Tarifcheck erlauben?". Danach funktioniert:

> was ist neu bei den Tischlern, nutz den MCP

---

## 7. Ausprobieren

```bash
npx wrangler dev
```

Lokal fehlt Workers AI der Zugang — die Textumwandlung schlägt mit
„Binding AI needs to be run remotely" fehl. Das ist erwartbar. Abruf, Speichern und
Änderungserkennung lassen sich trotzdem prüfen. Für einen echten Durchlauf
`npx wrangler dev --remote`.

Einzelne Quelle anstoßen:

```bash
curl -X POST -H "x-tarifcheck-intern: 1" \
  "http://localhost:8787/intern/sync/BAU%2FBRTV"
```

**Der wichtigste Test: zweimal hintereinander aufrufen.** Der erste Aufruf muss `ok`
liefern, der zweite `unveraendert`. Entsteht beim zweiten Mal eine zweite Fassung, ist die
Änderungserkennung kaputt — daran hängt alles andere.

```bash
npx wrangler d1 execute tarifcheck --local \
  --command "SELECT dokument_id, erfasst_am, bytes FROM versionen"
```

Cron lokal auslösen:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

Den MCP ohne Claude prüfen:

```bash
npx @modelcontextprotocol/inspector
```

## 8. Nach dem ersten echten Lauf

- **Rechenzeit** unter Workers → tarifcheck → Metrics. `limits.cpu_ms` steht auf 120.000
  als Obergrenze; verbraucht wird nur, wenn sich ein Vertrag wirklich geändert hat. Der
  BRTV kostet dabei rund 1,3 Sekunden, alle anderen deutlich weniger.
- **KI-Kontingent** unter AI → Workers AI. Wird nur noch für die drei beobachteten
  HTML-Seiten gebraucht, nicht mehr für PDFs. 10.000 Neuronen pro Tag sind frei — das
  reicht um Größenordnungen.

## 9. Betrieb

**Neue Quelle:** Zeile in `data/tarif-quellen.tsv` ergänzen, `npm run seed`.

**Adresse geändert:** auf der Seite unter „Quellen" korrigieren. Für dauerhaft zusätzlich
in der TSV nachziehen, sonst überschreibt das nächste `seed` die Korrektur.

**Dokument hochladen:** auf der Seite unter „Hochladen". Nötig für Tischler und den
Lohn-TV Gerüstbau.

**Cron ändern:** `triggers.crons` in `wrangler.jsonc`. Steht in UTC — `15 6 * * *` ist im
Sommer 08:15 und im Winter 07:15 deutscher Zeit.
