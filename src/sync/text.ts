import { extractText, getDocumentProxy } from "unpdf";

/**
 * Gewinnt den Text aus einem PDF.
 *
 * Bewusst mit pdf.js (ueber unpdf) statt mit der Markdown-Umwandlung von
 * Workers AI. Die scheiterte an drei von siebzehn Vertraegen - darunter der
 * BRTV - und meldete dabei keinen Fehler, sondern lieferte stillschweigend
 * nur Metadaten und leere Seitenmarken. Ein Dienst, dessen Zweck die
 * Durchsuchbarkeit ist, darf daran nicht scheitern, und schon gar nicht
 * unbemerkt.
 *
 * Der Preis ist Rechenzeit: der BRTV braucht rund 1,3 Sekunden. Deshalb setzt
 * dieser Weg Workers Paid und ein erhoehtes cpu_ms voraus (siehe
 * wrangler.jsonc). Bezahlt wird das mit Verlaesslichkeit: kein KI-Kontingent,
 * kein stiller Ausfall, und lokal pruefbar - was mit der KI-Umwandlung nicht
 * ging, weil die nur in der Cloud laeuft.
 *
 * Seitenmarken bleiben erhalten, damit eine Fundstelle benennbar ist.
 */
export async function pdfNachText(daten: ArrayBuffer, titel: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(daten));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const seiten = (Array.isArray(text) ? text : [String(text)])
    .map((s, i) => {
      const rein = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      return rein ? `## Seite ${i + 1}\n\n${rein}` : "";
    })
    .filter(Boolean);

  return `# ${titel}\n\n_${totalPages} Seiten_\n\n${seiten.join("\n\n")}\n`;
}

/** Misst den lesbaren Anteil - Ueberschriften und Seitenmarken zaehlen nicht. */
export function textAusbeute(markdown: string): number {
  return markdown
    .replace(/^#{1,6} .*$/gm, "")
    .replace(/^[-*_]\s*\w*=?.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Beurteilt, ob brauchbarer Text herauskam.
 *
 * Zwei Massstaebe, weil einer nicht reicht: eine feste Untergrenze uebersieht
 * Scans, die auf dem Deckblatt ein paar Zeilen tragen. Beim ersten
 * vollstaendigen Durchlauf lagen die misslungenen Umwandlungen bei 0 bis 1
 * Zeichen je kB, die schwaechste gelungene bei 58.
 *
 * Nur fuer heruntergeladene Dateien - bei beobachteten Seiten ist die
 * gemessene Groesse der Text selbst, das Verhaeltnis waere dort bedeutungslos.
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
