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

  // Aus der Access-for-SaaS-App (OIDC). Als Secrets gesetzt, siehe SETUP.md.
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_TOKEN_URL: string;
  /** Zufallswert, mit dem der Zustand ueber die Anmeldung hinweg signiert wird. */
  COOKIE_ENCRYPTION_KEY: string;

  // Fuer die Pruefung schreibender Zugriffe gegen die selbst gehostete
  // Access-Anwendung. Fehlen sie, sind schreibende Zugriffe gesperrt.
  ACCESS_TEAM_DOMAIN?: string;   // z.B. gruppenwerk.cloudflareaccess.com
  ACCESS_AUD?: string;           // Application Audience Tag der Anwendung
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
