# Einrichten

**Die Seite läuft bereits:** <https://tarifcheck.ksqsebastian.workers.dev>

Wer nicht angemeldet ist, sieht die Seite im **Lesemodus**: ein Hinweis oben, schreibende
Knöpfe werden gar nicht erst gezeigt. Der tägliche Abruf um 06:15 UTC läuft unabhängig
von jeder Anmeldung.

Alle 17 Verträge sind abgerufen und durchsuchbar, der tägliche Lauf ist auf 06:15 UTC
gestellt. Was noch fehlt, ist die Anmeldung — Schritte 3 und 5. **Bis dahin sind alle
schreibenden Zugriffe gesperrt** (Hochladen, Quellen ändern, Prüfung anstoßen); Lesen ist
offen.

Kosten: **Workers Paid, 5 $/Monat** fürs ganze Konto. Nötig, weil der Text mit pdf.js
gewonnen wird — die Begründung steht in `PLAN.md`, Abschnitt 4. Alles Übrige (R2, D1, KV,
Durable Objects, Workers AI) liegt im kostenlosen Rahmen.

**Zugangsdaten:** Benutzer `gwerkler`. Das beim Einrichten gewählte Passwort stand in einem
Chatverlauf — es sollte gewechselt werden, siehe Abschnitt 3.

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

## 3. Anmeldung

Die Seite hat eine eigene Anmeldung — kein Cloudflare Access, kein externer Anbieter.
Ein gemeinsames Konto für alle, die hochladen oder Quellen pflegen. Lesen geht ohne.

Bereits eingerichtet: Benutzer **gwerkler**. Das Passwort liegt als PBKDF2-Hash in den
Secrets, nie im Klartext.

**Passwort ändern:**

```bash
node -e "
const c=require('crypto'), p=process.argv[1];
const s=c.randomBytes(16), h=c.pbkdf2Sync(p,s,100000,32,'sha256');
console.log('pbkdf2\$100000\$'+s.toString('base64url')+'\$'+h.toString('base64url'));
" 'NEUES-PASSWORT' | npx wrangler secret put LOGIN_HASH
```

Die 100.000 Runden sind die Obergrenze der Web-Crypto-Umsetzung in Workers — mehr lehnt
sie mit *„iteration counts above 100000 are not supported"* ab.

**Benutzername ändern:** `npx wrangler secret put LOGIN_BENUTZER`

**Alle abmelden** (etwa nach einem Passwortwechsel): `npx wrangler secret put SITZUNGS_SCHLUESSEL`
mit einem neuen Zufallswert — damit werden alle bestehenden Sitzungen ungültig.

```bash
openssl rand -hex 32 | npx wrangler secret put SITZUNGS_SCHLUESSEL
```

### Schutz gegen Durchprobieren

Zehn Fehlversuche je Herkunftsadresse in 15 Minuten, danach 429. Gezählt werden nur
Fehlversuche; eine erfolgreiche Anmeldung setzt den Zähler zurück, damit sich niemand am
eigenen Limit aussperrt.

Bewusst **kein** kontoweites Limit: das klingt gründlicher, öffnet aber eine Tür — wer
genug Fehlversuche schickt, sperrte damit die Kollegen aus. Gegen verteiltes Raten
schützt hier die Länge des Passworts, nicht die Bremse.

### Wartungsschlüssel — vorhanden, aber derzeit nicht in Gebrauch

