import { fehler, json } from "../lib/antwort";
import { angemeldeteAdresse } from "../auth/zugriff";
import { meldungAnlegen, volltextSetzen } from "../lib/db";
import { rohSchluessel, textSchluessel, textSpeichern } from "../lib/speicher";
import type { Env } from "../lib/typen";
import { alleQuellenAnstossen } from "../sync/cron";
import { nachMarkdown } from "../sync/markdown";
import { pdfNachText, textAusbeute, textBrauchbar } from "../sync/text";
import { jetzt, stempel } from "../lib/zeit";

const abgelehnt = () =>
  fehler(
    "Nicht angemeldet. Schreibende Zugriffe verlangen ein gültiges Token von " +
      "Cloudflare Access. Ist Access für diese Adresse noch nicht eingerichtet, " +
      "bleibt hier absichtlich alles gesperrt — siehe SETUP.md, Schritt 5.",
    403,
  );

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Uebersicht je Gewerk fuer die Startseite.
 * Rot schlaegt gelb schlaegt gruen - der schlechteste Stand bestimmt die Farbe,
 * damit ein Fehler nicht hinter vierzehn gruenen Haken verschwindet.
 */
async function uebersicht(env: Env): Promise<Response> {
  // ohne_inhalt zaehlt auch Dokumente, deren Datei zwar vorliegt, aus der sich
  // aber kein Text gewinnen liess. Sonst stuende hier "aktuell" fuer ein
  // Gewerk, dessen Vertrag in Wahrheit unlesbar ist.
  const gewerke = await env.DB.prepare(
    `SELECT d.gewerk,
            COUNT(*)                                                     AS dokumente,
            SUM(CASE WHEN d.letzter_status = 'fehler' THEN 1 ELSE 0 END) AS fehler,
            SUM(CASE WHEN d.aktuelle_version_id IS NULL
                       OR COALESCE(v.text_brauchbar, 1) = 0
                     THEN 1 ELSE 0 END)                                  AS ohne_inhalt,
            MAX(d.letzte_pruefung)                                       AS letzte_pruefung
       FROM dokumente d
       LEFT JOIN versionen v ON v.id = d.aktuelle_version_id
      GROUP BY d.gewerk
      ORDER BY d.gewerk`,
  ).all();

  const ungelesen = await env.DB.prepare(
    "SELECT COUNT(*) AS anzahl FROM meldungen WHERE gelesen = 0",
  ).first<{ anzahl: number }>();

  // Ein Gewerk gilt als "Handlungsbedarf", wenn dort eine ungelesene Meldung
  // liegt, die eine Handbewegung verlangt.
  const offen = await env.DB.prepare(
    `SELECT DISTINCT gewerk FROM meldungen
      WHERE gelesen = 0 AND art IN ('seite_geaendert', 'geaendert', 'neuer_link')`,
  ).all<{ gewerk: string }>();
  const handlungsbedarf = new Set(offen.results.map((r) => r.gewerk));

  return json({
    gewerke: gewerke.results.map((g: any) => ({
      ...g,
      status:
        Number(g.fehler) > 0
          ? "fehler"
          : handlungsbedarf.has(g.gewerk) || Number(g.ohne_inhalt) > 0
            ? "handlungsbedarf"
            : "aktuell",
    })),
    ungelesen: ungelesen?.anzahl ?? 0,
  });
}

async function dokumente(env: Env, url: URL): Promise<Response> {
  const gewerk = url.searchParams.get("gewerk");
  const abfrage = `
    SELECT d.*, q.url AS quelle_url, q.typ AS quelle_typ, v.erfasst_am AS stand,
           v.bytes AS stand_bytes, v.text_zeichen, v.text_brauchbar
      FROM dokumente d
      LEFT JOIN quellen  q ON q.id = d.quelle_id
      LEFT JOIN versionen v ON v.id = d.aktuelle_version_id
     ${gewerk ? "WHERE d.gewerk = ?" : ""}
     ORDER BY d.gewerk, d.titel`;

  const stmt = gewerk
    ? env.DB.prepare(abfrage).bind(gewerk)
    : env.DB.prepare(abfrage);
  const { results } = await stmt.all();
  return json({ dokumente: results });
}

