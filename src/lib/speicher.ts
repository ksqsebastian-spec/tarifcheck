import type { Env } from "./typen";

/** raw/<gewerk>/<dokument>/<stempel>.<endung> — die Originaldatei. */
export const rohSchluessel = (
  gewerk: string,
  dokumentId: string,
  stempel: string,
  endung: string,
): string => `raw/${gewerk}/${dokumentId}/${stempel}.${endung}`;

/** md/<gewerk>/<dokument>/<stempel>.md — die Textfassung derselben Fassung. */
export const textSchluessel = (
  gewerk: string,
  dokumentId: string,
  stempel: string,
): string => `md/${gewerk}/${dokumentId}/${stempel}.md`;

/**
 * Schreibt Daten nach R2 und gibt die Pruefsumme zurueck, die R2 selbst bildet.
 * Sie ist unsere Vergleichsbasis - wir rechnen bewusst nichts selbst durch.
 *
 * Bewusst gepuffert statt durchgereicht: R2 lehnt einen Datenstrom unbekannter
 * Laenge ab ("Provided readable stream must have a known length"), und
 * content-length ist dafuer kein verlaesslicher Indikator - der Wert beschreibt
 * die uebertragenen Bytes, waehrend die Laufzeit transparent entpackt. Der
 * Fehler trat entsprechend sprunghaft auf, mal bei diesen Quellen, mal bei
 * jenen.
 *
 * Kostet hier fast nichts: die Dateien sind wenige hundert kB, und bei einer
 * echten Aenderung braucht die Umwandlung die Bytes ohnehin im Speicher.
 */
export async function bytesSpeichern(
  env: Env,
  schluessel: string,
  inhalt: ArrayBuffer,
  typ: string,
): Promise<{ etag: string; bytes: number }> {
  const objekt = await env.R2.put(schluessel, inhalt, {
    httpMetadata: { contentType: typ },
  });
  if (!objekt) throw new Error(`R2 hat ${schluessel} nicht angenommen`);
  return { etag: objekt.etag, bytes: objekt.size };
}

export async function textSpeichern(
  env: Env,
  schluessel: string,
  inhalt: string,
): Promise<{ etag: string; bytes: number }> {
  const objekt = await env.R2.put(schluessel, inhalt, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  if (!objekt) throw new Error(`R2 hat ${schluessel} nicht angenommen`);
  return { etag: objekt.etag, bytes: objekt.size };
}

export async function textLesen(env: Env, schluessel: string): Promise<string | null> {
  const objekt = await env.R2.get(schluessel);
  return objekt ? await objekt.text() : null;
}

export async function bytesLesen(env: Env, schluessel: string): Promise<ArrayBuffer | null> {
  const objekt = await env.R2.get(schluessel);
  return objekt ? await objekt.arrayBuffer() : null;
}

export const verwerfen = (env: Env, schluessel: string): Promise<void> =>
  env.R2.delete(schluessel);
