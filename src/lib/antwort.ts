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