async function dokumentDetail(env: Env, id: string): Promise<Response> {
  const dok = await env.DB.prepare(
    `SELECT d.*, q.url AS quelle_url, q.typ AS quelle_typ, q.firmen
       FROM dokumente d LEFT JOIN quellen q ON q.id = d.quelle_id
      WHERE d.id = ?`,
  )
    .bind(id)
    .first();
  if (!dok) return fehler("Dokument nicht gefunden", 404);

  const versionen = await env.DB.prepare(
    `SELECT id, erfasst_am, bytes, hochgeladen_von, quelle_url
       FROM versionen WHERE dokument_id = ? ORDER BY erfasst_am DESC`,
  )
    .bind(id)
    .all();

  return json({ dokument: dok, versionen: versionen.results });
}

async function meldungen(env: Env, url: URL): Promise<Response> {
  const nurUngelesen = url.searchParams.get("ungelesen") === "1";
  const grenze = Math.min(Number(url.searchParams.get("limit") ?? 100), 300);

  const { results } = await env.DB.prepare(
    `SELECT m.*, d.titel AS dokument_titel
       FROM meldungen m LEFT JOIN dokumente d ON d.id = m.dokument_id
      ${nurUngelesen ? "WHERE m.gelesen = 0" : ""}
      ORDER BY m.gelesen ASC, m.zeitpunkt DESC
      LIMIT ?`,
  )
    .bind(grenze)
    .all();

  return json({ meldungen: results });
}