Die wöchentliche Pflegeroutine schreibt zurzeit **nicht** über die API, sondern direkt in
die D1-Datenbank (siehe „Wöchentliche Quellenpflege" unter Betrieb). Der Wartungsschlüssel
ist der schmalere Weg dorthin und liegt bereit, falls man die Routine später enger führen
will:

```bash
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put PFLEGE_SCHLUESSEL
```

Er wird als `Authorization: Bearer …` mitgeschickt und darf **genau eine** Sache:
`PATCH /api/quellen/:id`, also eine Quellenadresse korrigieren. Hochladen, Löschen und das
Ändern von Dokumenten bleiben der Anmeldung vorbehalten. Das ist Absicht — der Schlüssel
steht im Text der Routine und ist damit schlechter geschützt als ein Passwort im Kopf eines
Menschen, also darf er auch weniger. Wer ihn erbeutet, kann schlimmstenfalls einen Link
verbiegen; das fällt beim nächsten Lauf auf und ist rückgängig zu machen.

Ist das Secret nicht gesetzt — der heutige Stand — greift das Tor nicht und der Aufruf
endet mit 401. Der Code ist damit wirkungslos, nicht offen.

Zum Umstellen: Secret setzen, deployen, im Routine-Text Schritt 5 von `d1_database_query`
auf den PATCH umschreiben und den Connector „Cloudflare Developer Platform" aus der Routine
entfernen.

## 4. Veröffentlichen

Im Normalfall gar nicht von Hand: `.github/workflows/deploy.yml` rollt bei jedem Push auf
den Arbeitsbranch aus — Typen prüfen, Migrationen anwenden, veröffentlichen, und
anschließend nachsehen, ob die Seite auch wirklich antwortet. Schlägt die Typprüfung fehl,
wird nicht ausgerollt; der Worker läuft dann mit der letzten heilen Fassung weiter.

**Einmal einzurichten:** ein Cloudflare-Token erzeugen und als Repository-Secret
hinterlegen.

1. dash.cloudflare.com → Profil → **API Tokens** → *Create Custom Token*.
   **Kein TTL setzen** — ein ablaufendes Token bringt die Veröffentlichung genau dann zum
   Stehen, wenn man sie braucht. Berechtigungen:

   | Bereich | Recht |
   |---|---|
   | Account · Workers Scripts | Edit |
   | Account · Workers KV Storage | Edit |
   | Account · Workers R2 Storage | Edit |
   | Account · D1 | Edit |
   | Account · Workers AI | Edit |
   | User · User Details | Read |
   | User · Memberships | Read |

   Account Resources: *Include* → das eigene Konto.

2. github.com/ksqsebastian-spec/tarifcheck → Settings → Secrets and variables → Actions →
   *New repository secret*, Name `CLOUDFLARE_API_TOKEN`, Wert einfügen.

Danach genügt ein Push. Unter *Actions* steht, ob es geklappt hat.

**Von Hand**, falls nötig:

```bash
npm run deploy
```

## 5. Prüfen, ob es läuft

```bash
curl https://tarifcheck.ksqsebastian.workers.dev/api/gesundheit
```

Die Antwort prüft mehr, als ob der Worker antwortet:

| Feld | Bedeutung |
|---|---|
| `fassung` | Kennung der Fassung, die gerade antwortet. Nach einem Deploy steht hier ein bis zwei Minuten noch die vorige — daran erkennt man, ob man schon den neuen Stand prüft. |
| `selbstbindung` | Erreicht der tägliche Lauf seine Arbeitsschritte? Ist das kaputt, tut der Cron stillschweigend nichts. |
| `bremse` | Sperrt die Anmeldebremse wirklich? Sie ist zweimal wirkungslos gewesen, ohne dass man es sah. Das Ergebnis wird zehn Minuten gemerkt — der Test selbst schreibt, und dieser Pfad ist öffentlich. |
| `zuletzt_geprueft` | Wann zuletzt wirklich abgerufen wurde |
| `lauf_ueberfaellig` | `true`, wenn seit über 36 Stunden nichts lief |
| `durchsuchbar` | Wie viele der Dokumente Volltext haben |

## 6. In Claude einbinden

**Einstellungen → Connectors → Connector hinzufügen**, URL:

```
https://tarifcheck.ksqsebastian.workers.dev/mcp
```

Beim ersten Aufruf öffnet sich eine Anmeldemaske mit derselben Benutzer/Passwort-Kombination
wie die Seite, danach die Frage „Zugriff auf Tarifcheck erlauben?". Danach funktioniert:

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

### Wöchentliche Quellenpflege

Der tägliche Cron lädt jede Quelle und vergleicht sie byteweise. Zwei Dinge kann er
naturgemäß nicht, weil sie Urteilsvermögen brauchen:

1. Ein Herausgeber baut seine Seite um — der Link geht ins Leere. Der Cron meldet den
   Fehler, aber die neue Adresse findet er nicht.
2. Ein Herausgeber legt eine neue Fassung unter einem neuen Dateinamen ab und lässt die
   alte liegen. Byteweise ändert sich nichts, der Cron ist zufrieden — und lädt von da an
   dauerhaft ein veraltetes Dokument. Der gefährlichere der beiden Fälle, weil er still
   ist.

Dafür läuft eine Claude-Routine, montags 07:41 UTC (Sommer 09:41 deutscher Zeit), also
gut eine Stunde nach dem täglichen Lauf. Sie prüft jede Adresse, sucht bei Bedarf die
richtige neue — **ausschließlich** bei der herausgebenden Stelle, nie bei einem Portal oder
Verlag — und trägt sie ein. Das Ergebnis kommt per Push und E-Mail. Findet sie keine
Adresse bei der herausgebenden Stelle, ändert sie nichts und meldet es lieber.

Geschrieben wird über den Connector „Cloudflare Developer Platform" direkt in D1:
`UPDATE quellen SET url = ? WHERE id = ?`, danach wird `letzter_fehler` geräumt, damit die
Meldung auf der Seite nicht rot stehen bleibt, bis der nächste Cron läuft.

**Das ist die weite Variante.** Der Connector kann auch `d1_database_delete`,
`r2_bucket_delete` und `kv_namespace_delete` — die Routine hält also jede Woche
unbeaufsichtigt mehr Vollmacht, als sie braucht. Der Prompt zieht die Grenze ausdrücklich
(nur `d1_database_query`, nur die dort wörtlich genannten Anweisungen, kein DROP/DELETE/
INSERT/ALTER), aber das ist eine Anweisung und kein Riegel. Wer es enger will, stellt auf
den Wartungsschlüssel um — siehe oben unter Anmeldung.

Verwaltet wird sie unter claude.ai → Routines, Name „TarifCheck — wöchentliche
Quellenpflege".

Der Prompt führt die zulässigen Herausgeber-Domains auf. Nur von diesen darf eine neue
Adresse kommen:

| Domain | wofür |
|---|---|
| api.soka-bau.de, www.soka-bau.de | SOKA-BAU — BRTV, BBTV, VTV, TZA, TZR |
| www.zoll.de | allgemeinverbindliche Fassungen, Mindestarbeitsbedingungen |
| www.gesetze-im-internet.de | Rechtsverordnungen (ArbbV) |
| www.geruestbauhandwerk.de | Bundesinnung Gerüstbau |
| www.malerkasse.de | Sozialkasse des Maler- und Lackiererhandwerks |
| www.tischler-nord.de | Tischler-Innungsverband Nord |
| www.bmas.de | AVE-Verzeichnis des Bundesarbeitsministeriums |

**Kommt eine Quelle auf einer neuen Domain dazu, muss sie hier und im Routine-Prompt
ergänzt werden** — sonst weigert sich die Routine, ausgerechnet diese Quelle zu
reparieren. Die Liste ist bewusst eine Erlaubnisliste und keine Sperrliste: bei einer
Tarifsammlung ist eine Kopie aus zweiter Hand der teurere Fehler.
