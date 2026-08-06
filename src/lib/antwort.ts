/** Kleine Helfer fuer JSON-Antworten. Kein Framework noetig. */

export const json = (daten: unknown, status = 200): Response =>
  new Response(JSON.stringify(daten), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export const fehler = (nachricht: string, status = 400): Response =>
  json({ fehler: nachricht }, status);

/**
 * Mailadresse des Angemeldeten, nur zur Anzeige (etwa "hochgeladen von").
 * Fuer Zugriffsentscheidungen ist ausschliesslich angemeldeteAdresse() aus
 * auth/zugriff.ts zustaendig - diese Kopfzeile allein ist faelschbar.
 */
export const angemeldetAls = (request: Request): string | null =>
  request.headers.get("cf-access-authenticated-user-email");