async function meldungenGelesen(env: Env, request: Request): Promise<Response> {
  const koerper = await request.json<{ ids?: number[]; alle?: boolean }>();

  if (koerper.alle) {
    await env.DB.prepare("UPDATE meldungen SET gelesen = 1 WHERE gelesen = 0").run();
    return json({ ok: true });
  }
  if (!koerper.ids?.length) return fehler("Weder ids noch alle angegeben");

  const platzhalter = koerper.ids.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE meldungen SET gelesen = 1 WHERE id IN (${platzhalter})`)
    .bind(...koerper.ids)
    .run();
  return json({ ok: true });
}

/**
 * Upload von Hand.
 *
 * Das ist der Weg fuer alles, was es nicht frei im Netz gibt - Tischler und
 * Lohn-TV Geruestbau. Die Datei laeuft durch dieselbe Umwandlung wie die
 * automatisch geholten und ist danach fuer den MCP gleichwertig.
 */
async function hochladen(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const datei = form.get("datei");
  if (!(datei instanceof File)) return fehler("Keine Datei angehängt");

  const gewerk = String(form.get("gewerk") ?? "").trim().toUpperCase();
  const titel = String(form.get("titel") ?? "").trim();
  const gueltigAb = String(form.get("gueltig_ab") ?? "").trim() || null;
  const vorhandenesDokument = String(form.get("dokument_id") ?? "").trim() || null;

  if (!gewerk) return fehler("Gewerk fehlt");
  if (!titel && !vorhandenesDokument) return fehler("Titel fehlt");

  const wer = (await angemeldeteAdresse(request, env)) ?? "unbekannt";
  const zeit = stempel();

  let dokumentId = vorhandenesDokument;
  let neuAngelegt = false;

  if (dokumentId) {
    const vorhanden = await env.DB.prepare("SELECT id FROM dokumente WHERE id = ?")
      .bind(dokumentId)
      .first();
    if (!vorhanden) return fehler("Dokument nicht gefunden", 404);
  } else {
    // Kurzer Zufallsanteil, damit zwei gleich benannte Uploads sich nicht
    // gegenseitig ueberschreiben.
    dokumentId = `${slug(gewerk)}-${slug(titel)}-${crypto.randomUUID().slice(0, 6)}`;
    neuAngelegt = true;
    await env.DB.prepare(
      `INSERT INTO dokumente (id, quelle_id, gewerk, kuerzel, titel, herkunft,
                              gueltig_ab, erstellt_am)
       VALUES (?, NULL, ?, ?, ?, 'manuell', ?, ?)`,
    )
      .bind(dokumentId, gewerk, slug(titel).toUpperCase().slice(0, 20), titel, gueltigAb, jetzt())
      .run();
  }

  const rohBytes = await datei.arrayBuffer();
  const endung = datei.name.split(".").pop()?.toLowerCase() ?? "pdf";
  const rawKey = rohSchluessel(gewerk, dokumentId, zeit, endung);

  const objekt = await env.R2.put(rawKey, rohBytes, {
    httpMetadata: { contentType: datei.type || "application/octet-stream" },
  });
  if (!objekt) return fehler("Datei konnte nicht gespeichert werden", 500);

  const istPdf =
    datei.type === "application/pdf" || datei.name.toLowerCase().endsWith(".pdf");

  let markdown: string;
  try {
    // PDFs ueber pdf.js, alles andere (Word, HTML, Bilder) ueber die
    // KI-Umwandlung - die kann Formate, die pdf.js nicht kennt.
    markdown = istPdf
      ? await pdfNachText(rohBytes, titel || datei.name)
      : await nachMarkdown(env, datei.name, rohBytes);
  } catch (e) {
    // Die Datei ist gespeichert, nur die Umwandlung ging schief. Aufraeumen
    // und ehrlich melden, statt eine halbe Version stehen zu lassen.
    await env.R2.delete(rawKey);
    if (neuAngelegt) {
      await env.DB.prepare("DELETE FROM dokumente WHERE id = ?").bind(dokumentId).run();
    }
    return fehler(
      `Die Datei ließ sich nicht in Text umwandeln: ${e instanceof Error ? e.message : e}`,
      422,
    );
  }

  const mdKey = textSchluessel(gewerk, dokumentId, zeit);
  await textSpeichern(env, mdKey, markdown);

  const versionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO versionen
         (id, dokument_id, erfasst_am, r2_raw_key, r2_md_key, bytes, etag,
          hochgeladen_von, text_zeichen, text_brauchbar)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(versionId, dokumentId, jetzt(), rawKey, mdKey, objekt.size, objekt.etag, wer,
           textAusbeute(markdown),
           textBrauchbar(textAusbeute(markdown), objekt.size, true) ? 1 : 0),
    env.DB.prepare(
      `UPDATE dokumente
          SET aktuelle_version_id = ?, letzte_pruefung = ?, letzter_status = 'ok',
              letzter_fehler = NULL
        WHERE id = ?`,
    ).bind(versionId, jetzt(), dokumentId),
  ]);

  const dok = await env.DB.prepare("SELECT id, gewerk, titel FROM dokumente WHERE id = ?")
    .bind(dokumentId)
    .first<{ id: string; gewerk: string; titel: string }>();
  if (dok) await volltextSetzen(env, dok, markdown);

  await meldungAnlegen(env, {
    art: "upload",
    gewerk,
    dokumentId,
    titel: `Hochgeladen: ${dok?.titel ?? titel}`,
    beschreibung:
      `${datei.name} (${Math.round(objekt.size / 1024)} kB), hochgeladen von ${wer}.` +
      (gueltigAb ? `\nGültig ab ${gueltigAb}.` : ""),
  });

  const ausbeute = textAusbeute(markdown);
  const brauchbar = textBrauchbar(ausbeute, objekt.size, true);
  if (!brauchbar) {
    await meldungAnlegen(env, {
      art: "fehler",
      gewerk,
      dokumentId,
      titel: `Kein Text gewinnbar: ${dok?.titel ?? titel}`,
      beschreibung:
        `Die Datei ist gespeichert, aber es ließen sich nur ${ausbeute} Zeichen Text ` +
        `gewinnen. Meist ist das ein Scan ohne Texterkennung. Sie taucht damit in ` +
        `der Suche nicht auf — besser eine durchsuchbare Fassung hochladen.`,
    });
  }

  return json({
    ok: true,
    dokument_id: dokumentId,
    version_id: versionId,
    text_zeichen: ausbeute,
    ...(!brauchbar
      ? { warnung: "Aus dieser Datei ließ sich kaum Text gewinnen — vermutlich ein Scan ohne Texterkennung." }
      : {}),
  });
}

async function quellen(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT q.*, d.id AS dokument_id, d.letzter_status, d.letzte_pruefung, d.letzter_fehler
       FROM quellen q LEFT JOIN dokumente d ON d.quelle_id = q.id
      ORDER BY q.gewerk, q.kuerzel`,
  ).all();
  return json({ quellen: results });
}

