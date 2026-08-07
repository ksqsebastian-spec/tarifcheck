# Tarifcheck — Plan

Tarifvertrags-Seite auf Cloudflare. Hält die Tarifverträge aller Gruppenwerk-Gewerke
automatisch aktuell, meldet Änderungen auf der Seite und legt alles so ab, dass ein
separater MCP-Server es lesen kann.

Seite und MCP-Server stecken im selben Worker. Wie die Daten liegen, auf denen beide
arbeiten, steht in `DATENMODELL.md`.

---

## 1. Kontext

Heute läuft die Überwachung als `tarif-sync.sh` auf einem Rechner, der durchlaufen muss.
Das Skript lädt PDFs, erkennt Änderungen per Prüfsumme und schreibt ein `AENDERUNGEN.md`.
Es braucht eine laufende Maschine, und niemand kann Claude fragen, was sich getan hat.

Diese Seite ersetzt den Rechner. Sie holt die Verträge selbst, merkt sich jede Fassung,
wandelt sie in Text um und zeigt Änderungen als Benachrichtigung an. Der Textbestand ist
zugleich das, was der MCP später ausliest.

Was die Seite bewusst **nicht** tut: Dokumente zum Herunterladen anbieten. Der Bestand
liegt einfach da und wird über Claude genutzt. Wer das Original-PDF in der Hand braucht,
holt es sich bei der Quelle — die URL steht auf der Seite.

---

## 2. Was die Seite kann

**Übersicht.** Pro Gewerk der aktuelle Stand: grün heißt geprüft und unverändert, gelb
heißt es hat sich etwas getan, rot heißt der Abruf ist fehlgeschlagen.

**Benachrichtigungen.** Die zentrale Ansicht. Jede Änderung, jeder Fehler und jeder Upload
erzeugt einen Eintrag. Ungelesene stehen oben und werden im Reiter mitgezählt, damit man
beim Reinschauen sofort sieht, ob etwas anliegt. Man kann sie einzeln oder alle auf
gelesen setzen. Das ist das Gegenstück zum `AENDERUNGEN.md` von früher.

**Hochladen.** Datei wählen, Gewerk und Titel dazu, fertig. Sie läuft durch dieselbe
Text-Umwandlung wie die automatisch geholten und ist danach für den MCP gleichwertig
sichtbar. Das ist der Weg für Tischler und den Lohn-TV Gerüstbau, für die es keine
öffentliche Quelle gibt.

**Quellen pflegen.** Baut ein Betreiber seine Seite um, geht ein Link ins Leere. Der
Fehler steht dann rot in der Übersicht und die Adresse lässt sich direkt korrigieren.

**Anmeldung** mit Benutzername und Passwort, ein gemeinsames Konto. Kein externer
Anbieter: was der Worker prüft, steht im Worker. Das Passwort liegt als PBKDF2-Hash in den
Secrets, nie im Klartext. Zehn Fehlversuche je Herkunft in 15 Minuten, dann gesperrt.

Der erste Entwurf setzte auf Cloudflare Access. Das hätte einen Teil der Prüfung in eine
Dashboard-Konfiguration verlagert, deren Fehlen man der Seite nicht ansieht — und es
verlangte einen Bypass für die MCP-Pfade, also eine Ausnahme, die stillschweigend zu weit
gefasst sein kann.

---

## 3. Aufbau

Ein Worker. Vorne die Seite, hinten der tägliche Abruf.

```
        ┌──────────── Cron 06:15 ────────────┐
        │  ein Selbstaufruf je Quelle        │
        ▼                                    │
  Quelle ──▶ Worker ──▶ R2  raw/…pdf         │
              │                              │
              ├─ pdf.js ─────────▶ R2 md/…md│
              └─ D1: dokumente, versionen,   │
                     meldungen               │
                                             │
  Browser ─Sitzung─▶ Seite (Assets + JSON)───┘

  Claude ─OAuth─▶ /mcp  ─▶ dieselbe D1 + dasselbe R2
```

Der MCP-Endpunkt liegt im selben Worker, liest aber nur. Claude meldet sich per Dynamic
Client Registration an; der Worker ist sein eigener Autorisierungsserver und fragt dabei
dieselbe Benutzer/Passwort-Kombination ab wie die Seite.

### Bindings dieses Workers

