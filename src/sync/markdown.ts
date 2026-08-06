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
 * Misst, wieviel lesbarer Text nach der Umwandlung uebrig bleibt.
 *
 * Abgezogen werden Ueberschriften und die Metadatenzeilen, die die Umwandlung
 * immer voranstellt. Was dann noch dasteht, ist der eigentliche Inhalt.
 *
 * Der Grund: die Umwandlung kann stillschweigend leer ausgehen. Sie meldet
 * dann "format: markdown" ohne Fehler und liefert doch nur den Kopf und
 * "### Page 1", "### Page 2", ... ohne eine Zeile dazwischen. Genau das
 * passiert beim BRTV von SOKA-BAU. Ohne Messung wuerde das Dokument als
 * vorhanden gelten und im MCP als leerer Vertrag auftauchen.
 */
export function textAusbeute(markdown: string): number {
  return markdown
    .replace(/^#{1,6} .*$/gm, "")       // Ueberschriften, auch "### Page 12"
    .replace(/^[-*]\s*\w+=.*$/gm, "")   // Metadatenzeilen "- Author=..."
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Beurteilt, ob aus einer Datei brauchbarer Text gewonnen wurde.
 *
 * Zwei Massstaebe, weil einer nicht reicht. Eine feste Untergrenze uebersieht
 * Scans, die auf dem Deckblatt ein paar Zeilen Text tragen: die 12.
 * MalerArbbV kam auf 293 Zeichen - aus einem PDF von 311 kB.
 *
 * Darum zusaetzlich das Verhaeltnis. Beim ersten vollstaendigen Durchlauf
 * lagen die drei misslungenen Umwandlungen bei 0, 0 und 1 Zeichen je kB, das
 * schwaechste gelungene Dokument bei 58. Zwischen beiden Gruppen liegt Faktor
 * 58; eine Schwelle bei 10 trennt sie, ohne irgendwo knapp zu sein.
 *
 * Nur fuer heruntergeladene Dateien. Bei beobachteten Seiten ist die gemessene
 * Groesse der Text selbst, das Verhaeltnis waere dort bedeutungslos.
 */
export const AUSBEUTE_GRENZE = 200;
export const ZEICHEN_JE_KB_GRENZE = 10;

export function textBrauchbar(
  zeichen: number,
  bytes: number,
  heruntergeladen: boolean,
): boolean {
  if (zeichen < AUSBEUTE_GRENZE) return false;
  if (heruntergeladen && bytes > 0 && (zeichen * 1024) / bytes < ZEICHEN_JE_KB_GRENZE)
    return false;
  return true;
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
