import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../lib/typen";

/**
 * Ab dieser Laenge wird ein Volltext abgeschnitten. Der BRTV hat rund 200.000
 * Zeichen - komplett ausgeliefert fuellt er das Kontextfenster, ohne dass die
 * Antwort besser wird.
 */
const MAX_ZEICHEN = 80_000;

const GEWERKE = ["BAU", "GERUESTBAU", "MALER", "TISCHLER", "UEBERGREIFEND"] as const;

/**
 * Alle Werkzeuge lesen nur. Geschrieben wird ausschliesslich ueber die Seite.
 *
 * Die Kennzeichnung ist nicht bloss Deko: der MCP-Hub teilt die Tool-Liste
 * danach in "lesend" und "schreibend". Ohne sie stuenden alle sechs unter
 * schreibend - bei einem reinen Lesedienst eine Falschaussage an genau der
 * Stelle, an der jemand nachsieht, was der Server anrichten kann.
 */
const NUR_LESEN = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const alsJson = (d: unknown) => text(JSON.stringify(d, null, 2));

/**
 * Nutzereingabe in eine sichere FTS5-Abfrage uebersetzen.
 *
 * In FTS5 haben `"`, `*`, `NEAR`, `AND`, `OR` und `-` eine Bedeutung. Eine
 * durchgereichte Frage wie `Urlaubsgeld (§8)` laesst die Abfrage sonst mit
 * einem Syntaxfehler scheitern statt einfach nichts zu finden.
 *
 * Ab vier Buchstaben wird als Praefix gesucht (`"Wegezeit"*`). Ohne das findet
 * "Wegezeit" die "Wegezeitentschaedigung" nicht, weil FTS nur ganze Woerter
 * trifft - in deutschen Tariftexten waere die Suche damit haeufig blind.
 */
function ftsAusdruck(eingabe: string): string {
  const woerter = eingabe
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 12);
  if (!woerter.length) return "";
  return woerter
    .map((w) => {
      const rein = w.replace(/"/g, "");
      return rein.length >= 4 ? `"${rein}"*` : `"${rein}"`;
    })
    .join(" OR ");
}

/**
 * Vorbehalte, die an jede Auskunft gehoeren.
 *
 * Der Grund ist nicht Formalismus: Wer auf Basis einer Antwort einen Lohn
 * ansetzt, muss wissen, von wann die Fassung ist und ob sie ueberhaupt
 * allgemeinverbindlich ist. Beim Maler-Rahmentarifvertrag kursieren bei
 * Behoerden aeltere Fassungen.
 */
function vorbehalte(d: any): string[] {
  const v: string[] = [];
  if (d.hinweis) v.push(d.hinweis);
  if (d.herkunft === "manuell")
    v.push("Von Hand hochgeladen, keine amtlich abgerufene Quelle.");
  if (d.quelle_typ === "watch")
    v.push(
      "ACHTUNG: Das ist der Text einer Downloadseite, kein Vertragstext. " +
        "Nicht als Vertragsinhalt wiedergeben.",
    );
  if (d.letzter_status === "fehler")
    v.push(
      `Der letzte Abrufversuch ist gescheitert (${d.letzter_fehler ?? "Grund unbekannt"}). ` +
        "Der Inhalt stammt vom letzten erfolgreichen Abruf und kann veraltet sein.",
    );
  if (d.text_brauchbar === 0)
    v.push(
      "ACHTUNG: Aus diesem Dokument ließ sich kein Text gewinnen — die Datei liegt " +
        "vor, ist aber vermutlich ein Scan ohne Texterkennung. Es gibt hier KEINEN " +
        "Inhalt wiederzugeben. Nicht raten, sondern auf die Quelle verweisen.",
    );
  // Der Vorbehalt nur, wenn wirklich nichts vorliegt. Frueher stand er bei
  // jedem einzelnen Treffer - und ein Hinweis, der immer dasteht, wird
  // ueberlesen. Er war Rauschen statt Warnung.
  if (!d.gueltig_ab && !datumFunde(d).length)
    v.push(
      "Kein Gültigkeitsdatum hinterlegt, und im Text ließ sich keins finden. " +
        "Bitte im Dokument selbst nachsehen.",
    );
  return v;
}

const ARTNAME: Record<string, string> = {
  inkrafttreten: "tritt in Kraft am",
  ausserkrafttreten: "tritt außer Kraft am",
  fassung: "Fassung vom",
  geltung: "gilt ab",
};

