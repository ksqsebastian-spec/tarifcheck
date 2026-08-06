# Datenmodell

Wie die Daten liegen, auf denen Seite und MCP-Server arbeiten. Beide stecken in diesem
Repo; dieses Dokument beschreibt den Vertrag zwischen ihnen.

Nützlich außerdem, falls der MCP-Server später doch in ein anderes Repo umziehen soll —
er würde dort als eigener Worker dieselbe D1 und dasselbe R2 binden. Wie das geht, steht
in Abschnitt 1.

---

## 1. Zugriff aus einem anderen Worker

Zwei Worker dürfen dieselbe Datenbank und denselben Bucket binden — auch aus einem anderen
Repo, solange es dasselbe Cloudflare-Konto ist. Es braucht keine HTTP-Schnittstelle und
keinen geteilten Schlüssel dazwischen.

```jsonc
{
  "d1_databases": [
    { "binding": "TARIF_DB", "database_name": "tarifcheck",
      "database_id": "<dieselbe ID wie in der wrangler.jsonc hier>" }
  ],
  "r2_buckets": [
    { "binding": "TARIF_R2", "bucket_name": "tarifcheck" }
  ]
}
```

**Kein `migrations_dir` setzen** — die Migrationen gehören in dieses Repo.

**Nur lesen.** Schreiben ist Sache der Seite. Der Grund ist nicht Vorsicht, sondern
Zuständigkeit: die Änderungserkennung hängt an Prüfsummen, die beim Schreiben entstehen.
Ein zweiter Schreiber würde sie unbemerkt entwerten.

---

## 2. Wo was liegt

### R2

| Präfix | Inhalt |
|---|---|
| `raw/<gewerk>/<dokument_id>/<stempel>.<endung>` | Originaldatei, meist PDF |
| `md/<gewerk>/<dokument_id>/<stempel>.md` | Textfassung derselben Fassung |

Der Stempel hat die Form `20260806-061500` (UTC). Schlüssel **nie selbst zusammenbauen** —
sie stehen in `versionen.r2_md_key` bzw. `versionen.r2_raw_key`. Für den MCP ist
praktisch immer `r2_md_key` das Richtige.

### D1

Fünf Tabellen. Vollständige Definition in `migrations/0001_init.sql`.

| Tabelle | Bedeutung |
|---|---|
| `quellen` | gepflegte Quellenliste, `typ` ist `pdf` oder `watch` |
| `dokumente` | ein Tarifvertrag; `herkunft` ist `auto` oder `manuell` |
| `versionen` | jede je erfasste Fassung, nichts wird überschrieben |
| `meldungen` | Änderungen, Fehler, Uploads — mit `gelesen` |
| `dokumente_fts` | FTS5-Volltextindex über die aktuelle Textfassung |

Spalten, die man leicht falsch versteht:

- **`dokumente.aktuelle_version_id`** — zeigt auf die neueste Fassung. Ist sie `NULL`,
  wurde noch nie etwas erfolgreich geholt. Solche Dokumente **nicht als leer ausgeben**,
  sondern sagen, dass noch kein Inhalt vorliegt.
- **`dokumente.hinweis`** — fachlicher Vorbehalt, siehe Abschnitt 4. **Immer mit ausgeben.**
- **`dokumente.gueltig_ab`** — von Hand gepflegt, oft `NULL`. Wird bewusst nicht aus dem
  PDF geraten. `NULL` heißt „unbekannt", nicht „gilt ab immer".
- **`versionen.etag`** — MD5 von R2, interne Vergleichsbasis. Für den MCP ohne Bedeutung.
- **`versionen.text_zeichen`** — wieviel lesbarer Text herauskam, Überschriften und
  Seitenmarken abgezogen.
- **`versionen.text_brauchbar`** — `0` heißt: die Datei liegt vor, enthält aber keinen
  gewinnbaren Text. Solche Dokumente **nicht als vorhandenen Vertrag ausgeben**. Das Feld
  ist ein gespeichertes Urteil, keine Schwelle zum Nachrechnen — die Regel steht in
  `src/sync/text.ts` und soll nicht an drei Stellen abgeschrieben werden.
