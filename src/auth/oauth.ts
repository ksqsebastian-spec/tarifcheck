/**
 * Anmeldung fuer den MCP-Server.
 *
 * Claude meldet sich als OAuth-Client per Dynamic Client Registration an und
 * schickt den Nutzer zur Anmeldung hierher. Dieser Worker ist sein eigener
 * Autorisierungsserver - es steht kein fremder Anbieter dahinter.
 *
 *   Claude ──DCR──▶ dieser Worker ──Anmeldemaske──▶ Benutzer + Passwort
 *   Claude ◀──Token── dieser Worker
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../lib/typen";
import {
  anmeldungErlaubt,
  bremseLoesen,
  fehlversuchZaehlen,
  herkunft,
  passwortStimmt,
  setzeKeks,
  sitzungAusstellen,
  sitzungPruefen,
} from "./anmeldung";
import { auspacken, verpacken } from "./zustand";

interface OAuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Zehn Minuten reichen fuer eine Anmeldung reichlich. */
const FRIST_MS = 10 * 60 * 1000;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const seite = (rumpf: string, status = 200, kopfzeilen: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tarifcheck — Anmeldung</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="wrap" style="max-width:440px;margin:12vh auto">${rumpf}</main></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...kopfzeilen },
    },
  );

const maske = (anfrage: string, clientName: string, fehler?: string) => `
<div class="karte">
  <h2 style="margin-bottom:6px">Zugriff auf Tarifcheck erlauben?</h2>
  <p class="meta" style="margin-bottom:18px">
    <strong>${esc(clientName)}</strong> möchte die Tarifverträge lesen. Erlaubt wird
    ausschließlich Lesen — Hochladen und Ändern geht nur über die Seite selbst.
  </p>
  ${fehler ? `<div id="leiste" class="schlecht" style="margin-bottom:16px">${esc(fehler)}</div>` : ""}
  <form method="POST" action="/authorize">
    <input type="hidden" name="anfrage" value="${esc(anfrage)}">
    <label>Benutzername
      <input class="feld" name="benutzer" autocomplete="username" required autofocus></label>
    <label>Passwort
      <input class="feld" type="password" name="passwort" autocomplete="current-password" required></label>
    <button class="knopf" type="submit">Anmelden und erlauben</button>
  </form>
</div>`;

/** Schritt 1: Claude schickt den Nutzer hierher. */
async function autorisieren(request: Request, env: OAuthEnv): Promise<Response> {
  const anfrage = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(anfrage.clientId);
  const name = client?.clientName ?? anfrage.clientId;

  const paket = await verpacken(
    { anfrage, erzeugt: Date.now() },
    env.SITZUNGS_SCHLUESSEL ?? "",
  );

  // Wer an der Seite schon angemeldet ist, muss das Passwort nicht erneut
  // eingeben - die Zustimmung wird trotzdem abgefragt. Ohne sie koennte ein
  // beliebiger selbst registrierter Client bei bestehender Sitzung
  // stillschweigend ein Token bekommen.
  const angemeldet = await sitzungPruefen(request, env);
  if (angemeldet) {
    return seite(`
      <div class="karte">
        <h2 style="margin-bottom:6px">Zugriff auf Tarifcheck erlauben?</h2>
        <p class="meta" style="margin-bottom:18px">
          <strong>${esc(name)}</strong> möchte die Tarifverträge lesen. Angemeldet als
          <strong>${esc(angemeldet)}</strong>. Erlaubt wird ausschließlich Lesen.
        </p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="anfrage" value="${esc(paket)}">
          <button class="knopf" type="submit">Erlauben</button>
        </form>
      </div>`);
  }

  return seite(maske(paket, name));
}

/** Schritt 2: Anmeldedaten pruefen und den Autorisierungscode ausstellen. */
async function bestaetigen(request: Request, env: OAuthEnv): Promise<Response> {
  const form = await request.formData();
  const paket = String(form.get("anfrage") ?? "");

  const mit = await auspacken<{ anfrage: AuthRequest; erzeugt: number }>(
    paket,
    env.SITZUNGS_SCHLUESSEL ?? "",
  );
  if (!mit || Date.now() - mit.erzeugt > FRIST_MS) {
    return seite(
      `<div class="karte"><h2>Die Anfrage ist abgelaufen</h2>
       <p class="meta">Bitte in Claude erneut verbinden.</p></div>`,
      400,
    );
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(mit.anfrage.clientId);
  const name = client?.clientName ?? mit.anfrage.clientId;

  let benutzer = await sitzungPruefen(request, env);
  let neuerKeks: string | null = null;

  if (!benutzer) {
    const ip = herkunft(request);
    if (!(await anmeldungErlaubt(env, ip))) {
      return seite(maske(paket, name, "Zu viele Fehlversuche. Bitte in 15 Minuten erneut."), 429);
    }

    const eingabe = String(form.get("benutzer") ?? "");
    const passwort = String(form.get("passwort") ?? "");
    const stimmt =
      eingabe === env.LOGIN_BENUTZER &&
      Boolean(env.LOGIN_HASH) &&
      (await passwortStimmt(passwort, env.LOGIN_HASH!));

    // Bewusst keine Unterscheidung zwischen falschem Namen und falschem
    // Passwort - sonst verraet die Meldung, welcher Teil schon stimmt.
    if (!stimmt) {
      await fehlversuchZaehlen(env, ip);
      return seite(maske(paket, name, "Benutzername oder Passwort stimmt nicht."), 401);
    }

    await bremseLoesen(env, ip);
    benutzer = eingabe;
    neuerKeks = setzeKeks(await sitzungAusstellen(env, benutzer));
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: mit.anfrage,
    userId: benutzer,
    metadata: { benutzer },
    scope: mit.anfrage.scope,
    props: { benutzer },
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: redirectTo,
      ...(neuerKeks ? { "set-cookie": neuerKeks } : {}),
    },
  });
}

/** Gibt null zurueck, wenn der Pfad nichts mit der MCP-Anmeldung zu tun hat. */
export async function oauthRouten(
  request: Request,
  env: OAuthEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/authorize") return null;

  /**
   * Eine unbrauchbare Anfrage darf keine Ausnahme werden.
   *
   * `parseAuthRequest` wirft, sobald Parameter fehlen oder der Client
   * unbekannt ist. Der Worker antwortete dann mit "error code: 1101" - eine
   * Meldung, aus der niemand etwas ablesen kann, und die jeder zu sehen
   * bekommt, der die Adresse ohne Claude aufruft.
   */
  try {
    if (request.method === "GET") return await autorisieren(request, env);
    if (request.method === "POST") return await bestaetigen(request, env);
    return null;
  } catch (e) {
    console.error("Anmeldung des MCP fehlgeschlagen", url.pathname, e);
    return seite(
      `<div class="karte">
         <h2 style="margin-bottom:6px">Diese Anfrage lässt sich nicht zuordnen</h2>
         <p class="meta">Diese Seite gehört zur Anmeldung des MCP-Zugangs und wird von
         Claude aufgerufen — von Hand aufgerufen fehlen ihr die nötigen Angaben.
         Zum Einrichten: in Claude unter Einstellungen → Connectors die Adresse
         <code>/mcp</code> hinzufügen.</p>
       </div>`,
      400,
    );
  }
}
