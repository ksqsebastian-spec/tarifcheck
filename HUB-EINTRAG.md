# Tarifcheck in den MCP-Hub aufnehmen

Anleitung für das Repo hinter dem Worker **`mcp-hub`**. Nach diesen Schritten erscheint
Tarifcheck auf der Übersicht neben HERO und Lexware Office, mit eigener Detailseite und
live geholter Tool-Liste.

Tarifcheck ist darauf vorbereitet: es liefert `/tools.json` im selben Format wie die
anderen beiden und kennzeichnet alle Werkzeuge als lesend.

---

## 1. Eintrag in `hub/src/registry.ts`

Zuerst das Logo neben `HERO_MARK` und `LEXWARE_MARK` — Tarifcheck ist keine fremde Marke,
das Zeichen ist frei wählbar:

```ts
const TARIF_MARK: Mark = {
  inner:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="#ffffff">' +
    '<rect x="10" y="16" width="44" height="7" rx="3.5"/>' +
    '<rect x="10" y="29" width="44" height="7" rx="3.5"/>' +
    '<rect x="10" y="42" width="26" height="7" rx="3.5"/></g></svg>',
  bg: "#1F7A5C",
  accent: "#1F7A5C",
};
```

Dann als drittes Element in `REGISTRY`:

```ts
{
  id: "tarifcheck",
  name: "Tarifcheck",
  tagline: "Tarifverträge",
  description:
    "Die Tarifverträge der Gruppenwerk-Gewerke — Bau, Gerüstbau, Maler, Tischler. " +
    "Täglich automatisch abgeglichen, jede Fassung archiviert. Nur lesend.",
  origin: "https://tarifcheck.ksqsebastian.workers.dev",
  mcpUrl: "https://tarifcheck.ksqsebastian.workers.dev/mcp",
  auth: "oauth",
  status: "aktiv",
  mark: TARIF_MARK,
  accent: TARIF_MARK.accent,
  icon: "T",
  catalog: "tools.json",
  binding: "TARIFCHECK",
  notes: [
    "Eigene Anmeldung mit Benutzer und Passwort — dieselbe wie auf der Seite. " +
      "Kein externer Anbieter dahinter.",
    "Ausschließlich lesend. Hochladen und Quellen ändern geht nur über die Seite selbst.",
    "Jede Antwort führt mit, von wann die Fassung ist und ob sie allgemeinverbindlich " +
      "ist. Beim Maler-Rahmentarifvertrag kursieren ältere Fassungen — ohne diesen " +
      "Vorbehalt wäre eine Zahl daraus wertlos.",
    "Für das Tischlerhandwerk gibt es keine Allgemeinverbindlicherklärung und damit " +
      "keine öffentliche Volltextquelle. Überwacht wird dort nur die Downloadseite; " +
      "der Vertragstext wird von Hand hochgeladen.",
  ],
},
```

## 2. Service-Binding in der `wrangler.jsonc` von `mcp-hub`

Wie bei HERO und Lexware. `fetchCatalog` schlägt das Binding über `env[entry.binding]`
nach und holt den Katalog darüber, statt über das Netz zu gehen.

```jsonc
"services": [
  { "binding": "HERO",       "service": "hero-mcp" },
  { "binding": "LEXWARE",    "service": "lexware-mcp" },
  { "binding": "TARIFCHECK", "service": "tarifcheck" }
]
```

Der Name muss auf `binding: "TARIFCHECK"` aus Schritt 1 passen — `fetchCatalog` schlägt
ihn über `env[entry.binding]` nach.

## 3. Fertig

`fetchCatalog` holt `${origin}/tools.json`, `overviewPage` und `serverPage` brauchen keine
Änderung. Die Trennung in lesend und schreibend läuft über `t.annotations?.readOnlyHint` —
Tarifcheck setzt das auf allen sechs Werkzeugen, die Detailseite zeigt also
**6 lesend, 0 schreibend** und einen leeren Abschnitt „Schreibend".

Wenn ein leerer Abschnitt stört, wäre das die einzige Stelle im Hub, die es anzupassen
lohnt — Lexware und HERO haben beide Sorten, Tarifcheck nur eine:

```ts
// in serverPage(), statt den Abschnitt bedingungslos zu rendern
${write.length ? `<section class="group">…Schreibend…</section>` : ""}
```

---

## Was Tarifcheck liefert

`GET /tools.json` — ohne Anmeldung erreichbar, enthält nur Namen und Beschreibungen,
keine Tarifdaten:

```json
{
  "server": { "name": "tarifcheck", "version": "1.0.0" },
  "tools": [ { "name": "...", "title": "...", "description": "...",
               "inputSchema": { ... }, "annotations": { "readOnlyHint": true } } ]
}
```

Die Liste ist nicht gepflegt, sondern wird beim MCP-Server selbst erfragt. Eine zweite
Liste von Hand würde früher oder später etwas anderes behaupten als der Server kann.

| Werkzeug | Argumente |
|---|---|
| `gewerke_auflisten` | — |
| `dokumente_auflisten` | `gewerk` |
| `dokument_lesen` | `id`\*, `version_id` |
| `was_ist_neu` | `gewerk`, `seit_tagen` |
| `tarife_durchsuchen` | `suche`\*, `gewerk` |
| `versionen_auflisten` | `id`\* |

\* Pflicht

## Zum Service-Binding

`/tools.json` ist bewusst ohne Anmeldung erreichbar — es enthält nur Namen und
Beschreibungen der Werkzeuge, keine Tarifdaten. Der Hub käme also auch ohne Binding an
den Katalog.

Trotzdem ist das Binding der bessere Weg: es spart den Umweg übers Netz, zählt nicht
gegen das Anfragekontingent und bleibt auch dann heil, wenn Tarifcheck später einmal
komplett hinter eine Anmeldung wandert.