- **`dokumente.letzter_status`** — `ok`, `unveraendert` oder `fehler`. Bei `fehler` ist
  der Inhalt trotzdem noch der zuletzt erfolgreich geholte, nur eben womöglich veraltet.
  Das gehört in die Antwort.

---

## 3. Fertige Abfragen

### Gewerke auflisten

```sql
SELECT gewerk,
       COUNT(*)                                                     AS dokumente,
       SUM(CASE WHEN aktuelle_version_id IS NOT NULL THEN 1 ELSE 0 END) AS mit_inhalt,
       MAX(letzte_pruefung)                                         AS zuletzt_geprueft
  FROM dokumente
 GROUP BY gewerk
 ORDER BY gewerk;
```

Werte für `gewerk`: `BAU`, `GERUESTBAU`, `MALER`, `TISCHLER`, `UEBERGREIFEND`.

### Dokumente eines Gewerks

```sql
SELECT d.id, d.titel, d.kuerzel, d.gewerk, d.herkunft, d.gueltig_ab, d.hinweis,
       d.letzter_status, d.letzte_pruefung,
       v.erfasst_am AS stand, v.r2_md_key, q.url AS quelle_url, q.typ AS quelle_typ
  FROM dokumente d
  LEFT JOIN versionen v ON v.id = d.aktuelle_version_id
  LEFT JOIN quellen   q ON q.id = d.quelle_id
 WHERE (?1 IS NULL OR d.gewerk = ?1)
 ORDER BY d.gewerk, d.titel;
```

### Volltext eines Dokuments

```sql
SELECT v.r2_md_key, v.erfasst_am, d.titel, d.hinweis, d.gueltig_ab, q.url
  FROM dokumente d
  JOIN versionen v ON v.id = d.aktuelle_version_id
  LEFT JOIN quellen q ON q.id = d.quelle_id
 WHERE d.id = ?1;
```

Danach `await env.TARIF_R2.get(r2_md_key)` und `.text()`.

Manche Verträge sind lang. Bei mehr als etwa 100.000 Zeichen besser abschneiden und
darauf hinweisen, statt das Kontextfenster zu füllen.

### Was ist neu

Das Tool für die Frage „was ist neu bei den Tischlern".

```sql
SELECT m.zeitpunkt, m.art, m.titel, m.beschreibung, m.gewerk,
       m.dokument_id, d.titel AS dokument_titel
  FROM meldungen m
  LEFT JOIN dokumente d ON d.id = m.dokument_id
 WHERE m.zeitpunkt >= ?1
   AND (?2 IS NULL OR m.gewerk = ?2)
   AND m.art IN ('neu', 'geaendert', 'seite_geaendert', 'upload')
 ORDER BY m.zeitpunkt DESC
 LIMIT 50;
```

`art` bedeutet:

| Wert | Bedeutung |
|---|---|
| `neu` | Dokument erstmals erfasst |
| `geaendert` | Datei bei der Quelle unterscheidet sich von der Vorfassung |
| `seite_geaendert` | überwachte Seite hat sich geändert — **meist Handlungsbedarf** |
| `neuer_link` | auf einer überwachten Seite ist ein neues PDF aufgetaucht |
| `upload` | jemand hat von Hand etwas hochgeladen |
| `fehler` | Abruf fehlgeschlagen — nicht in „was ist neu" mischen, das ist Betrieb, kein Inhalt |

`gelesen` gehört der Seite. Der MCP soll es **weder lesen noch setzen** — was jemand im
Browser weggeklickt hat, sagt nichts darüber, ob es für die Frage gerade relevant ist.

### Suche

```sql
SELECT f.dokument_id, f.titel, f.gewerk,
       snippet(dokumente_fts, 3, '**', '**', ' … ', 20) AS fundstelle,
       bm25(dokumente_fts) AS rang
  FROM dokumente_fts f
 WHERE dokumente_fts MATCH ?1
 ORDER BY rang
 LIMIT 20;
```

Der Index ist mit `unicode61 remove_diacritics 2` gebaut, Umlaute sind also unkritisch.
Nutzereingaben nicht ungeprüft durchreichen — `"`, `*`, `NEAR`, `OR` haben in FTS5 eine
Bedeutung und lassen die Abfrage sonst mit einem Syntaxfehler scheitern. Sicher ist es,
die Eingabe in Wörter zu zerlegen und jedes einzeln in `"…"` zu setzen.

