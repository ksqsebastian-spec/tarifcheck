// Nur als Typ importiert - zur Laufzeit entsteht dadurch kein Kreis.
import type { SyncEntrypoint } from "../index";

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  /**
   * Selbstbindung als RPC. Der Cron ruft sie pro Quelle einmal auf.
   *
   * Bewusst RPC und nicht HTTP: ein interner HTTP-Pfad waere von aussen
   * erreichbar und muesste ueber eine geheime Kopfzeile geschuetzt werden -
   * also ueber etwas, das jeder mitschicken kann, der sie erraet. Eine
   * RPC-Methode gibt es im Netz schlicht nicht.
   */
  SELF: Service<SyncEntrypoint>;

  /** Tokens und Grants des OAuth-Providers. */
  OAUTH_KV: KVNamespace;

  /** Bremse gegen das Durchprobieren von Passwoertern. */
  BREMSE: DurableObjectNamespace<import("../auth/bremse").Bremse>;

  /**
   * Kennung der laufenden Fassung, von der Laufzeitumgebung gesetzt.
   *
   * Steht in /api/gesundheit, damit der Deploy nachsehen kann, ob schon die
   * neue Fassung antwortet und nicht mehr die vorige.
   */
  FASSUNG: { id: string; tag: string };

  // Anmeldung. Als Secrets gesetzt, siehe SETUP.md.
  LOGIN_BENUTZER?: string;
  /** PBKDF2-Hash im Format pbkdf2$<runden>$<salz>$<hash>. Nie das Klartextpasswort. */
  LOGIN_HASH?: string;
  /** Zufallswert, mit dem Sitzungen und Anmeldevorgaenge signiert werden. */
  SITZUNGS_SCHLUESSEL?: string;
  /**
   * Ausweis der woechentlichen Pflegeroutine. Darf ausschliesslich
   * Quellenadressen korrigieren - nicht hochladen, nicht loeschen.
   */
  PFLEGE_SCHLUESSEL?: string;
}

export interface Quelle {
  id: string;
  gewerk: string;
  firmen: string;
  kuerzel: string;
  typ: "pdf" | "watch";
  url: string;
  dateiname: string;
  aktiv: number;
  hinweis: string | null;
}

export interface Dokument {
  id: string;
  quelle_id: string | null;
  gewerk: string;
  kuerzel: string;
  titel: string;
  herkunft: "auto" | "manuell";
  gueltig_ab: string | null;
  hinweis: string | null;
  aktuelle_version_id: string | null;
  letzte_pruefung: string | null;
  letzter_status: "ok" | "unveraendert" | "fehler" | null;
  letzter_fehler: string | null;
  erstellt_am: string;
}

export interface Version {
  id: string;
  dokument_id: string;
  erfasst_am: string;
  r2_raw_key: string | null;
  r2_md_key: string | null;
  bytes: number | null;
  etag: string | null;
  http_etag: string | null;
  http_last_modified: string | null;
  quelle_url: string | null;
  hochgeladen_von: string | null;
  text_zeichen: number | null;
}

export type MeldungsArt =
  | "neu"
  | "geaendert"
  | "seite_geaendert"
  | "neuer_link"
  | "fehler"
  | "upload";

/** Ergebnis eines Quellen-Abrufs. */
export interface SyncErgebnis {
  dokument_id: string;
  status: "ok" | "unveraendert" | "fehler";
  meldung?: string;
  version_id?: string;
}
