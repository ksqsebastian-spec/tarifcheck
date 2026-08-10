# Stand

Letzte Aktualisierung: 10.08.2026. Diese Datei sagt, was läuft, was offen ist und was man
wissen muss, bevor man etwas anfasst. Für die Einrichtung siehe SETUP.md, für die Tabellen
DATENMODELL.md.

## Läuft

Die Seite steht unter https://tarifcheck.ksqsebastian.workers.dev und ist fertig.

- **17 Quellen, 17 durchsuchbar, 0 Fehler.**
- **Täglicher Abruf** um 06:15 UTC (Sommer 08:15 deutscher Zeit). Läuft seit dem
  07.08. selbstständig durch.
- **MCP** unter `/mcp`, OAuth mit Dynamic Client Registration, sechs Werkzeuge, nur lesend.
- **Veröffentlichen über GitHub Actions.** Das Secret `CLOUDFLARE_API_TOKEN` liegt seit dem
  10.08. im Repository; der Workflow ist einmal vollständig durchgelaufen (Typen,
  Migrationen, Deploy, Gesundheits-Check). Von Hand mit `npm run deploy` geht weiterhin.
- **Anmeldung** mit Benutzername und Passwort; Lesen geht ohne, Schreiben nicht.
  Fehlversuche bremst ein Durable Object.
- **Wöchentliche Pflegeroutine**, montags 07:41 UTC. Prüft, ob die Quellen-Links noch
  stimmen, sucht bei Bedarf die neue Adresse bei der herausgebenden Stelle und trägt sie
  ein. Bericht per Push und E-Mail. Sie hängt nur noch am Connector „Cloudflare Developer
  Platform"; der Voll-Connector „Cloudflare" ist entfernt (10.08.2026).

## Offen

Nichts davon hält das System auf. Es läuft auch, wenn nichts davon passiert.

| Was | Wer | Warum |
|---|---|---|
| Passwort ändern | Kontoinhaber | Das aktuelle stand im Chatverlauf. SETUP.md §3. |
| Tischler und Lohn-TV Gerüstbau hochladen | Kontoinhaber | Liegen nur im Mitgliederbereich, es gibt keine öffentliche Quelle. Bis dahin ist für diese beiden nur eine Downloadseite überwacht, kein Vertragstext. |

## Was man wissen muss, bevor man etwas anfasst

**Die Datenbank hat Riegel.** Seit `migrations/0005_riegel.sql` erzwingen zwölf Trigger,
was vorher nur in der API stand: Quellenadressen müssen `https://` sein, Gewerke müssen aus
der bekannten Liste kommen, `gueltig_ab` muss `JJJJ-MM-TT` sein, und Fassungen wie Quellen
lassen sich nicht löschen. Wer eine Datenbankausnahme mit `SQLITE_CONSTRAINT_TRIGGER`
sieht, hat gegen eine dieser Regeln verstoßen — die Meldung sagt im Klartext, gegen welche.
Die Liste steht in DATENMODELL.md §7.

**Diese Migration ist bereits angewendet** und in `d1_migrations` eingetragen. Nicht erneut
anwenden.

**Der Rollout täuscht.** Nach einem Deploy antworten für ein bis zwei Minuten noch alte
Fassungen. Wer direkt danach von Hand testet, prüft womöglich den Vorgängerstand — das hat
hier mehrfach zu falschen Schlüssen geführt. `/api/gesundheit` nennt darum unter `fassung`
die Kennung der Fassung, die gerade antwortet; so lange pollen, bis die neue erscheint. Der
Deploy-Workflow tut genau das inzwischen selbst und wird erst dann grün.

**Der MCP ist nur lesend.** Geschrieben wird ausschließlich über die Seite hinter der
Anmeldung, oder von der Pflegeroutine direkt in D1.

**Ein Wartungsschlüssel ist vorbereitet, aber nicht in Gebrauch.** `PFLEGE_SCHLUESSEL` wäre
der schmalere Weg für die Routine (darf nur `PATCH /api/quellen/:id`). Solange das Secret
nicht gesetzt ist, ist der Code wirkungslos — nicht offen. SETUP.md §3.

## Wenn etwas kaputt ist

```bash
curl https://tarifcheck.ksqsebastian.workers.dev/api/gesundheit
```

Meldet `selbstbindung`, `bremse`, wann zuletzt wirklich geprüft wurde und ob der Lauf
überfällig ist. Steht dort `lauf_ueberfaellig: true`, hat der tägliche Abruf seit über
zwei Tagen nichts mehr getan — dann zuerst `wrangler tail` ansehen.

Einzelne Quelle mit gebrochenem Link: auf der Seite unter „Quellen" die Adresse
korrigieren. Für dauerhaft zusätzlich in `data/tarif-quellen.tsv` nachziehen, sonst
überschreibt das nächste `npm run seed` die Korrektur.
