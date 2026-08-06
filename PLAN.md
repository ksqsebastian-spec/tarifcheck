# Tarifcheck — Plan

Tarifvertrags-Seite auf Cloudflare. Hält die Tarifverträge aller Gruppenwerk-Gewerke
automatisch aktuell, meldet Änderungen auf der Seite und legt alles so ab, dass ein
separater MCP-Server es lesen kann.

**Der MCP wird nicht hier gebaut.** Er kommt ins bestehende `mcpee`-Repo. Dieses Repo
liefert die Daten und den Vertrag darüber — siehe `MCP-CONTRACT.md`.

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

**Anmeldung** über Cloudflare Access. Eine Regel, etwa „Mailadresse endet auf
`@gruppenwerk.de`", schützt die ganze Seite. Das ist reine Konfiguration im
Cloudflare-Konto, dafür ist in diesem Repo keine Zeile Code nötig.

---

## 3. Aufbau

Ein Worker. Vorne die Seite, hinten der tägliche Abruf.

```
        ┌──────────── Cron 06:15 ────────────┐
        │  ein Selbstaufruf je Quelle        │
        ▼                                    │
  Quelle ──▶ Worker ──▶ R2  raw/…pdf         │
              │                              │
              ├─ AI.toMarkdown() ─▶ R2 md/…md│
              └─ D1: dokumente, versionen,   │
                     meldungen               │
                                             │
  Browser ─Access─▶ Seite (Assets + JSON)────┘

  ── später, aus dem mcpee-Repo ──
  Claude ─OAuth─▶ MCP-Worker ─▶ dieselbe D1 + dasselbe R2
```

Der MCP-Worker hängt sich per Binding an dieselbe Datenbank und denselben Bucket. Das
geht innerhalb eines Cloudflare-Kontos direkt, ohne Schnittstelle und ohne Schlüssel
dazwischen. Er liest nur.

### Bindings dieses Workers

| Binding | Typ | Zweck |
|---|---|---|
| `R2` | R2 Bucket `tarifcheck` | Originaldateien (`raw/`) und Text (`md/`) |
| `DB` | D1 `tarifcheck` | Quellen, Dokumente, Versionen, Meldungen |
| `AI` | Workers AI | `toMarkdown()` für die Textumwandlung |
| `ASSETS` | Static Assets | die Seite |

Kein KV, keine Durable Objects, keine Queues — nichts davon wird ohne MCP hier gebraucht.

---

## 4. Kosten — läuft auf Workers Free

| Grenze | Free | Bedarf |
|---|---|---|
| Rechenzeit je Durchlauf | **10 ms** | die einzige echte Hürde |
| Externe Abrufe je Durchlauf | 50 | 1–3 pro Quelle |
| Aufrufe an R2/D1/AI je Durchlauf | 1.000 | unkritisch |
| Anfragen pro Tag | 100.000 | ~50 |
| R2 Speicher | 10 GB | < 200 MB |

Die 10 ms Rechenzeit sind der ganze Trick. Drei Regeln halten uns darunter:

1. **Jede Quelle einzeln.** Der Cron arbeitet die Quellen nicht der Reihe nach ab, sondern
   ruft sich selbst einmal pro Quelle auf. Jede bekommt so ihr eigenes frisches Budget.
   Nebeneffekt: eine kaputte Quelle reißt die anderen nicht mit.
2. **Nichts selbst durchrechnen.** Änderungserkennung läuft über die Kopfzeilen des
   Servers (`If-None-Match`, `If-Modified-Since`) — antwortet er „unverändert", kostet das
   praktisch nichts. Wo er keine schickt, wird die Datei geschrieben und die Prüfsumme
   verglichen, **die R2 von sich aus zurückgibt**. Große PDFs werden nie im Worker
   durchgerechnet.
3. **Der Download ist ein Durchreichen.** Der Datenstrom geht direkt von der Quelle nach
   R2, ohne im Speicher zusammengebaut zu werden.

Falls es doch reißt: eine Zeile `limits.cpu_ms` in `wrangler.jsonc`, das setzt Workers
Paid voraus (5 $/Monat). Die Zeile liegt auskommentiert bei.

Offen bleibt ehrlich: was `toMarkdown()` an KI-Kontingent verbraucht, ist nicht separat
ausgewiesen. Bei rund fünfzehn Dokumenten, die sich selten ändern, erwarte ich das
unkritisch — den Zähler sollte man in der ersten Woche trotzdem anschauen.

---

## 5. Daten

Schema und Ablage sind in **`MCP-CONTRACT.md`** festgeschrieben, weil der andere Chat
genau darauf baut. Kurzfassung:

- `quellen` — die gepflegte Liste, kommt aus `data/tarif-quellen.tsv`
- `dokumente` — ein Vertrag, entweder automatisch geholt oder hochgeladen
- `versionen` — jede Fassung bleibt erhalten, nichts wird überschrieben
- `meldungen` — Änderungen, Fehler, Uploads; mit gelesen/ungelesen
- `dokumente_fts` — Volltextindex über den Text, für die spätere Suche im MCP

In R2 liegt unter `raw/` das Original und unter `md/` der Text derselben Fassung.

Alte Fassungen werden nie gelöscht. Das war beim Shell-Skript die wertvollste Eigenschaft
und bleibt es.

---

## 6. Der Abruf

**Normale Quellen (`pdf`).** Erst nachfragen, ob sich etwas geändert hat. Wenn nein,
fertig. Wenn doch: Datei nach R2 streamen, Prüfsumme mit der Vorversion vergleichen, bei
Gleichstand wieder verwerfen. Bei echtem Unterschied Text erzeugen, neue Version anlegen,
Meldung schreiben.

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
├─ MCP-CONTRACT.md             Vertrag für das mcpee-Repo
├─ SETUP.md                    Befehle zum Einrichten und Deployen
├─ data/tarif-quellen.tsv      Quellenliste
├─ migrations/0001_init.sql    Schema samt Volltextindex
├─ scripts/seed-sources.mjs    TSV → SQL
├─ src/
│  ├─ index.ts                 Routing, fetch + scheduled
│  ├─ sync/                    Abruf, Textumwandlung
│  ├─ api/                     JSON für die Seite
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
