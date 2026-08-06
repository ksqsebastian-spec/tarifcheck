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
 * Schreibt einen Datenstrom direkt nach R2, ohne ihn im Worker
 * zusammenzubauen. Das haelt die Rechenzeit unten - siehe PLAN.md Abschnitt 4.
 *
 * Der zurueckgegebene etag ist die MD5-Pruefsumme, die R2 selbst bildet.
 * Sie ist unsere Vergleichsbasis; wir rechnen bewusst nichts selbst durch.
 */
export async function stromSpeichern(
  env: Env,
  schluessel: string,
  koerper: ReadableStream,
  typ: string,
): Promise<{ etag: string; bytes: number }> {
  const objekt = await env.R2.put(schluessel, koerper, {
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
