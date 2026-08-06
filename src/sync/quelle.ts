import {
  dokumentZuQuelle,
  letzteVersion,
  meldungAnlegen,
  pruefungVermerken,
  quelleLaden,
  volltextSetzen,
} from "../lib/db";
import {
  bytesSpeichern,
  rohSchluessel,
  textSchluessel,
  textSpeichern,
  verwerfen,
} from "../lib/speicher";
import type { Dokument, Env, SyncErgebnis, Version } from "../lib/typen";
import { jetzt, stempel } from "../lib/zeit";
import { nachMarkdown, pdfLinks, textAusbeute, textBrauchbar } from "./markdown";

/**
 * Manche Behoerdenseiten antworten auf Abrufe ohne erkennbaren Browser gar
 * nicht. Ein sprechender User-Agent ist hier auch die faire Variante:
 * der Betreiber sieht, wer da klopft.
 */
const KOPFZEILEN = {
  "user-agent":
    "Tarifcheck/1.0 (Gruppenwerk Tarifvertrags-Monitoring; +https://github.com/ksqsebastian-spec/tarifcheck)",
  accept: "*/*",
};

/**
 * Inhaltsbereiche der beobachteten Seiten. Ohne Selektor wuerden Navigation,
 * Cookie-Banner und Fussbereich bei jedem Abruf als Aenderung durchschlagen -
 * genau die Fehlalarme, vor denen das urspruengliche README warnt.
 * Greift der Selektor nicht, faellt die Umwandlung auf die ganze Seite zurueck.
 */
const INHALTSBEREICH: Record<string, string> = {
  "TISCHLER/TISCHLER-NORD": "main",
  "GERUESTBAU/BUNDESINNUNG": "main",
  "MALER/MALERKASSE": "main",
};

const endungAus = (dateiname: string): string =>
  dateiname.split(".").pop()?.toLowerCase() ?? "pdf";

/** Bedingte Kopfzeilen aus der letzten Fassung. Ein 304 kostet uns fast nichts. */
function bedingt(vorher: Version | null): Record<string, string> {
  const h: Record<string, string> = { ...KOPFZEILEN };
  if (vorher?.http_etag) h["if-none-match"] = vorher.http_etag;
  if (vorher?.http_last_modified) h["if-modified-since"] = vorher.http_last_modified;
  return h;
}

async function versionAnlegen(
  env: Env,
  dokument: Dokument,
  daten: {
    rawKey: string | null;
    mdKey: string;
    bytes: number;
    etag: string;
    textZeichen: number;
    textBrauchbar: boolean;
    httpEtag: string | null;
    httpLastModified: string | null;
    quelleUrl: string;
  },
): Promise<string> {
  const versionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO versionen
         (id, dokument_id, erfasst_am, r2_raw_key, r2_md_key, bytes, etag,
          http_etag, http_last_modified, quelle_url, text_zeichen, text_brauchbar)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId,
      dokument.id,
      jetzt(),
      daten.rawKey,
      daten.mdKey,
      daten.bytes,
      daten.etag,
      daten.httpEtag,
      daten.httpLastModified,
      daten.quelleUrl,
      daten.textZeichen,
      daten.textBrauchbar ? 1 : 0,
    ),
    env.DB.prepare("UPDATE dokumente SET aktuelle_version_id = ? WHERE id = ?").bind(
      versionId,
      dokument.id,
    ),
  ]);
  return versionId;
}

/**
 * Eine Quelle abarbeiten. Laeuft in einem eigenen Aufruf, damit sie ihr
 * eigenes Rechenzeit-Budget hat und ein Fehler die anderen nicht mitreisst.
 */
export async function quelleAbrufen(env: Env, quelleId: string): Promise<SyncErgebnis> {
  const quelle = await quelleLaden(env, quelleId);
  if (!quelle) throw new Error(`Quelle ${quelleId} gibt es nicht`);

  const dokument = await dokumentZuQuelle(env, quelleId);
  if (!dokument) throw new Error(`Zu ${quelleId} fehlt das Dokument`);

  try {
    return quelle.typ === "watch"
      ? await seiteBeobachten(env, quelle, dokument)
      : await dateiHolen(env, quelle, dokument);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    await pruefungVermerken(env, dokument.id, "fehler", text);
    await meldungAnlegen(env, {
      art: "fehler",
      gewerk: dokument.gewerk,
      dokumentId: dokument.id,
      titel: `Abruf fehlgeschlagen: ${dokument.titel}`,
      beschreibung:
        `${text}\n\nQuelle: ${quelle.url}\n\n` +
        `Meist hat der Betreiber seine Seite umgebaut. Die Adresse lässt sich ` +
        `unter "Quellen" korrigieren.`,
    });
    return { dokument_id: dokument.id, status: "fehler", meldung: text };
  }
}

