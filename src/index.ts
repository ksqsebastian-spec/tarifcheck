import { WorkerEntrypoint } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { apiRouten } from "./api/routen";
import { oauthRouten } from "./auth/oauth";

export { TarifUpdate } from "./sync/workflow";
export { Bremse } from "./auth/bremse";
import { fehler } from "./lib/antwort";
import { ICON_ICO, ICON_PNG_180, ICON_PNG_512, ICON_SVG } from "./lib/icons.generated";
import type { Env } from "./lib/typen";
import { mcpHandler, toolsJson } from "./mcp/server";
import { quelleAbrufen } from "./sync/quelle";

/**
 * Die Seite: Dashboard, JSON-Schnittstelle, der interne Abrufweg und die
 * Anmeldemasken des MCP.
 *
 * Lesen geht ohne Anmeldung. Geschrieben wird nur mit gueltiger Sitzung - das
 * Tor dafuer steht in api/routen.ts, baulich vor allen Schreibrouten.
 */
/* Base64 einmal beim Kaltstart auspacken, danach aus dem Speicher ausliefern. */
const ICON_CACHE = new Map<string, Uint8Array>();

function bild(b64: string, typ: string): Response {
  let bytes = ICON_CACHE.get(b64);
  if (!bytes) {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    ICON_CACHE.set(b64, bytes);
  }
  return new Response(bytes, {
    headers: {
      "content-type": typ,
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
}

const seitenHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Katalog fuer den MCP-Hub. Ohne Anmeldung, enthaelt nur Tool-Namen und
    // -Beschreibungen. Muss offen sein, damit der Hub ihn holen kann.
    if (url.pathname === "/tools.json") return toolsJson(env, ctx);

    // Das Zeichen als Datei. Muss vor der Dateiauslieferung stehen: die steht auf
    // single-page-application und wuerde jeden dieser Pfade als Startseite
    // beantworten - also HTML zurueckgeben, wo ein Bild erwartet wird.
    switch (url.pathname) {
      case "/favicon.ico":
        return bild(ICON_ICO, "image/x-icon");
      case "/icon.png":
        return bild(ICON_PNG_512, "image/png");
      case "/apple-touch-icon.png":
      case "/apple-touch-icon-precomposed.png":
        return bild(ICON_PNG_180, "image/png");
      case "/favicon.svg":
      case "/icon.svg":
        return new Response(ICON_SVG, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          },
        });
    }

    // Anmeldemaske des MCP unter /authorize
    const anmeldung = await oauthRouten(request, env as never, url);
    if (anmeldung) return anmeldung;

    if (url.pathname.startsWith("/api/")) {
      try {
        return (await apiRouten(request, env, url)) ?? fehler("Unbekannter Endpunkt", 404);
      } catch (e) {
        console.error("API-Fehler", url.pathname, e);
        return fehler("Die Anfrage konnte nicht verarbeitet werden. Bitte erneut versuchen.", 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Interner RPC-Einstieg für den Workflow.
 *
 * Als RPC-Methode und nicht als HTTP-Pfad: ein Endpunkt, der fremde Adressen
 * abruft und Rechenzeit verbraucht, hat im offenen Netz nichts zu suchen. Ein
 * geheimer Kopfzeilenwert waere kein Schutz gewesen - den kann jeder
 * mitschicken. Eine RPC-Methode ist ueber HTTP gar nicht ansprechbar.
 */
export class SyncEntrypoint extends WorkerEntrypoint<Env> {
  quelleAbrufen(quelleId: string) {
    return quelleAbrufen(this.env, quelleId);
  }

  /** Cleanup remains part of the on-demand workflow after removing cron. */
  async oauthAufraeumen(): Promise<void> {
    await provider.purgeExpiredData(this.env);
  }

  /** Live health probe for the internal service binding. */
  bereit(): string {
    return "ok";
  }
}

/**
 * Der MCP-Endpunkt. Der OAuth-Provider laesst hier nur Anfragen mit gueltigem
 * Token durch und haengt die Nutzerangaben an den Kontext.
 */
const mcpApiHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => mcpHandler(request, env, ctx),
} satisfies ExportedHandler<Env>;

/**
 * Eigener Autorisierungsserver.
 *
 * Noetig, weil Claude sich per Dynamic Client Registration anmeldet: der
 * Client ist vorher nicht bekannt und registriert sich selbst. Dieser Worker
 * stellt darum eigene Tokens aus; dahinter steht dieselbe Anmeldung mit
 * Benutzername und Passwort wie auf der Seite.
 */
const provider = new OAuthProvider<Env>({
  apiHandlers: { "/mcp": mcpApiHandler },
  defaultHandler: seitenHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["tarife:lesen"],
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await provider.fetch(request, env, ctx);
    const result = new Response(response.body, response);
    result.headers.set('X-Content-Type-Options', 'nosniff');
    result.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    result.headers.set('X-Frame-Options', 'DENY');
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (new URL(request.url).pathname.startsWith('/api/')) result.headers.set('Cache-Control', 'no-store');
    if (new URL(request.url).pathname === '/') result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return result;
  },

} satisfies ExportedHandler<Env>;
