/**
 * Anmeldung des MCP-Servers gegen Cloudflare Access.
 *
 * Warum diese Zwischenschicht ueberhaupt noetig ist: Claude meldet sich als
 * OAuth-Client per Dynamic Client Registration an. Access fuer SaaS kennt das
 * nicht - es erwartet einen vorab eingetragenen Client. Also stellt dieser
 * Worker selbst Tokens aus (workers-oauth-provider) und benutzt Access nur als
 * Anmeldeverfahren dahinter.
 *
 *   Claude ──DCR──▶ dieser Worker ──OIDC──▶ Cloudflare Access ──▶ Login
 *   Claude ◀─eigenes Token── dieser Worker
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../lib/typen";
import { auspacken, verpacken } from "./zustand";

interface AccessEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_TOKEN_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
}

interface Mitgefuehrt {
  anfrage: AuthRequest;
  /** Gegen verspaetetes Wiedereinspielen einer alten Weiterleitung. */
  erzeugt: number;
}

interface Bestaetigung {
  anfrage: AuthRequest;
  email: string;
  sub: string;
  erzeugt: number;
}

/** Zehn Minuten fuer den Weg durch die Anmeldung sind reichlich. */
const FRIST_MS = 10 * 60 * 1000;

const seite = (rumpf: string, status = 200): Response =>
  new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Tarifcheck</title><link rel="stylesheet" href="/style.css"></head>
     <body><main style="max-width:520px;margin:12vh auto">${rumpf}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Schritt 1: Claude schickt den Nutzer hierher.
 * Wir merken uns die Anfrage signiert und schicken ihn zu Access weiter.
 */
async function autorisieren(request: Request, env: AccessEnv): Promise<Response> {
  const anfrage = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  const zustand = await verpacken<Mitgefuehrt>(
    { anfrage, erzeugt: Date.now() } as Mitgefuehrt,
    env.COOKIE_ENCRYPTION_KEY,
  );

  const ziel = new URL(env.ACCESS_AUTHORIZATION_URL);
  ziel.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  ziel.searchParams.set("redirect_uri", new URL("/callback", request.url).toString());
  ziel.searchParams.set("response_type", "code");
  ziel.searchParams.set("scope", "openid email profile");
  ziel.searchParams.set("state", zustand);

  return Response.redirect(ziel.toString(), 302);
}

/**
 * Schritt 2: Access schickt den Nutzer zurueck. Wir tauschen den Code gegen
 * Tokens und fragen dann nach der Zustimmung.
 */
