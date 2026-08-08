/**
 * Anmeldung mit Benutzername und Passwort.
 *
 * Bewusst ohne Cloudflare Access: das war eine Abhaengigkeit, die im Dashboard
 * eingerichtet werden muss und deren Fehlkonfiguration man der Seite nicht
 * ansieht. Hier gilt: was der Worker prueft, steht im Worker.
 *
 * Das Passwort liegt nie im Klartext auf dem Server, sondern nur als
 * PBKDF2-Hash. Wer den Hash liest, hat damit noch kein Passwort.
 */

import type { Env } from "../lib/typen";

const enc = new TextEncoder();

const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const vonB64u = (s: string): Uint8Array => {
  const roh = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(roh, (c) => c.charCodeAt(0));
};

/** Vergleich in konstanter Zeit - ein frueher Abbruch verriete sonst, wieviel schon stimmt. */
function gleich(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let unterschied = 0;
  for (let i = 0; i < a.length; i++) unterschied |= a[i] ^ b[i];
  return unterschied === 0;
}

/**
 * Format: pbkdf2$<runden>$<salz>$<hash>, alles base64url.
 *
 * Die Runden sind auf 100.000 gedeckelt - mehr laesst die Web-Crypto-Umsetzung
 * in Workers nicht zu ("iteration counts above 100000 are not supported").
 * Das liegt unter der OWASP-Empfehlung von 210.000, ist hier aber vertretbar:
 * der Hash liegt in einem Cloudflare-Secret und kaeme nur jemandem in die
 * Haende, der ohnehin Zugriff auf das Konto hat - und dann waere der Hash sein
 * kleinstes Werkzeug. Was hier wirklich schuetzt, ist die Bremse gegen
 * Durchprobieren weiter unten.
 */
export async function passwortStimmt(passwort: string, eintrag: string): Promise<boolean> {
  const [verfahren, runden, salz, erwartet] = eintrag.split("$");
  if (verfahren !== "pbkdf2" || !runden || !salz || !erwartet) return false;

  const schluessel = await crypto.subtle.importKey(
    "raw",
    enc.encode(passwort),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: vonB64u(salz), iterations: Number(runden) },
    schluessel,
    256,
  );
  return gleich(new Uint8Array(bits), vonB64u(erwartet));
}

/* ── Sitzung ────────────────────────────────────────────────────────────── */

export const SITZUNG_COOKIE = "tc_sitzung";
const GUELTIG_TAGE = 14;

interface Sitzung {
  benutzer: string;
  ablauf: number;
}

async function sitzungsSchluessel(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(env.SITZUNGS_SCHLUESSEL ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sitzungAusstellen(env: Env, benutzer: string): Promise<string> {
  const daten: Sitzung = {
    benutzer,
    ablauf: Date.now() + GUELTIG_TAGE * 86400_000,
  };
  const koerper = b64u(enc.encode(JSON.stringify(daten)));
  const sig = await crypto.subtle.sign("HMAC", await sitzungsSchluessel(env), enc.encode(koerper));
  return `${koerper}.${b64u(sig)}`;
}

/** Gibt den Benutzernamen zurueck - oder null. Null heisst immer: nicht durchlassen. */
export async function sitzungPruefen(request: Request, env: Env): Promise<string | null> {
  // Nicht eingerichtet -> nichts, wogegen geprueft werden koennte -> zu.
  if (!env.SITZUNGS_SCHLUESSEL) return null;

  const keks = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SITZUNG_COOKIE}=`))
    ?.slice(SITZUNG_COOKIE.length + 1);
  if (!keks) return null;

  const punkt = keks.lastIndexOf(".");
  if (punkt < 1) return null;

  const koerper = keks.slice(0, punkt);
  let gueltig: boolean;
  try {
    gueltig = await crypto.subtle.verify(
      "HMAC",
      await sitzungsSchluessel(env),
      vonB64u(keks.slice(punkt + 1)),
      enc.encode(koerper),
    );
  } catch {
    return null;
  }
  if (!gueltig) return null;

  try {
    const s = JSON.parse(new TextDecoder().decode(vonB64u(koerper))) as Sitzung;
    return s.ablauf > Date.now() ? s.benutzer : null;
  } catch {
    return null;
  }
}

export const setzeKeks = (wert: string): string =>
  `${SITZUNG_COOKIE}=${wert}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${GUELTIG_TAGE * 86400}`;

export const loescheKeks = (): string =>
  `${SITZUNG_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/* ── Wartungsschluessel ─────────────────────────────────────────────────── */

/**
 * Ausweis fuer die woechentliche Pflegeroutine, die kein Passwort haben kann.
 *
 * Bewusst kein zweiter Weg zur vollen Anmeldung: der Aufrufer bekommt damit
 * genau eine Befugnis, naemlich eine Quellenadresse zu korrigieren. Der
 * Schluessel steckt in einem Routine-Text und ist damit schlechter geschuetzt
 * als ein Passwort im Kopf eines Menschen - deshalb darf er auch weniger.
 */
export function pflegeschluesselStimmt(request: Request, env: Env): boolean {
  const erwartet = env.PFLEGE_SCHLUESSEL;
  if (!erwartet) return false;

  const kopf = request.headers.get("authorization") ?? "";
  if (!kopf.startsWith("Bearer ")) return false;

  const roh = new TextEncoder();
  return gleich(roh.encode(kopf.slice("Bearer ".length)), roh.encode(erwartet));
}

/* ── Bremse gegen Durchprobieren ────────────────────────────────────────── */

const GRENZE = 10;
const FENSTER_MS = 15 * 60 * 1000;

const stelle = (env: Env, name: string) => env.BREMSE.get(env.BREMSE.idFromName(name));

/**
 * Darf von dieser Herkunft noch ein Versuch kommen?
 *
 * Gezaehlt wird nur je Herkunft, nicht kontoweit. Ein kontoweites Limit klingt
 * gruendlicher, oeffnet aber eine Tuer: wer genug Fehlversuche schickt,
 * sperrte damit die Kollegen aus. Gegen verteiltes Raten schuetzt hier die
 * Laenge des Passworts, nicht die Bremse.
 *
 * Und gezaehlt werden nur Fehlversuche - wer das richtige Passwort eingibt,
 * soll sich nicht am eigenen Limit aussperren.
 */
export const anmeldungErlaubt = (env: Env, kennung: string): Promise<boolean> =>
  stelle(env, `ip:${kennung}`).offen(GRENZE, FENSTER_MS);

export const fehlversuchZaehlen = (env: Env, kennung: string): Promise<void> =>
  stelle(env, `ip:${kennung}`).fehlversuch(FENSTER_MS);

export const bremseLoesen = (env: Env, kennung: string): Promise<void> =>
  stelle(env, `ip:${kennung}`).zuruecksetzen();

/** Wer klopft. Hinter Cloudflare ist CF-Connecting-IP die verlaessliche Angabe. */
export const herkunft = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? "unbekannt";
