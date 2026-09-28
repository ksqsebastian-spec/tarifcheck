# Tarifcheck

**Läuft:** <https://tarifcheck.ksqsebastian.workers.dev> — aktueller Betrieb und monatliche ChatGPT-Prüfung: [`OPERATIONS.md`](OPERATIONS.md).

Hält die Tarifverträge der Gruppenwerk-Gewerke automatisch aktuell, meldet Änderungen auf
einer Seite und legt alles so ab, dass ein MCP-Server es für Claude auslesen kann.

Nachfolger von `tarif-sync.sh` — ohne Rechner, der durchlaufen muss.

| | |
|---|---|
| Was gebaut wird und warum | [`PLAN.md`](PLAN.md) |
| Einrichten und betreiben | [`SETUP.md`](SETUP.md) |
| Wie die Daten liegen | [`DATENMODELL.md`](DATENMODELL.md) |
| In den MCP-Hub aufnehmen | [`HUB-EINTRAG.md`](HUB-EINTRAG.md) |

## Kurz

Eine monatliche ChatGPT-Cloud-Aufgabe prüft die Herausgeber und startet den Cloudflare-Workflow.
Er lädt die Dateien, erkennt Änderungen, hebt jede Fassung auf und gewinnt mit pdf.js den
Volltext. Überwacht werden 17 Quellen: 14 PDF-Quellen und drei Webseiten.
Auf der Seite sieht man den Stand je Gewerk und bekommt Änderungen als Benachrichtigung.
Dokumente ohne öffentliche Quelle lädt man dort von Hand hoch.

Ein MCP-Server im selben Worker macht den Bestand für Claude nutzbar — angemeldet mit
demselben Benutzer und Passwort wie die Seite. Danach beantwortet Claude Fragen wie
„was ist neu bei den Tischlern" direkt aus den Verträgen, mit Stand und Gültigkeitsdatum
dazu.

## Werkzeuge des MCP

`gewerke_auflisten` · `dokumente_auflisten` · `dokument_lesen` · `was_ist_neu` ·
`tarife_durchsuchen` · `versionen_auflisten`

Jede Antwort führt die Vorbehalte des Dokuments mit — ob eine amtliche Fassung vorliegt,
von wann sie ist, und ob der letzte Abruf überhaupt geklappt hat.

## Die Einschränkung, die bleibt

Für das **Tischlerhandwerk** gibt es keine Allgemeinverbindlicherklärung und damit keine
öffentliche Volltextquelle; die Verträge liegen im Mitgliederbereich von Tischler Nord.
Dasselbe gilt für den **Lohn-TV Gerüstbau**. Automatisch überwacht wird dort nur die
Downloadseite — meldet sie eine Änderung, muss das Dokument einmal von Hand hochgeladen
werden. Danach ist es dem Rest gleichgestellt.