/** Adresse nachziehen, wenn ein Betreiber seine Seite umgebaut hat. */
async function quelleAendern(env: Env, id: string, request: Request): Promise<Response> {
  const koerper = await request.json<{ url?: string; aktiv?: boolean }>();
  const setzen: string[] = [];
  const werte: unknown[] = [];

  if (koerper.url !== undefined) {
    try {
      new URL(koerper.url);
    } catch {
      return fehler("Das ist keine gültige Adresse");
    }
    setzen.push("url = ?");
    werte.push(koerper.url);
  }
  if (koerper.aktiv !== undefined) {
    setzen.push("aktiv = ?");
    werte.push(koerper.aktiv ? 1 : 0);
  }
  if (!setzen.length) return fehler("Nichts zu ändern");

  werte.push(id);
  const ergebnis = await env.DB.prepare(
    `UPDATE quellen SET ${setzen.join(", ")} WHERE id = ?`,
  )
    .bind(...werte)
    .run();

  if (!ergebnis.meta.changes) return fehler("Quelle nicht gefunden", 404);

  // Nach einer Korrektur soll der Fehler nicht rot stehen bleiben, bis der
  // naechste Cron laeuft.
  if (koerper.url !== undefined) {
    await env.DB.prepare(
      "UPDATE dokumente SET letzter_fehler = NULL WHERE quelle_id = ? AND letzter_status = 'fehler'",
    )
      .bind(id)
      .run();
  }
  return json({ ok: true });
}

export async function apiRouten(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/uebersicht" && m === "GET") return uebersicht(env);
  if (p === "/api/dokumente" && m === "GET") return dokumente(env, url);
  if (p.startsWith("/api/dokumente/") && m === "GET")
    return dokumentDetail(env, decodeURIComponent(p.slice("/api/dokumente/".length)));

  if (p === "/api/meldungen" && m === "GET") return meldungen(env, url);

  if (p === "/api/quellen" && m === "GET") return quellen(env);

  /**
   * Sagt der Oberflaeche, was sie anbieten darf.
   *
   * Ohne das zeigt die Seite Knoepfe, die nicht funktionieren koennen, und
   * antwortet auf jeden Druck mit einer roten Fehlermeldung - fuer einen
   * Zustand, der voellig erwartbar ist, solange Access noch nicht steht.
   */
  if (p === "/api/status" && m === "GET") {
    const wer = await angemeldeteAdresse(request, env);
    return json({
      angemeldet: wer,
      schreiben: Boolean(wer),
      access_eingerichtet: Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
    });
  }

  // Ab hier wird geschrieben. Ohne gueltiges Access-Token geht nichts.
  const schreiben = await angemeldeteAdresse(request, env);
  if (!schreiben) return abgelehnt();

  if (p === "/api/meldungen/gelesen" && m === "POST") return meldungenGelesen(env, request);
  if (p === "/api/upload" && m === "POST") return hochladen(env, request);

  if (p.startsWith("/api/quellen/") && m === "PATCH")
    return quelleAendern(env, decodeURIComponent(p.slice("/api/quellen/".length)), request);

  if (p === "/api/sync" && m === "POST") {
    const koerper = await request.json<{ quellen?: string[] }>().catch(() => ({}) as any);
    const ergebnisse = await alleQuellenAnstossen(env, koerper.quellen);
    return json({ ergebnisse });
  }

  return null;
}
