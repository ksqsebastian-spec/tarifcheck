/**
 * Zustand ueber die Weiterleitung zur Anmeldemaske hinweg mitfuehren.
 *
 * Der Umweg geht ueber den Browser des Nutzers, also ueber Fremdgebiet.
 * Alles, was mitgereicht wird, wird darum signiert und beim Rueckweg geprueft -
 * sonst koennte jemand die Anfrage unterwegs umschreiben und sich ein Token
 * fuer einen fremden Client ausstellen lassen.
 */

const enc = new TextEncoder();

async function schluessel(geheimnis: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(geheimnis),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const vonB64u = (s: string): Uint8Array => {
  const roh = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(roh, (c) => c.charCodeAt(0));
};

/** Nutzlast als `<daten>.<signatur>` verpacken. */
export async function verpacken<T>(daten: T, geheimnis: string): Promise<string> {
  const koerper = b64u(enc.encode(JSON.stringify(daten)));
  const sig = await crypto.subtle.sign("HMAC", await schluessel(geheimnis), enc.encode(koerper));
  return `${koerper}.${b64u(sig)}`;
}

/** Gibt null zurueck, wenn die Signatur nicht passt oder der Inhalt kaputt ist. */
export async function auspacken<T>(paket: string, geheimnis: string): Promise<T | null> {
  const punkt = paket.lastIndexOf(".");
  if (punkt < 1) return null;

  const koerper = paket.slice(0, punkt);
  const sig = paket.slice(punkt + 1);

  let gueltig: boolean;
  try {
    // crypto.subtle.verify vergleicht in konstanter Zeit.
    gueltig = await crypto.subtle.verify(
      "HMAC",
      await schluessel(geheimnis),
      vonB64u(sig),
      enc.encode(koerper),
    );
  } catch {
    return null;
  }
  if (!gueltig) return null;

  try {
    return JSON.parse(new TextDecoder().decode(vonB64u(koerper))) as T;
  } catch {
    return null;
  }
}
