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
 * Cloudflare Access setzt diesen Header, nachdem der Nutzer angemeldet ist.
 * Der Worker prueft die Anmeldung nicht selbst nach - das macht Access davor.
 * Hier wird nur ausgelesen, wer es war, um Uploads zuordnen zu koennen.
 */
export const angemeldetAls = (request: Request): string =>
  request.headers.get("cf-access-authenticated-user-email") ?? "unbekannt";