/** Direkter Download (typ = pdf). */
async function dateiHolen(
  env: Env,
  quelle: { id: string; url: string; dateiname: string },
  dokument: Dokument,
): Promise<SyncErgebnis> {
  const vorher = await letzteVersion(env, dokument.id);

  const antwort = await fetch(quelle.url, { headers: bedingt(vorher), redirect: "follow" });

  // Der Server sagt selbst, dass sich nichts geaendert hat. Billigster Fall.
  if (antwort.status === 304) {
    await pruefungVermerken(env, dokument.id, "unveraendert");
    return { dokument_id: dokument.id, status: "unveraendert" };
  }
  if (!antwort.ok || !antwort.body) {
    throw new Error(`HTTP ${antwort.status} ${antwort.statusText}`);
  }

  const zeit = stempel();
  const rawKey = rohSchluessel(
    dokument.gewerk,
    dokument.id,
    zeit,
    endungAus(quelle.dateiname),
  );

  // Einmal in den Speicher holen und von dort aus weiterverwenden: fuer R2 und,
  // falls sich etwas geaendert hat, gleich fuer die Umwandlung.
  const roh = await antwort.arrayBuffer();
  const { etag, bytes } = await bytesSpeichern(
    env,
    rawKey,
    roh,
    antwort.headers.get("content-type") ?? "application/pdf",
  );

  const httpEtag = antwort.headers.get("etag");
  const httpLastModified = antwort.headers.get("last-modified");

  // Gleiche Pruefsumme wie zuletzt: der Server hat kein 304 geschickt,
  // die Datei ist aber dieselbe. Wieder wegwerfen.
  if (vorher?.etag && vorher.etag === etag) {
    await verwerfen(env, rawKey);
    // Validatoren nachziehen, damit der naechste Abruf vielleicht ein 304 bekommt.
    await env.DB.prepare(
      "UPDATE versionen SET http_etag = ?, http_last_modified = ? WHERE id = ?",
    )
      .bind(httpEtag, httpLastModified, vorher.id)
      .run();
    await pruefungVermerken(env, dokument.id, "unveraendert");
    return { dokument_id: dokument.id, status: "unveraendert" };
  }

  // Echte Aenderung. Erst jetzt umwandeln - das spart das KI-Kontingent.
  const mdKey = textSchluessel(dokument.gewerk, dokument.id, zeit);
  let markdown: string;
  try {
    markdown = await nachMarkdown(env, quelle.dateiname, roh);
    await textSpeichern(env, mdKey, markdown);
  } catch (e) {
    // Die Datei liegt schon in R2, aber es wird keine Version auf sie zeigen.
    // Ohne Aufraeumen bliebe bei jedem fehlgeschlagenen Versuch eine
    // verwaiste Datei liegen - taeglich eine, solange der Fehler besteht.
    await verwerfen(env, rawKey);
    throw e;
  }

  const ausbeute = textAusbeute(markdown);
  const brauchbar = textBrauchbar(ausbeute, bytes, true);
  const versionId = await versionAnlegen(env, dokument, {
    rawKey,
    mdKey,
    bytes,
    etag,
    httpEtag,
    httpLastModified,
    quelleUrl: quelle.url,
    textZeichen: ausbeute,
    textBrauchbar: brauchbar,
  });

  await volltextSetzen(env, dokument, markdown);
  await pruefungVermerken(env, dokument.id, "ok");

  // Die Umwandlung meldet keinen Fehler, wenn sie nichts findet. Ohne diese
  // Meldung stuende das Dokument als vorhanden da und waere doch leer.
  if (!brauchbar) {
    await meldungAnlegen(env, {
      art: "fehler",
      gewerk: dokument.gewerk,
      dokumentId: dokument.id,
      titel: `Kein Text gewinnbar: ${dokument.titel}`,
      beschreibung:
        `Die Datei wurde geholt (${Math.round(bytes / 1024)} kB), aber aus dem PDF ` +
        `ließ sich kein Text gewinnen — es kamen nur ${ausbeute} Zeichen heraus.\n\n` +
        `Das Dokument taucht deshalb in der Suche nicht auf, und der MCP weist ` +
        `darauf hin. Abhilfe: eine andere Quelle für denselben Vertrag nutzen ` +
        `(oft hat die Zoll-Fassung Text) oder eine durchsuchbare Fassung hochladen.\n\n` +
        `Quelle: ${quelle.url}`,
    });
  }

  const erstmalig = !vorher;
  await meldungAnlegen(env, {
    art: erstmalig ? "neu" : "geaendert",
    gewerk: dokument.gewerk,
    dokumentId: dokument.id,
    titel: erstmalig
      ? `Neu aufgenommen: ${dokument.titel}`
      : `Geändert: ${dokument.titel}`,
    beschreibung: erstmalig
      ? `Erstmals abgerufen (${Math.round(bytes / 1024)} kB).`
      : `Die Datei bei der Quelle unterscheidet sich von der bisherigen Fassung ` +
        `(${Math.round(bytes / 1024)} kB). Die alte Fassung bleibt erhalten.\n\n` +
        `Bitte das Gültigkeitsdatum im Dokument prüfen.`,
  });

  return { dokument_id: dokument.id, status: "ok", version_id: versionId };
}

