/**
 * Findet Datumsangaben zur Geltung im Text eines Vertrags.
 *
 * Bewusst kein Raten: es wird nichts hergeleitet, sondern zitiert. Gefunden
 * wird, was im Dokument steht, samt umgebendem Satz - beurteilen muss es, wer
 * die Auskunft liest.
 *
 * Der Anlass: das gepflegte Feld `gueltig_ab` ist bei fast allen Dokumenten
 * leer, und der Vorbehalt "kein Gueltigkeitsdatum hinterlegt" erschien damit
 * bei jedem einzelnen Treffer. Ein Hinweis, der immer dasteht, wird
 * ueberlesen - er war Rauschen statt Warnung. Dabei steht das Datum meist
 * woertlich im Text.
 */

const MONATE: Record<string, number> = {
  januar: 1, februar: 2, "märz": 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

export type DatumsArt = "inkrafttreten" | "ausserkrafttreten" | "fassung" | "geltung";

export interface DatumsFund {
  datum: string;        // ISO, z.B. "2026-01-01"
  art: DatumsArt;
  fundstelle: string;   // der Satz, in dem es steht
}

/**
 * Deutet, was das Datum bedeutet - anhand des unmittelbaren Umfelds.
 *
 * Entscheidend ist der Text NACH dem Datum, denn im Deutschen steht dort die
 * Bestimmung: "tritt am 1. Januar 2026 in Kraft" gegen "tritt mit Ablauf des
 * 31. Dezember 2027 außer Kraft".
 *
 * Ein breites Fenster faellt hier herein: bei den Arbeitsbedingungenverordnungen
 * stehen beide Saetze direkt hintereinander. Ein Fenster von 110 Zeichen sah
 * beim Inkrafttreten noch das vorhergehende "außer Kraft" und stufte den
 * Beginn als Ablauf ein - eine Auskunft, die nicht bloss ungenau, sondern
 * verkehrt gewesen waere.
 */
function deuten(davor: string, danach: string): DatumsArt | null {
  const n = danach.toLowerCase();
  const v = davor.toLowerCase();

  // Was direkt hinter dem Datum steht, wiegt am schwersten.
  if (/^[^.;]{0,40}(außer|ausser)\s+kraft/.test(n)) return "ausserkrafttreten";
  if (/^[^.;]{0,40}in\s+kraft/.test(n)) return "inkrafttreten";

  // Sonst das, was unmittelbar davor steht.
  if (/mit ablauf des\s*$|bis\s+zum\s*$/.test(v)) return "ausserkrafttreten";
  // Wortgrenzen sind hier nicht kosmetisch: ohne sie las "(Eintritt bis
  // 31. Juli 2015)" im Rahmentarifvertrag Gerüstbau als Inkrafttreten.
  if (/\b(tritt|treten)\b[^.;]{0,25}$|\binkrafttreten\b[^.;]{0,40}$/.test(v))
    return "inkrafttreten";
  if (/(in der fassung|fassung)\s+vom\s*$|änderungstarifvertr[^.;]{0,40}$/.test(v))
    return "fassung";
  if (/(gilt|gültig|gueltig|wirkung|textnachweis)\s+ab\s*(dem\s*)?$/.test(v)) return "geltung";
  return null;
}

/** Bis hierhin gilt der Kopf des Dokuments. */
const KOPFBEREICH = 2500;

const iso = (t: number, m: number, j: number) =>
  `${j}-${String(m).padStart(2, "0")}-${String(t).padStart(2, "0")}`;

/** Ein Satz um die Fundstelle, zum Zitieren - nicht zum Deuten. */
function satzUm(text: string, pos: number, laenge: number): string {
  const von = Math.max(0, pos - 100);
  const bis = Math.min(text.length, pos + laenge + 60);
  return text.slice(von, bis).replace(/\s+/g, " ").trim();
}

export function datumsFunde(markdown: string, hoechstens = 4): DatumsFund[] {
  // Seitenmarken stoeren den Satzzusammenhang mehr, als sie helfen.
  const text = markdown.replace(/^#{1,6} .*$/gm, " ");

  const muster = [
    /(\d{1,2})\.\s*(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})/gi,
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/g,
  ];

  const funde = new Map<string, DatumsFund>();

  for (const [i, m] of muster.entries()) {
    for (const treffer of text.matchAll(m)) {
      const roh = treffer[0];
      const pos = treffer.index ?? 0;

      // Enge Fenster fuer die Deutung, weites nur fuers Zitat.
      const davor = text.slice(Math.max(0, pos - 60), pos).replace(/\s+/g, " ");
      const danach = text.slice(pos + roh.length, pos + roh.length + 45).replace(/\s+/g, " ");

      const art = deuten(davor, danach);
      if (!art) continue;

      // Die eigene Fassung steht im Kopf des Dokuments. Weiter hinten sind
      // "in der Fassung vom" fast immer Verweise auf ANDERE Abkommen - beim
      // BRTV etwa auf ein Rahmenabkommen von 1979. Die als Stand dieses
      // Vertrags auszugeben, waere irrefuehrend.
      if ((art === "fassung" || art === "geltung") && pos > KOPFBEREICH) continue;

      const tag = Number(treffer[1]);
      const monat = i === 0 ? MONATE[treffer[2].toLowerCase()] : Number(treffer[2]);
      const jahr = Number(treffer[3]);
      if (!monat || monat > 12 || tag > 31 || jahr < 1950 || jahr > 2100) continue;

      const schluessel = `${iso(tag, monat, jahr)}|${art}`;
      if (!funde.has(schluessel)) {
        funde.set(schluessel, { datum: iso(tag, monat, jahr), art, fundstelle: satzUm(text, pos, roh.length) });
      }
    }
  }

  // Inkrafttreten zuerst, dann Geltung, Fassung, zuletzt das Ablaufdatum.
  // Innerhalb einer Art das juengste Datum voran - das ist die aktuelle Fassung.
  const rang: Record<DatumsArt, number> = {
    inkrafttreten: 0, geltung: 1, fassung: 2, ausserkrafttreten: 3,
  };
  return [...funde.values()]
    .sort((a, b) => rang[a.art] - rang[b.art] || b.datum.localeCompare(a.datum))
    .slice(0, hoechstens);
}