### Versionsverlauf

```sql
SELECT id, erfasst_am, bytes, r2_md_key, hochgeladen_von
  FROM versionen WHERE dokument_id = ?1 ORDER BY erfasst_am DESC;
```

Zwei Fassungen zu vergleichen heißt: beide `r2_md_key` aus R2 holen und den Text
gegenüberstellen. Absichtlich nicht vorberechnet — es wird selten gebraucht und würde
sonst täglich Rechenzeit kosten.

---

## 4. Was jede Antwort mitführen muss

Das ist keine Stilfrage. Es geht darum, dass niemand aufgrund einer Auskunft eine falsche
Lohnzahlung ansetzt.

1. **`dokumente.hinweis` immer mit ausgeben.** Dort steht zum Beispiel, dass es für das
   Tischlerhandwerk keine Allgemeinverbindlicherklärung gibt. Eine Antwort ohne diesen
   Vorbehalt ist irreführend.
2. **Stand und Gültigkeitsdatum nennen** — `versionen.erfasst_am` und `dokumente.gueltig_ab`.
   Beim Maler-Rahmentarifvertrag kursieren bei Behörden ältere Fassungen; eine Zahl ohne
   Stand ist wertlos.
3. **`herkunft = 'manuell'` kenntlich machen.** Das ist ein Upload eines Kollegen, keine
   amtliche Quelle.
4. **Bei `letzter_status = 'fehler'` dazusagen**, dass der letzte Abruf scheiterte und der
   Inhalt womöglich veraltet ist.
5. **Überwachte Seiten sind keine Verträge.** Wo `quellen.typ = 'watch'` ist, ist der
   Inhalt der Text einer Downloadseite, kein Vertragstext. Nie als Vertragsinhalt ausgeben.

---

## 5. Anmeldung (bereits umgesetzt)

Umgesetzt in `src/auth/access.ts` und `src/index.ts`. Der MCP-Server stellt eigene Tokens
aus; die Seite hängt an Cloudflare Access. Zum Einrichten siehe `SETUP.md`.

Der Aufbau: `workers-oauth-provider` als eigener Autorisierungsserver, mit Cloudflare
Access davor. Grund: Claude-Connectors melden sich per Dynamic Client Registration an,
das kennt Access für SaaS nicht. `workers-oauth-provider` spricht DCR nach außen und OIDC
nach innen mit Access. Dafür braucht der MCP-Worker eine eigene KV-Namespace und eine
eigene Access-for-SaaS-App mit Rückleitung auf seine `/callback`-Adresse.

Anleitung: <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/>

Für den Server selbst ist `createMcpHandler()` aus `agents/mcp/server` die aktuell
empfohlene Variante — zustandslos, also ohne Durable Objects, was im Free-Plan hilft.

---

## 6. Werkzeuge des MCP

Umgesetzt in `src/mcp/werkzeuge.ts`.

| Werkzeug | Abfrage |
|---|---|
| `gewerke_auflisten` | 3.1 |
| `dokumente_auflisten` | 3.2 |
| `dokument_lesen` | 3.3 |
| `was_ist_neu` | 3.4 — trägt die Beispielfrage |
| `tarife_durchsuchen` | 3.6 |
| `versionen_auflisten` | 3.7 |

Die Suche setzt ab vier Buchstaben ein Präfix (`"Wegezeit"*`). Ohne das findet
„Wegezeit" die „Wegezeitentschädigung" nicht — in deutschen Tariftexten wäre die Suche
sonst häufig blind.

---

## 7. Was sich ändern darf

**Stabil**, darauf kann gebaut werden: Tabellen- und Spaltennamen, die Werte von `art`,
`typ`, `herkunft` und `letzter_status`, die R2-Präfixe `raw/` und `md/`.

**Nicht stabil**: die Menge der Zeilen in `quellen` (Quellen kommen und gehen), das Format
von `meldungen.beschreibung` (Fließtext für Menschen, nicht zum Parsen), die Stempel in
den R2-Schlüsseln (immer aus der Datenbank lesen).

Kommt eine Spalte dazu, wird sie hier ergänzt. Verschwindet eine, ist das ein Bruch und
gehört vorher abgesprochen.