/**
 * Beobachtete Seite (typ = watch).
 *
 * Verglichen wird die Textfassung des Inhaltsbereichs, nicht das rohe HTML.
 * Damit schlagen Layout- und Bannerwechsel nicht mehr als Aenderung durch.
 */
async function seiteBeobachten(
  env: Env,
  quelle: { id: string; url: string; dateiname: string; hinweis: string | null },
  dokument: Dokument,
): Promise<SyncErgebnis> {
  const vorher = await letzteVersion(env, dokument.id);

  const antwort = await fetch(quelle.url, { headers: KOPFZEILEN, redirect: "follow" });
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status} ${antwort.statusText}`);

  const html = await antwort.text();
  const basis = new URL(quelle.url);

  let markdown: string;
  try {
    markdown = await nachMarkdown(env, "seite.html", html, {
      cssSelector: INHALTSBEREICH[quelle.id],
      hostname: basis.hostname,
    });
  } catch {
    // Selektor greift nicht mehr, weil die Seite umgebaut wurde.
    // Lieber die ganze Seite vergleichen als den Abruf verlieren.
    markdown = await nachMarkdown(env, "seite.html", html, { hostname: basis.hostname });
  }

  const zeit = stempel();
  const mdKey = textSchluessel(dokument.gewerk, dokument.id, zeit);
  const { etag, bytes } = await textSpeichern(env, mdKey, markdown);

  if (vorher?.etag && vorher.etag === etag) {
    await verwerfen(env, mdKey);
    await pruefungVermerken(env, dokument.id, "unveraendert");
    return { dokument_id: dokument.id, status: "unveraendert" };
  }

  const versionId = await versionAnlegen(env, dokument, {
    rawKey: null,
    mdKey,
    bytes,
    etag,
    httpEtag: antwort.headers.get("etag"),
    httpLastModified: antwort.headers.get("last-modified"),
    quelleUrl: quelle.url,
    textZeichen: textAusbeute(markdown),
    textBrauchbar: textBrauchbar(textAusbeute(markdown), bytes, false),
  });

  await volltextSetzen(env, dokument, markdown);
  await pruefungVermerken(env, dokument.id, "ok");

  const erstmalig = !vorher;
  if (!erstmalig) {
    const links = pdfLinks(html, quelle.url);
    await meldungAnlegen(env, {
      art: "seite_geaendert",
      gewerk: dokument.gewerk,
      dokumentId: dokument.id,
      titel: `Seite geändert: ${dokument.titel}`,
      beschreibung:
        `Der Inhalt der überwachten Seite hat sich geändert.\n\n` +
        (quelle.hinweis ? `${quelle.hinweis}\n\n` : "") +
        `Seite: ${quelle.url}\n\n` +
        (links.length
          ? `Dort verlinkte PDF-Dateien:\n${links.map((l) => `- ${l}`).join("\n")}`
          : `Auf der Seite sind keine frei zugänglichen PDF-Links zu finden — ` +
            `der Volltext liegt vermutlich hinter dem Login. Bitte von Hand ` +
            `herunterladen und hier hochladen.`),
    });
  }

  return { dokument_id: dokument.id, status: "ok", version_id: versionId };
}
