import type { Env } from "../lib/typen";

/**
 * Wandelt eine Datei in Markdown um.
 *
 * Die Arbeit passiert in Workers AI, nicht im Worker - der Aufruf kostet uns
 * also fast keine Rechenzeit. Das ist der Grund, warum die Umwandlung im
 * Free-Plan ueberhaupt geht.
 */
export async function nachMarkdown(
  env: Env,
  name: string,
  daten: ArrayBuffer | string,
  optionen?: { cssSelector?: string; hostname?: string },
): Promise<string> {
  const blob =
    typeof daten === "string"
      ? new Blob([daten], { type: "text/html" })
      : new Blob([daten], { type: "application/octet-stream" });

  const konvertierung: Record<string, unknown> = {};
  if (optionen?.cssSelector || optionen?.hostname) {
    konvertierung.html = {
      ...(optionen.cssSelector ? { cssSelector: optionen.cssSelector } : {}),
      ...(optionen.hostname ? { hostname: optionen.hostname } : {}),
    };
  }

  const ai = env.AI as unknown as {
    toMarkdown: (
      dateien: { name: string; blob: Blob },
      opts?: { conversionOptions?: Record<string, unknown> },
    ) => Promise<{ format: string; data?: string; error?: string }>;
  };

  const ergebnis = await ai.toMarkdown(
    { name, blob },
    Object.keys(konvertierung).length ? { conversionOptions: konvertierung } : undefined,
  );

  if (ergebnis.format === "error" || !ergebnis.data) {
    throw new Error(`Umwandlung fehlgeschlagen: ${ergebnis.error ?? "kein Inhalt"}`);
  }
  return ergebnis.data;
}

/**
 * Sammelt PDF-Links aus einer HTML-Seite.
 *
 * Fuer die beobachteten Seiten: aendert sich die Seite, wollen wir in der
 * Meldung sehen, welche Dokumente dort inzwischen verlinkt sind. Bei
 * Tischler Nord liegt alles hinter dem Login, da bleibt die Liste leer -
 * dann ist die Seitenaenderung selbst das Signal.
 */
export function pdfLinks(html: string, basis: string): string[] {
  const treffer = html.matchAll(/href\s*=\s*["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi);
  const gefunden = new Set<string>();
  for (const t of treffer) {
    try {
      gefunden.add(new URL(t[1], basis).toString());
    } catch {
      // Kaputte Adresse auf der Fremdseite - ueberspringen, nicht abbrechen.
    }
  }
  return [...gefunden].slice(0, 25);
}