async function rueckweg(request: Request, env: AccessEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const zustand = url.searchParams.get("state");

  if (url.searchParams.get("error")) {
    return seite(
      `<div class="karte"><h2>Anmeldung abgebrochen</h2>
       <p class="erklaerung">${esc(url.searchParams.get("error_description") ?? url.searchParams.get("error")!)}</p>
       </div>`,
      400,
    );
  }
  if (!code || !zustand) return seite('<div class="karte"><h2>Unvollständige Rückmeldung von Access</h2></div>', 400);

  const mit = await auspacken<Mitgefuehrt>(zustand, env.COOKIE_ENCRYPTION_KEY);
  if (!mit) return seite('<div class="karte"><h2>Die Anmeldung ließ sich nicht zuordnen</h2><p class="erklaerung">Bitte in Claude erneut verbinden.</p></div>', 400);
  if (Date.now() - mit.erzeugt > FRIST_MS) {
    return seite('<div class="karte"><h2>Die Anmeldung hat zu lange gedauert</h2><p class="erklaerung">Bitte in Claude erneut verbinden.</p></div>', 400);
  }

  const antwort = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      redirect_uri: new URL("/callback", request.url).toString(),
    }),
  });

  if (!antwort.ok) {
    return seite(
      `<div class="karte"><h2>Access hat den Anmeldecode abgelehnt</h2>
       <p class="erklaerung">HTTP ${antwort.status}. Meist stimmen Client-ID, Geheimnis
       oder die hinterlegte Rückleitungsadresse nicht — siehe SETUP.md.</p></div>`,
      502,
    );
  }

  const tokens = await antwort.json<{ id_token?: string }>();
  if (!tokens.id_token) return seite('<div class="karte"><h2>Access hat kein id_token geliefert</h2></div>', 502);

  // Die Signatur wird bewusst nicht geprueft: das Token kam gerade eben ueber
  // eine TLS-Verbindung direkt vom Token-Endpunkt von Access, nicht ueber den
  // Browser. Genau dafuer sieht OpenID Connect den Verzicht ausdruecklich vor.
  const anspruch = ansprucheLesen(tokens.id_token);
  const email = anspruch?.email;
  const sub = anspruch?.sub;
  if (!email || !sub) return seite('<div class="karte"><h2>Access hat keine Mailadresse mitgeschickt</h2><p class="erklaerung">In der SaaS-App muss der Scope <code>email</code> erlaubt sein.</p></div>', 502);

  const client = await env.OAUTH_PROVIDER.lookupClient(mit.anfrage.clientId);
  const bestaetigung = await verpacken<Bestaetigung>(
    { anfrage: mit.anfrage, email, sub, erzeugt: Date.now() } as Bestaetigung,
    env.COOKIE_ENCRYPTION_KEY,
  );

  // Zustimmung wird bewusst abgefragt, obwohl Access schon angemeldet hat.
  // Sonst koennte ein beliebiger Client, der sich selbst registriert hat, bei
  // einer bestehenden Access-Sitzung stillschweigend ein Token bekommen.
  return seite(`
    <div class="karte">
      <h2>Zugriff auf Tarifcheck erlauben?</h2>
      <p class="erklaerung">
        <strong>${esc(client?.clientName ?? mit.anfrage.clientId)}</strong> möchte die
        Tarifverträge lesen. Angemeldet als <strong>${esc(email)}</strong>.
      </p>
      <p class="erklaerung">
        Erlaubt wird ausschließlich Lesen: Gewerke, Dokumente, Änderungsmeldungen
        und die Volltextsuche. Hochladen und Ändern geht nur über die Seite selbst.
      </p>
      <form method="POST" action="/callback/bestaetigen">
        <input type="hidden" name="bestaetigung" value="${esc(bestaetigung)}">
        <button type="submit" class="knopf">Erlauben</button>
      </form>
    </div>`);
}

/** Schritt 3: Der Nutzer hat zugestimmt. Jetzt stellen wir den Code aus. */
async function bestaetigen(request: Request, env: AccessEnv): Promise<Response> {
  const form = await request.formData();
  const paket = String(form.get("bestaetigung") ?? "");

  const b = await auspacken<Bestaetigung>(paket, env.COOKIE_ENCRYPTION_KEY);
  if (!b) return seite('<div class="karte"><h2>Die Bestätigung ließ sich nicht prüfen</h2></div>', 400);
  if (Date.now() - b.erzeugt > FRIST_MS) {
    return seite('<div class="karte"><h2>Die Bestätigung ist abgelaufen</h2><p class="erklaerung">Bitte in Claude erneut verbinden.</p></div>', 400);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: b.anfrage,
    userId: b.sub,
    metadata: { email: b.email },
    scope: b.anfrage.scope,
    // Steht den Werkzeugen ueber getMcpAuthContext() zur Verfuegung.
    props: { email: b.email, sub: b.sub },
  });

  return Response.redirect(redirectTo, 302);
}

function ansprucheLesen(idToken: string): { email?: string; sub?: string } | null {
  try {
    const teil = idToken.split(".")[1];
    const roh = atob(teil.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(roh)));
  } catch {
    return null;
  }
}

/** Gibt null zurueck, wenn der Pfad nichts mit der Anmeldung zu tun hat. */
export async function accessRouten(
  request: Request,
  env: AccessEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/authorize") return autorisieren(request, env);
  if (url.pathname === "/callback" && request.method === "GET") return rueckweg(request, env);
  if (url.pathname === "/callback/bestaetigen" && request.method === "POST")
    return bestaetigen(request, env);
  return null;
}