| Binding | Typ | Zweck |
|---|---|---|
| `R2` | R2 Bucket `tarifcheck` | Originaldateien (`raw/`) und Text (`md/`) |
| `DB` | D1 `tarifcheck` | Quellen, Dokumente, Versionen, Meldungen |
| `AI` | Workers AI | Umwandlung der beobachteten HTML-Seiten |
| `ASSETS` | Static Assets | die Seite |
| `OAUTH_KV` | KV | Tokens und Grants des MCP |
| `BREMSE` | Durable Object | zählt Fehlversuche bei der Anmeldung |

Keine Queues. Das eine Durable Object zählt Anmeldeversuche — es ist die einzige stark
konsistente Zählstelle in dieser Umgebung. KV zählte zu spät (eventual consistent), der
`ratelimit`-Binding zählt je Instanz statt je Standort; beide sahen funktionsfähig aus und
ließen jeden Versuch durch.

---

## 4. Kosten — Workers Paid, 5 $/Monat

| Posten | Kosten |
|---|---|
| Workers Paid | 5 $/Monat, gilt fürs ganze Konto |
| R2 (< 200 MB) | im kostenlosen Rahmen (10 GB) |
| D1 (< 10 MB) | im kostenlosen Rahmen |
| KV, Workers AI | im kostenlosen Rahmen |

**Warum nicht kostenlos.** Der Zweck der Seite ist Durchsuchbarkeit, und die steht und
fällt damit, dass aus jedem PDF wirklich Text herauskommt. Die Markdown-Umwandlung von
Workers AI schaffte das bei drei von siebzehn Verträgen nicht — darunter ausgerechnet der
BRTV — und meldete dabei keinen Fehler, sondern lieferte stillschweigend leere Seiten.

Also wird der Text mit pdf.js gewonnen. Das ist verlässlich und liefert bei allen
siebzehn vollständige Texte, kostet aber Rechenzeit: der BRTV braucht rund 1,3 Sekunden,
das 130-fache dessen, was der kostenlose Tarif pro Aufruf erlaubt. Dafür gibt es keinen
Trick — es ist eine Tarif-Frage.

Der Nebeneffekt ist es fast wert: pdf.js läuft lokal. Die Textgewinnung ist damit zum
ersten Mal ohne Cloud prüfbar, was mit der KI-Umwandlung nie ging.

`limits.cpu_ms` steht auf 120.000. Das ist eine Obergrenze, kein Verbrauch — gerechnet
wird nur, wenn sich ein Vertrag wirklich geändert hat, also ein paarmal im Jahr.

## 5. Daten

Schema und Ablage sind in **`DATENMODELL.md`** festgeschrieben. Kurzfassung:

- `quellen` — die gepflegte Liste, kommt aus `data/tarif-quellen.tsv`
- `dokumente` — ein Vertrag, entweder automatisch geholt oder hochgeladen
- `versionen` — jede Fassung bleibt erhalten, nichts wird überschrieben
- `meldungen` — Änderungen, Fehler, Uploads; mit gelesen/ungelesen
- `dokumente_fts` — Volltextindex über den Text, trägt die Suche im MCP

Zu jeder Fassung wird festgehalten, wieviel lesbarer Text herauskam und welche
Datumsangaben wörtlich im Dokument stehen. Letzteres, weil `gueltig_ab` fast immer leer
ist und der Vorbehalt „kein Gültigkeitsdatum" sonst bei jedem Treffer erschiene — ein
Hinweis, der immer dasteht, wird überlesen.

In R2 liegt unter `raw/` das Original und unter `md/` der Text derselben Fassung.

Alte Fassungen werden nie gelöscht. Das war beim Shell-Skript die wertvollste Eigenschaft
und bleibt es.

---

## 6. Der Abruf

**Normale Quellen (`pdf`).** Erst nachfragen, ob sich etwas geändert hat. Wenn nein,
fertig. Wenn doch: Datei nach R2, Prüfsumme mit der Vorfassung vergleichen, bei
Gleichstand wieder verwerfen. Bei echtem Unterschied Text mit pdf.js gewinnen, neue
Fassung anlegen, Meldung schreiben.

Kommt dabei fast nichts heraus — ein Scan ohne Textebene —, wird zusätzlich die
KI-Umwandlung versucht; sie holt aus Bildern manchmal doch etwas. Bleibt es dabei, wird
das Dokument als *ohne gewinnbaren Text* markiert und gemeldet, statt als vorhanden zu
gelten. Ein leerer Vertrag, der sich für vorhanden ausgibt, ist gefährlicher als eine
sichtbare Lücke.

