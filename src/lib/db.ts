import type { Dokument, Env, MeldungsArt, Quelle, Version } from "./typen";
import { jetzt } from "./zeit";

export const quelleLaden = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM quellen WHERE id = ?").bind(id).first<Quelle>();

export const aktiveQuellen = (env: Env) =>
  env.DB.prepare("SELECT * FROM quellen WHERE aktiv = 1 ORDER BY gewerk, kuerzel")
    .all<Quelle>();

export const dokumentLaden = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM dokumente WHERE id = ?").bind(id).first<Dokument>();

export const dokumentZuQuelle = (env: Env, quelleId: string) =>
  env.DB.prepare("SELECT * FROM dokumente WHERE quelle_id = ?")
    .bind(quelleId)
    .first<Dokument>();

export const versionLaden = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM versionen WHERE id = ?").bind(id).first<Version>();

/** Die zuletzt erfasste Fassung. Basis fuer den Vergleich beim naechsten Abruf. */
export const letzteVersion = (env: Env, dokumentId: string) =>
  env.DB.prepare(
    "SELECT * FROM versionen WHERE dokument_id = ? ORDER BY erfasst_am DESC LIMIT 1",
  )
    .bind(dokumentId)
    .first<Version>();

export async function meldungAnlegen(
  env: Env,
  m: {
    art: MeldungsArt;
    titel: string;
    beschreibung?: string | null;
    gewerk?: string | null;
    dokumentId?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meldungen (zeitpunkt, gewerk, dokument_id, art, titel, beschreibung)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jetzt(),
      m.gewerk ?? null,
      m.dokumentId ?? null,
      m.art,
      m.titel,
      m.beschreibung ?? null,
    )
    .run();
}

/** Ergebnis eines Abrufs am Dokument vermerken, damit die Seite es anzeigt. */
export async function pruefungVermerken(
  env: Env,
  dokumentId: string,
  status: "ok" | "unveraendert" | "fehler",
  fehlertext: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE dokumente
        SET letzte_pruefung = ?, letzter_status = ?, letzter_fehler = ?
      WHERE id = ?`,
  )
    .bind(jetzt(), status, fehlertext, dokumentId)
    .run();
}

/**
 * Volltextindex fuer ein Dokument ersetzen.
 * FTS5 kennt kein UPSERT, daher loeschen und neu einfuegen.
 */
export async function volltextSetzen(
  env: Env,
  dokument: { id: string; gewerk: string; titel: string },
  inhalt: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dokumente_fts WHERE dokument_id = ?").bind(dokument.id),
    env.DB.prepare(
      "INSERT INTO dokumente_fts (dokument_id, gewerk, titel, inhalt) VALUES (?, ?, ?, ?)",
    ).bind(dokument.id, dokument.gewerk, dokument.titel, inhalt),
  ]);
}
