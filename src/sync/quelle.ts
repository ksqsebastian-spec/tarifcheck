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
import { nachMarkdown, pdfLinks } from "./markdown";
import { datumsFunde } from "./datum";
import { pdfNachText, textAusbeute, textBrauchbar } from "./text";

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

/**
 * Holt eine Adresse und versucht es bei einer voruebergehenden Stoerung
 * genau einmal erneut.
 *
 * Anlass war ein echter Lauf: zoll.de antwortete mit HTTP 525, einem
 * fehlgeschlagenen TLS-Handshake. Der Link war in Ordnung, die Verbindung
 * hatte nur einen Aussetzer - das Dokument stand danach aber einen ganzen Tag
 * als Fehler da. Ein zweiter Versuch nach kurzer Pause kostet nichts und
 * erspart genau diese Sorte falscher Alarm.
 *
 * Nur bei Serverfehlern und Verbindungsabbruechen. Ein 404 wird nicht besser,
 * wenn man ihn zweimal holt.
 */
async function holenMitZweitversuch(
  url: string,
  kopfzeilen: Record<string, string>,
): Promise<Response> {
  const versuch = () => fetch(url, { headers: kopfzeilen, redirect: "follow" });

  let antwort: Response | null = null;
  let abbruch: unknown = null;
  try {
    antwort = await versuch();
    if (antwort.status < 500) return antwort;
  } catch (e) {
    abbruch = e;
  }

  await new Promise((r) => setTimeout(r, 3000));
  try {
    return await versuch();
  } catch (e) {
    // Beide Versuche gescheitert. Der erste Fehler ist meist der sprechendere.
    if (antwort) return antwort;
    throw abbruch ?? e;
  }
}

/**
 * Obergrenze fuer eine geholte Datei.
 *
 * Ein Worker hat 128 MB Arbeitsspeicher, und der Abruf haelt die Datei
 * zwangslaeufig ganz darin: R2 nimmt keinen Strom unbekannter Laenge, und die
 * Textgewinnung braucht die Bytes ohnehin am Stueck. Ohne Grenze genuegt es,
 * dass ein Herausgeber versehentlich ein Video oder ein Archiv unter die
 * bekannte Adresse legt - der Abruf stirbt dann am Speicher, und zwar mit
 * einer Meldung, aus der niemand die Ursache liest.
 *
 * 40 MB ist reichlich: das groesste Dokument hier misst 1,7 MB.
 */
const MAX_BYTES = 40 * 1024 * 1024;

/** Auf eine Nachkommastelle, sonst liest sich "40 MB (Grenze 40 MB)" wie ein Widerspruch. */
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const zuGross = (url: string, bytes: number): Error =>
  new Error(
    `Die Datei ist mit ${mb(bytes)} unerwartet groß (Grenze ${mb(MAX_BYTES)}). ` +
      `Vermutlich liegt unter der Adresse nicht mehr das Dokument, sondern etwas ` +
      `anderes. Bitte nachsehen: ${url}`,
  );

/**
 * Liest den Koerper und bricht ab, sobald die Grenze reisst.
 *
 * Die Kopfzeile content-length allein genuegt nicht: sie fehlt bei
 * Stueckantworten ganz und beschreibt sonst die uebertragenen, also womoeglich
 * komprimierten Bytes. Deshalb wird zusaetzlich beim Lesen mitgezaehlt.
 */
async function bytesMitGrenze(antwort: Response, url: string): Promise<ArrayBuffer> {
  const angekuendigt = Number(antwort.headers.get("content-length") ?? 0);
  if (angekuendigt > MAX_BYTES) throw zuGross(url, angekuendigt);

  const leser = antwort.body?.getReader();
  if (!leser) throw new Error("Die Antwort hatte keinen Inhalt");

  const teile: Uint8Array[] = [];
  let gesamt = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    gesamt += value.byteLength;
    if (gesamt > MAX_BYTES) {
      await leser.cancel();
      throw zuGross(url, gesamt);
    }
    teile.push(value);
  }

  const alles = new Uint8Array(gesamt);
  let pos = 0;
  for (const t of teile) {
    alles.set(t, pos);
    pos += t.byteLength;
  }
  return alles.buffer;
}

/** Dasselbe fuer beobachtete Seiten, die als Text gelesen werden. */
async function textMitGrenze(antwort: Response, url: string): Promise<string> {
  return new TextDecoder().decode(await bytesMitGrenze(antwort, url));
}

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
    datumFunde: string | null;
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
          http_etag, http_last_modified, quelle_url, text_zeichen, text_brauchbar,
          datum_funde)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      daten.datumFunde,
    ),
    env.DB.prepare("UPDATE dokumente SET aktuelle_version_id = ? WHERE id = ?").bind(
      versionId,
      dokument.id,
    ),
  ]);
  return versionId;
}