**Der Cron ruft die Quellen über eine RPC-Bindung auf**, nicht über einen internen
HTTP-Pfad. Ein Pfad, der fremde Adressen abruft und Rechenzeit verbraucht, wäre sonst von
außen erreichbar — geschützt nur durch eine Kopfzeile, die jeder mitschicken kann. Eine
RPC-Methode gibt es im Netz gar nicht.

**Beobachtete Seiten (`watch`).** Für Tischler Nord, die Gerüstbau-Bundesinnung und die
Malerkasse gibt es keinen direkten Download. Hier wird die Seite geholt und **als Text
verglichen, nicht als HTML**, mit einem CSS-Selektor auf den Inhaltsbereich. Das behebt
genau die Fehlalarme, die im bisherigen README unter „Wichtig" stehen: Navigation und
Cookie-Banner ändern sich ständig, der Inhalt nicht.

Findet sich auf so einer Seite ein neuer PDF-Link, wird er als Kandidat gemeldet. Bei
Tischler Nord läuft das hinter dem Login ins Leere — dort ist die Seitenänderung selbst
das Signal, mit dem Hinweis, dass der Volltext von Hand hochgeladen werden muss.

**Fehler** brechen nichts ab. Sie landen als Meldung und rot in der Übersicht. Wenn eine
Behördenseite Cloudflare-Adressen abweist — bei `zoll.de` oder `bmas.de` nicht
auszuschließen — sieht man das sofort, statt es in einem Logfile zu verpassen.

---

## 7. Dateien

```
tarifcheck/
├─ wrangler.jsonc              Bindings, Cron, Assets
├─ DATENMODELL.md              Schema, Ablage, Abfragen
├─ SETUP.md                    Befehle zum Einrichten und Deployen
├─ data/tarif-quellen.tsv      Quellenliste
├─ migrations/0001_init.sql    Schema samt Volltextindex
├─ scripts/seed-sources.mjs    TSV → SQL
├─ src/
│  ├─ index.ts                 Routing, OAuth-Provider, fetch + scheduled
│  ├─ sync/                    Abruf, Textumwandlung
│  ├─ api/                     JSON für die Seite
│  ├─ auth/                    Anmeldung: Passwort, Sitzung, Bremse, OAuth
│  ├─ mcp/                     MCP-Server und seine Werkzeuge
│  └─ lib/                     Datenbank, Speicher, Hilfen
└─ public/                     die Seite selbst
```

---

## 8. Wie geprüft wird

- **Abruf:** `wrangler dev`, dann von Hand eine Quelle anstoßen. Danach muss genau eine
  Version in der Datenbank stehen. Der zweite Aufruf darf **keine** zweite anlegen — das
  ist der Test, der die ganze Änderungserkennung trägt.
- **Text:** die erzeugte Textfassung des BRTV einmal ansehen. Ob ein PDF-Layout sauber in
  Text übergeht, sieht man nur, wenn man draufschaut.
- **Rechenzeit:** nach dem ersten echten Cron-Lauf in den Worker-Statistiken prüfen. Liegt
  sie nahe an 10 ms, greift der Schalter aus §4.
- **Hochladen:** eine Beispieldatei hochladen und prüfen, ob Version und Meldung entstehen.
- **Abnahme:** eine Quelle absichtlich auf eine kaputte URL setzen und schauen, ob die
  Seite das rot meldet, ohne dass die anderen Quellen darunter leiden.

---

## 9. Was das System nicht leisten kann

Kein Softwareproblem, sondern Rechtslage:

- **Tischler:** keine Allgemeinverbindlicherklärung, kein öffentlicher Volltext. Der Text
  liegt nur im Mitgliederbereich von Tischler Nord. Automatisch geht die Überwachung der
  Seite, den Volltext lädt man hoch. Dasselbe beim **Lohn-TV Gerüstbau**.
- **Layout-Umbauten** bei den Betreibern brechen Links. Das System meldet es sichtbar,
  die Adresse korrigiert man von Hand.
- **Gültigkeitsdaten** liest niemand zuverlässig automatisch aus einem PDF. Das Feld ist
  pflegbar, und ausgegeben wird nur, was gepflegt ist. Lieber leer als falsch.
- **Reine Scans** ohne Textebene bleiben unlesbar. Derzeit ist keiner der siebzehn
  Verträge betroffen; falls einer dazukommt, meldet die Seite es als Fehler statt ihn
  stillschweigend als leeres Dokument zu führen.