/**
 * Datumsangaben, die woertlich im Dokument stehen.
 *
 * Ausdruecklich Zitate, keine gepflegten Angaben: sie ersetzen `gueltig_ab`
 * nicht, sondern geben dem Leser das an die Hand, was im Text steht.
 */
function datumFunde(d: any): Array<{ bedeutung: string; datum: string; fundstelle: string }> {
  if (!d.datum_funde) return [];
  try {
    return (JSON.parse(d.datum_funde) as any[]).map((f) => ({
      bedeutung: ARTNAME[f.art] ?? f.art,
      datum: f.datum,
      fundstelle: f.fundstelle,
    }));
  } catch {
    return [];
  }
}

/** Alles zum Stand eines Dokuments an einer Stelle. */
function datumsangaben(d: any) {
  const funde = datumFunde(d);
  if (!funde.length) return {};
  return {
    datum_im_text: funde,
    datum_hinweis:
      "Wörtlich aus dem Dokument entnommen, nicht redaktionell geprüft. " +
      "Beim Nennen einer Zahl bitte mit angeben, worauf sie sich stützt.",
  };
}

export function werkzeugeAnmelden(server: McpServer, env: Env): void {
  server.registerTool(
    "gewerke_auflisten",
    {
      title: "Gewerke auflisten",
      description:
        "Listet alle Gewerke mit Anzahl der Dokumente und dem Datum der letzten Prüfung. " +
        "Guter erster Aufruf, um zu sehen, was überhaupt da ist.",
      inputSchema: z.object({}),
      annotations: NUR_LESEN,
    },
    async () => {
      const { results } = await env.DB.prepare(
        `SELECT gewerk,
                COUNT(*) AS dokumente,
                SUM(CASE WHEN aktuelle_version_id IS NOT NULL THEN 1 ELSE 0 END) AS mit_inhalt,
                SUM(CASE WHEN letzter_status = 'fehler' THEN 1 ELSE 0 END) AS mit_fehler,
                MAX(letzte_pruefung) AS zuletzt_geprueft
           FROM dokumente GROUP BY gewerk ORDER BY gewerk`,
      ).all();
      return alsJson({ gewerke: results });
    },
  );

  server.registerTool(
    "dokumente_auflisten",
    {
      title: "Dokumente auflisten",
      description:
        "Listet die Tarifverträge, wahlweise für ein Gewerk. Liefert Titel, Stand, " +
        "Gültigkeitsdatum und die Vorbehalte, die zu jedem Dokument gehören.",
      inputSchema: z.object({
        gewerk: z.enum(GEWERKE).optional().describe("Auf ein Gewerk einschränken"),
      }),
      annotations: NUR_LESEN,
    },
    async ({ gewerk }) => {
      const sql = `
        SELECT d.id, d.titel, d.kuerzel, d.gewerk, d.herkunft, d.gueltig_ab, d.hinweis,
               d.letzter_status, d.letzter_fehler, d.letzte_pruefung,
               v.erfasst_am AS stand, v.text_zeichen, v.text_brauchbar,
               v.datum_funde, q.url AS quelle_url, q.typ AS quelle_typ,
               (d.aktuelle_version_id IS NOT NULL AND COALESCE(v.text_brauchbar, 0) = 1)
                 AS hat_inhalt
          FROM dokumente d
          LEFT JOIN versionen v ON v.id = d.aktuelle_version_id
          LEFT JOIN quellen   q ON q.id = d.quelle_id
         ${gewerk ? "WHERE d.gewerk = ?" : ""}
         ORDER BY d.gewerk, d.titel`;
      const { results } = await (gewerk
        ? env.DB.prepare(sql).bind(gewerk)
        : env.DB.prepare(sql)
      ).all();

      return alsJson({
        dokumente: results.map((zeile: any) => {
          // datum_funde ist die rohe Spalte. Die Helfer brauchen sie, in der
          // Ausgabe stuende sie doppelt neben datum_im_text.
          const { datum_funde: _roh, ...d } = zeile;
          return {
            ...d,
            hat_inhalt: !!d.hat_inhalt,
            ...datumsangaben(zeile),
            vorbehalte: vorbehalte(zeile),
          };
        }),
      });
    },
  );

  server.registerTool(
    "dokument_lesen",
    {
      title: "Dokument lesen",
      description:
        "Liefert den Volltext eines Tarifvertrags als Markdown. Die id kommt aus " +
        "dokumente_auflisten oder tarife_durchsuchen.",
      inputSchema: z.object({
        id: z.string().describe("Dokument-ID, z. B. bau-brtv"),
        version_id: z
          .string()
          .optional()
          .describe("Ältere Fassung lesen; ohne Angabe die aktuelle"),
      }),
      annotations: NUR_LESEN,
    },
    async ({ id, version_id }) => {
      const d = await env.DB.prepare(
        `SELECT d.*, q.url AS quelle_url, q.typ AS quelle_typ
           FROM dokumente d LEFT JOIN quellen q ON q.id = d.quelle_id
          WHERE d.id = ?`,
      )
        .bind(id)
        .first<any>();
      if (!d) return text(`Kein Dokument mit der id "${id}".`);

      const versionId = version_id ?? d.aktuelle_version_id;
      if (!versionId) {
        return alsJson({
          titel: d.titel,
          inhalt: null,
          erlaeuterung:
            "Für dieses Dokument liegt noch kein Inhalt vor — es wurde noch nie " +
            "erfolgreich abgerufen oder hochgeladen.",
          vorbehalte: vorbehalte(d),
        });
      }

      const v = await env.DB.prepare(
        "SELECT * FROM versionen WHERE id = ? AND dokument_id = ?",
      )
        .bind(versionId, id)
        .first<any>();
      if (!v?.r2_md_key) return text(`Zu dieser Fassung gibt es keinen Text.`);

      const objekt = await env.R2.get(v.r2_md_key);
      if (!objekt) return text("Der Text ist im Speicher nicht auffindbar.");

      d.text_brauchbar = v.text_brauchbar;
      d.datum_funde = v.datum_funde;

      let inhalt = await objekt.text();
      let gekuerzt = false;
      if (inhalt.length > MAX_ZEICHEN) {
        inhalt = inhalt.slice(0, MAX_ZEICHEN);
        gekuerzt = true;
      }

      return alsJson({
        titel: d.titel,
        gewerk: d.gewerk,
        stand: v.erfasst_am,
        gueltig_ab: d.gueltig_ab,
        ...datumsangaben(d),
        herkunft: d.herkunft,
        quelle: d.quelle_url,
        hochgeladen_von: v.hochgeladen_von,
        vorbehalte: vorbehalte(d),
        gekuerzt,
        ...(gekuerzt
          ? {
              kuerzung_hinweis:
                `Nach ${MAX_ZEICHEN} Zeichen abgeschnitten. Für gezielte Stellen ` +
                `besser tarife_durchsuchen benutzen.`,
            }
          : {}),
        inhalt,
      });
    },
  );

  server.registerTool(
    "was_ist_neu",
    {
      title: "Was ist neu",
      description:
        "Änderungen an den Tarifverträgen seit einem Zeitpunkt — neue Fassungen, " +
        "geänderte Downloadseiten, Uploads. Das ist das Werkzeug für Fragen wie " +
        "'was ist neu bei den Tischlern'.",
      inputSchema: z.object({
        gewerk: z.enum(GEWERKE).optional(),
        seit_tagen: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(90)
          .describe("Zeitraum rückwärts in Tagen"),
      }),
      annotations: NUR_LESEN,
    },
    async ({ gewerk, seit_tagen }) => {
      const seit = new Date(Date.now() - seit_tagen * 86400_000).toISOString();
      const sql = `
        SELECT m.zeitpunkt, m.art, m.titel, m.beschreibung, m.gewerk,
               m.dokument_id, d.titel AS dokument_titel, d.hinweis
          FROM meldungen m LEFT JOIN dokumente d ON d.id = m.dokument_id
         WHERE m.zeitpunkt >= ?
           AND m.art IN ('neu', 'geaendert', 'seite_geaendert', 'neuer_link', 'upload')
           ${gewerk ? "AND m.gewerk = ?" : ""}
         ORDER BY m.zeitpunkt DESC LIMIT 50`;
      const { results } = await (gewerk
        ? env.DB.prepare(sql).bind(seit, gewerk)
        : env.DB.prepare(sql).bind(seit)
      ).all();

      if (!results.length) {
        return alsJson({
          zeitraum_ab: seit,
          gewerk: gewerk ?? "alle",
          aenderungen: [],
          erlaeuterung:
            `In diesem Zeitraum hat sich nichts geändert. Das heißt: die Quellen ` +
            `wurden geprüft und lieferten dieselben Fassungen wie zuvor.`,
        });
      }

      return alsJson({
        zeitraum_ab: seit,
        gewerk: gewerk ?? "alle",
        aenderungen: results,
        erlaeuterung:
          "Bei 'seite_geaendert' hat sich eine überwachte Downloadseite geändert, " +
          "nicht zwingend der Vertrag selbst — dort gibt es keine öffentliche " +
          "Volltextquelle, der Text muss von Hand hochgeladen werden.",
      });
    },
  );

  server.registerTool(
    "tarife_durchsuchen",
    {
      title: "Tarifverträge durchsuchen",
      description:
        "Volltextsuche über alle Tarifverträge. Gibt Fundstellen mit Kontext zurück. " +
        "Für gezielte Fragen ('Urlaubsgeld', 'Wegezeit') besser als dokument_lesen.",
      inputSchema: z.object({
        suche: z.string().min(2).describe("Stichwörter, z. B. Urlaubsgeld Maler"),
        gewerk: z.enum(GEWERKE).optional(),
      }),
      annotations: NUR_LESEN,
    },
    async ({ suche, gewerk }) => {
      const ausdruck = ftsAusdruck(suche);
      if (!ausdruck) return text("Bitte mindestens ein Stichwort mit zwei Buchstaben angeben.");

      const sql = `
        SELECT f.dokument_id, f.titel, f.gewerk,
               snippet(dokumente_fts, 3, '**', '**', ' … ', 24) AS fundstelle
          FROM dokumente_fts f
         WHERE dokumente_fts MATCH ?
           ${gewerk ? "AND f.gewerk = ?" : ""}
         ORDER BY bm25(dokumente_fts) LIMIT 20`;
      const { results } = await (gewerk
        ? env.DB.prepare(sql).bind(ausdruck, gewerk)
        : env.DB.prepare(sql).bind(ausdruck)
      ).all<any>();

      if (!results.length) {
        return alsJson({
          suche,
          treffer: [],
          erlaeuterung:
            "Nichts gefunden. Möglich ist auch, dass das betreffende Dokument noch " +
            "keinen Inhalt hat — dokumente_auflisten zeigt das unter hat_inhalt.",
        });
      }

      // Vorbehalte pro Treffer nachladen, damit nichts ohne seinen Kontext dasteht.
      const ids = [...new Set(results.map((r) => r.dokument_id))];
      const { results: docs } = await env.DB.prepare(
        // Die Versionsdaten gehoeren mit dazu: ohne sie fehlen in Suchtreffern
        // sowohl die Datumsangaben als auch der Hinweis auf nicht gewinnbaren
        // Text - ausgerechnet dort, wo am ehesten jemand eine Zahl ablesen will.
        `SELECT d.id, d.hinweis, d.herkunft, d.gueltig_ab, d.letzter_status,
                d.letzter_fehler, q.typ AS quelle_typ,
                v.text_brauchbar, v.datum_funde, v.erfasst_am AS stand
           FROM dokumente d
           LEFT JOIN quellen   q ON q.id = d.quelle_id
           LEFT JOIN versionen v ON v.id = d.aktuelle_version_id
          WHERE d.id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<any>();
      const nach = new Map(docs.map((d) => [d.id, d]));

      return alsJson({
        suche,
        treffer: results.map((r) => ({
          ...r,
          gueltig_ab: nach.get(r.dokument_id)?.gueltig_ab ?? null,
          stand: nach.get(r.dokument_id)?.stand ?? null,
          ...datumsangaben(nach.get(r.dokument_id) ?? {}),
          vorbehalte: vorbehalte(nach.get(r.dokument_id) ?? {}),
        })),
      });
    },
  );

  server.registerTool(
    "versionen_auflisten",
    {
      title: "Fassungen auflisten",
      description:
        "Alle je erfassten Fassungen eines Dokuments. Mit der version_id lässt sich " +
        "über dokument_lesen eine ältere Fassung öffnen.",
      inputSchema: z.object({ id: z.string().describe("Dokument-ID") }),
      annotations: NUR_LESEN,
    },
    async ({ id }) => {
      const { results } = await env.DB.prepare(
        `SELECT id AS version_id, erfasst_am, bytes, hochgeladen_von, quelle_url
           FROM versionen WHERE dokument_id = ? ORDER BY erfasst_am DESC`,
      )
        .bind(id)
        .all();
      return alsJson({ dokument_id: id, fassungen: results });
    },
  );
}
