# Tarifcheck

Hält die Tarifverträge der Gruppenwerk-Gewerke automatisch aktuell, meldet Änderungen auf
einer Seite und legt alles so ab, dass ein MCP-Server es für Claude auslesen kann.

Nachfolger von `tarif-sync.sh` — ohne Rechner, der durchlaufen muss.

| | |
|---|---|
| Was gebaut wird und warum | [`PLAN.md`](PLAN.md) |
| Einrichten und betreiben | [`SETUP.md`](SETUP.md) |
| Schnittstelle für den MCP im `mcpee`-Repo | [`MCP-CONTRACT.md`](MCP-CONTRACT.md) |

## Kurz

Ein Cloudflare Worker holt jeden Morgen die Tarifverträge von den amtlichen Quellen und
den Sozialkassen, erkennt Änderungen, hebt jede Fassung auf und wandelt sie in Text um.
Auf der Seite sieht man den Stand je Gewerk und bekommt Änderungen als Benachrichtigung.
Dokumente ohne öffentliche Quelle lädt man dort von Hand hoch.

Der MCP-Server wird **nicht hier** gebaut, sondern im `mcpee`-Repo. Er hängt sich an
dieselbe Datenbank und denselben Speicher — wie, steht in `MCP-CONTRACT.md`.

## Die Einschränkung, die bleibt

Für das **Tischlerhandwerk** gibt es keine Allgemeinverbindlicherklärung und damit keine
öffentliche Volltextquelle; die Verträge liegen im Mitgliederbereich von Tischler Nord.
Dasselbe gilt für den **Lohn-TV Gerüstbau**. Automatisch überwacht wird dort nur die
Downloadseite — meldet sie eine Änderung, muss das Dokument einmal von Hand hochgeladen
werden. Danach ist es dem Rest gleichgestellt.
