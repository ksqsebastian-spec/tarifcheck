#!/usr/bin/env node
// Liest data/tarif-quellen.tsv und schreibt SQL nach stdout.
//
// Idempotent: mehrfaches Ausfuehren aktualisiert Quellen und legt fehlende
// Dokumente an, ohne bestehende Versionen oder Meldungen anzuruehren.
//
//   node scripts/seed-sources.mjs > .seed.sql
//   wrangler d1 execute tarifcheck --local --file=.seed.sql

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const wurzel = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsv = readFileSync(join(wurzel, "data/tarif-quellen.tsv"), "utf8");

// Lesbare Titel. Ohne die Tabelle stuende auf der Seite "Bau BRTV" statt
// etwas, das ein Betriebsleiter wiedererkennt.
const TITEL = {
  "UEBERGREIFEND/AVE-VERZEICHNIS": "BMAS-Verzeichnis der allgemeinverbindlichen Tarifverträge",
  "BAU/BRTV": "Bundesrahmentarifvertrag Bau (BRTV)",
  "BAU/VTV": "Tarifvertrag über das Sozialkassenverfahren (VTV)",
  "BAU/BBTV": "Berufsbildungstarifvertrag Bau (BBTV)",
  "BAU/TZA-BAU": "Tarifvertrag über eine zusätzliche Altersversorgung (TZA)",
  "BAU/TZR": "Tarifvertrag Zusatzrente Bau (TZR)",
  "BAU/BRTV-ZOLL": "BRTV Bau — AVE-Fassung der Generalzolldirektion",
  "BAU/VTV-ZOLL": "VTV Bau — AVE-Fassung der Generalzolldirektion",
  "GERUESTBAU/RTV": "Rahmentarifvertrag Gerüstbau (RTV)",
  "GERUESTBAU/ARBBV": "9. Gerüstbauer-Arbeitsbedingungenverordnung (Zoll)",
  "GERUESTBAU/ARBBV-GII": "9. Gerüstbauer-Arbeitsbedingungenverordnung (Gesetze im Internet)",
  "GERUESTBAU/BUNDESINNUNG": "Bundesinnung Gerüstbau — Downloadseite Tarif",
  "MALER/TARIFAUSZUEGE": "Tarifauszüge Maler- und Lackiererhandwerk (Malerkasse)",
  "MALER/ARBBV": "12. Maler-Arbeitsbedingungenverordnung (Zoll)",
  "MALER/MINDESTLOHN-TV": "TV Mindestlohn Maler- und Lackiererhandwerk",
  "MALER/MALERKASSE": "Malerkasse — Tarifvertragsseite",
  "TISCHLER/TISCHLER-NORD": "Tischler Nord — Arbeits- und Tarifrecht (Downloadseite)",
};

// Fachliche Einschraenkungen, die der MCP mit ausgeben soll, damit Claude nie
// eine Zahl ohne ihren Vorbehalt nennt. Steht so im urspruenglichen README.
const HINWEIS = {
  "TISCHLER/TISCHLER-NORD":
    "Keine Allgemeinverbindlicherklärung. Es gibt keine öffentliche Volltextquelle — " +
    "die Verträge liegen im Mitgliederbereich von Tischler Nord. Automatisch wird nur " +
    "die Downloadseite auf Änderungen überwacht; den Volltext bitte manuell hochladen.",
  "GERUESTBAU/BUNDESINNUNG":
    "Lohn-TV und TV Mindestlohn liegen nur im Mitgliederbereich der Bundesinnung. " +
    "Automatisch wird nur die Downloadseite überwacht; Volltext bitte manuell hochladen.",
  "MALER/TARIFAUSZUEGE":
    "Auszüge, kein Volltext des Rahmentarifvertrags. Bei Behörden kursieren teils " +
    "ältere Fassungen — Gültigkeitsdatum im Dokument prüfen.",
  "MALER/MALERKASSE":
    "Übersichtsseite der Malerkasse, kein Vertragstext. Dient der Änderungserkennung.",
};

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const zeilen = [];
for (const roh of tsv.split("\n")) {
  const zeile = roh.trim();
  if (!zeile || zeile.startsWith("#")) continue;
  const [gewerk, firmen, typ, kuerzel, url, dateiname] = zeile.split("\t");
  if (!gewerk || !typ || !kuerzel || !url) continue;
  zeilen.push({ gewerk, firmen, typ, kuerzel, url, dateiname });
}

const jetzt = new Date().toISOString();
const out = [
  "-- Erzeugt von scripts/seed-sources.mjs. Nicht von Hand bearbeiten,",
  "-- sondern data/tarif-quellen.tsv pflegen und neu erzeugen.",
  "BEGIN TRANSACTION;",
];

for (const z of zeilen) {
  const id = `${z.gewerk}/${z.kuerzel}`;
  const dokId = slug(id);
  const titel = TITEL[id] ?? z.dateiname.replace(/\.[^.]+$/, "").replace(/_/g, " ");
  const hinweis = HINWEIS[id] ?? null;

  out.push(
    `INSERT INTO quellen (id, gewerk, firmen, kuerzel, typ, url, dateiname, aktiv, hinweis)`,
    `VALUES (${q(id)}, ${q(z.gewerk)}, ${q(z.firmen)}, ${q(z.kuerzel)}, ${q(z.typ)}, ${q(z.url)}, ${q(z.dateiname)}, 1, ${q(hinweis)})`,
    // URL nachziehen, wenn ein Betreiber umbaut. aktiv bleibt, wie es gesetzt wurde.
    `ON CONFLICT(id) DO UPDATE SET`,
    `  gewerk = excluded.gewerk, firmen = excluded.firmen, kuerzel = excluded.kuerzel,`,
    `  typ = excluded.typ, url = excluded.url, dateiname = excluded.dateiname,`,
    `  hinweis = excluded.hinweis;`,
    ``,
    `INSERT INTO dokumente (id, quelle_id, gewerk, kuerzel, titel, herkunft, hinweis, erstellt_am)`,
    `VALUES (${q(dokId)}, ${q(id)}, ${q(z.gewerk)}, ${q(z.kuerzel)}, ${q(titel)}, 'auto', ${q(hinweis)}, ${q(jetzt)})`,
    // Titel und Hinweis nachziehen, aber Versionen/Status nicht anfassen.
    `ON CONFLICT(id) DO UPDATE SET titel = excluded.titel, hinweis = excluded.hinweis;`,
    ``,
  );
}

out.push("COMMIT;");
process.stdout.write(out.join("\n") + "\n");
process.stderr.write(`${zeilen.length} Quellen verarbeitet.\n`);
