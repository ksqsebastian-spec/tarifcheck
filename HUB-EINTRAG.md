# Tarifcheck in den MCP-Hub aufnehmen

Anleitung für das Repo hinter dem Worker **`mcp-hub`**. Nach diesen Schritten erscheint
Tarifcheck auf der Übersicht neben HERO und Lexware Office, mit eigener Detailseite und
live geholter Tool-Liste.

Tarifcheck ist darauf vorbereitet: es liefert `/tools.json` im selben Format wie die
anderen beiden und kennzeichnet alle Werkzeuge als lesend.

---

## 1. Eintrag in `hub/src/registry.ts`

Zuerst das Logo neben `HERO_MARK` und `LEXWARE_MARK`. Bewusst kein fremdes Zeichen: die
Quellen sind Behörden und Sozialkassen, deren Marken hier nichts zu suchen haben.

```ts
const TARIF_MARK: Mark = {
  inner:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect x="9" y="9" width="32" height="40" rx="5" fill="#fff" opacity=".62"/>' +
    '<rect x="19" y="15" width="32" height="40" rx="5" fill="#fff"/>' +
    '<path fill="none" stroke="#0E7A55" stroke-width="6.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" d="M26 35.5l6 6 12-12.5"/></svg>',
  bg: "#0E7A55",
  accent: "#0E7A55",
  fill: 0.62,
};
```

Zwei versetzte Blätter, das vordere mit Haken: jede Fassung bleibt erhalten, und sie ist
geprüft. Das `fill: 0.62` ist wichtig — mit dem Standardwert 0.56 wird das Zeichen in der
Kachel zu klein und das hintere Blatt verschwindet bei 44 px.

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