/**
 * Was der Fehler bedeutet - und was zu tun ist.
 *
 * Vorher stand unter jedem Fehler derselbe Satz "meist hat der Betreiber seine
 * Seite umgebaut, Adresse korrigieren". Bei einem TLS-Aussetzer schickt das
 * jemanden auf die Suche nach einer neuen Adresse, obwohl die alte stimmt.
 * Ein Rat, der nicht zur Lage passt, kostet mehr Zeit als gar keiner.
 */
function rat(fehler: string): string {
  const code = Number(/HTTP (\d{3})/.exec(fehler)?.[1] ?? 0);

  if (code === 404 || code === 410)
    return (
      "Die Adresse gibt es nicht mehr — der Herausgeber hat vermutlich umgebaut. " +
      'Bitte unter "Quellen" die neue Adresse eintragen.'
    );
  if (code === 401 || code === 403)
    return (
      "Der Herausgeber weist den Abruf ab. Entweder liegt das Dokument jetzt hinter " +
      "einer Anmeldung, oder er sperrt automatische Zugriffe. Dann bleibt nur, es " +
      "von Hand herunterzuladen und hier hochzuladen."
    );
  if (code >= 500 || code === 0)
    return (
      "Die Quelle war vorübergehend nicht erreichbar — ein zweiter Versuch ist " +
      "bereits gescheitert. Der nächste tägliche Lauf versucht es erneut; meist " +
      "erledigt sich das von selbst. Der bisherige Inhalt bleibt unverändert " +
      "verfügbar, kann aber veralten."
    );
  return (
    'Bitte die Adresse unter "Quellen" prüfen. Der bisherige Inhalt bleibt ' +
    "verfügbar, kann aber veralten."
  );
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
      beschreibung: `${text}\n\nQuelle: ${quelle.url}\n\n${rat(text)}`,
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

  const antwort = await holenMitZweitversuch(quelle.url, bedingt(vorher));

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
  const roh = await bytesMitGrenze(antwort, quelle.url);
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

  // Echte Aenderung. Erst jetzt Text gewinnen.
  const mdKey = textSchluessel(dokument.gewerk, dokument.id, zeit);
  let markdown: string;
  try {
    markdown = await pdfNachText(roh, dokument.titel);

    // Kommt dabei fast nichts heraus, ist es vermutlich ein Scan ohne
    // Textebene. Dann noch die KI-Umwandlung versuchen: sie beschreibt
    // Bilder und holt aus einem Scan manchmal doch etwas heraus.
    if (!textBrauchbar(textAusbeute(markdown), bytes, true)) {
      try {
        const zweiterVersuch = await nachMarkdown(env, quelle.dateiname, roh);
        if (textAusbeute(zweiterVersuch) > textAusbeute(markdown)) {
          markdown = zweiterVersuch;
        }
      } catch {
        // Der erste Weg bleibt stehen. Dass er duenn ist, meldet die Pruefung
        // weiter unten ohnehin.
      }
    }

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
    datumFunde: JSON.stringify(datumsFunde(markdown)),
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

  // Derselbe Zweitversuch wie beim Dateiabruf. Dass er hier zuerst fehlte, war
  // keine Absicht, sondern ein Versehen: der TLS-Aussetzer, der ihn ausgeloest
  // hat, trifft eine beobachtete Seite genauso.
  const antwort = await holenMitZweitversuch(quelle.url, KOPFZEILEN);
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status} ${antwort.statusText}`);

  const html = await textMitGrenze(antwort, quelle.url);
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
    // Bei beobachteten Seiten waeren Datumsangaben die der verlinkten
    // Dokumente, nicht die der Seite. Das waere irrefuehrend.
    datumFunde: null,
  });

  await volltextSetzen(env, dokument, markdown);
  await pruefungVermerken(env, dokument.id, "ok");

  const erstmalig = !vorher;
  if (erstmalig) {
    // Auch die erste Erfassung melden - sonst taucht eine beobachtete Seite
    // nirgends auf, waehrend jeder heruntergeladene Vertrag es tut.
    await meldungAnlegen(env, {
      art: "neu",
      gewerk: dokument.gewerk,
      dokumentId: dokument.id,
      titel: `Neu aufgenommen: ${dokument.titel}`,
      beschreibung:
        `Beobachtete Seite, erstmals erfasst. Ab jetzt wird gemeldet, wenn sich ` +
        `ihr Inhalt ändert.` + (quelle.hinweis ? `\n\n${quelle.hinweis}` : ""),
    });
  } else {
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
