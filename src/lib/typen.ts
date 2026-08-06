export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  /** Selbstbindung. Der Cron ruft sich hierueber pro Quelle einmal auf. */
  SELF: Fetcher;
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
}

export type MeldungsArt =
  | "neu"
  | "geaendert"
  | "seite_geaendert"
  | "neuer_link"
  | "fehler"
  | "upload";

/** Ergebnis eines Quellen-Abrufs. Wird als JSON zurueckgegeben. */
export interface SyncErgebnis {
  dokument_id: string;
  status: "ok" | "unveraendert" | "fehler";
  meldung?: string;
  version_id?: string;
}
