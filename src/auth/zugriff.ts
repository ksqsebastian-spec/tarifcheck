/**
 * Prueft die Anmeldung fuer schreibende Zugriffe.
 *
 * Cloudflare Access setzt bei einer geschuetzten Anwendung die Kopfzeile
 * `cf-access-authenticated-user-email` und ueberschreibt dabei, was der Client
 * mitgeschickt hat. Allein darauf zu bauen genuegt aber nicht: solange vor der
 * Adresse keine Access-Anwendung steht, kann jeder die Kopfzeile einfach
 * selbst setzen. Eine Pruefung, die nur so aussieht wie eine, ist schlimmer
 * als keine.
 *
 * Darum wird das signierte Token geprueft, das Access zusaetzlich mitschickt.
 * Und darum wird abgelehnt, solange nicht konfiguriert ist, wogegen zu pruefen
 * waere - im Zweifel zu bleibt hier richtig, denn wer die Adresse einer Quelle
 * aendern kann, bestimmt, was der Dienst morgen frueh als Tarifvertrag ablegt.
 */

import type { Env } from "../lib/typen";

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const b64u = (s: string): Uint8Array => {
  const roh = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(roh, (c) => c.charCodeAt(0));
};

/** Schluessel von Access holen. Eine Stunde zwischengespeichert. */
async function schluesselHolen(env: Env): Promise<Jwk[]> {
  const zwischen = await env.OAUTH_KV.get("access-jwks", "json");
  if (zwischen) return zwischen as Jwk[];

  const antwort = await fetch(
    `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
  );
  if (!antwort.ok) throw new Error(`Access-Schlüssel nicht abrufbar: ${antwort.status}`);

  const { keys } = await antwort.json<{ keys: Jwk[] }>();
  await env.OAUTH_KV.put("access-jwks", JSON.stringify(keys), { expirationTtl: 3600 });
  return keys;
}

/**
 * Gibt die Mailadresse zurueck, wenn das Access-Token gueltig ist - sonst null.
 * Ein null bedeutet immer: nicht durchlassen.
 */
export async function angemeldeteAdresse(
  request: Request,
  env: Env,
): Promise<string | null> {
  // Nicht konfiguriert -> nichts, wogegen geprueft werden koennte -> zu.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;

  const [kopf, nutzlast, signatur] = token.split(".");
  if (!kopf || !nutzlast || !signatur) return null;

  let kid: string;
  let anspruch: { aud?: string | string[]; email?: string; exp?: number; iss?: string };
  try {
    kid = JSON.parse(new TextDecoder().decode(b64u(kopf))).kid;
    anspruch = JSON.parse(new TextDecoder().decode(b64u(nutzlast)));
  } catch {
    return null;
  }

  const schluessel = (await schluesselHolen(env)).find((k) => k.kid === kid);
  if (!schluessel) return null;

  const oeffentlich = await crypto.subtle.importKey(
    "jwk",
    { kty: schluessel.kty, n: schluessel.n, e: schluessel.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const gueltig = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    oeffentlich,
    b64u(signatur),
    new TextEncoder().encode(`${kopf}.${nutzlast}`),
  );
  if (!gueltig) return null;

  // Ohne diese drei Pruefungen waere die Signatur wenig wert: ein gueltiges
  // Token einer anderen Anwendung oder ein abgelaufenes wuerde sonst genuegen.
  if (anspruch.exp && anspruch.exp * 1000 < Date.now()) return null;
  const aud = Array.isArray(anspruch.aud) ? anspruch.aud : [anspruch.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (anspruch.iss && !anspruch.iss.includes(env.ACCESS_TEAM_DOMAIN)) return null;

  return anspruch.email ?? null;
}
