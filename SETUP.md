# Einrichten

Von null bis laufender Seite mit MCP. Alles läuft im kostenlosen Cloudflare-Tarif.

Voraussetzung: Node 20+ und ein Cloudflare-Konto.

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

**R2 fehlt noch und muss von dir freigeschaltet werden.** Die API lehnt das Anlegen mit
*„Please enable R2 through the Cloudflare Dashboard"* ab — R2 ist einmalig pro Konto zu
aktivieren, und dafür verlangt Cloudflare eine hinterlegte Zahlungsmethode, auch wenn der
kostenlose Rahmen (10 GB) hier bei weitem reicht.

1. Im Dashboard auf **R2 → Get started / Purchase R2** und die Aktivierung bestätigen
2. Dann:

```bash
npx wrangler r2 bucket create tarifcheck
```

Der Bucket wird über den Namen angesprochen, es ist nichts einzutragen.

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

- **Rechenzeit** unter Workers → tarifcheck → Metrics. Der kostenlose Tarif erlaubt 10 ms
  pro Aufruf. Liegt der Wert dicht darunter, in `wrangler.jsonc` die auskommentierte Zeile
  `"limits": { "cpu_ms": 30000 }` aktivieren — das setzt Workers Paid voraus (5 $/Monat).
- **KI-Kontingent** unter AI → Workers AI. 10.000 Neuronen pro Tag sind frei. Umgewandelt
  wird nur, was sich geändert hat.

## 9. Betrieb

**Neue Quelle:** Zeile in `data/tarif-quellen.tsv` ergänzen, `npm run seed`.

**Adresse geändert:** auf der Seite unter „Quellen" korrigieren. Für dauerhaft zusätzlich
in der TSV nachziehen, sonst überschreibt das nächste `seed` die Korrektur.

**Dokument hochladen:** auf der Seite unter „Hochladen". Nötig für Tischler und den
Lohn-TV Gerüstbau.

**Cron ändern:** `triggers.crons` in `wrangler.jsonc`. Steht in UTC — `15 6 * * *` ist im
Sommer 08:15 und im Winter 07:15 deutscher Zeit.
