import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { apiRouten } from "./api/routen";
import { accessRouten } from "./auth/access";
import { fehler, json } from "./lib/antwort";
import type { Env } from "./lib/typen";
import { mcpHandler, toolsJson } from "./mcp/server";
import { INTERN_KOPF, alleQuellenAnstossen } from "./sync/cron";
import { quelleAbrufen } from "./sync/quelle";

/**
 * Die Seite: Dashboard, JSON-Schnittstelle, der interne Abrufweg und die
 * Anmeldemasken des MCP.
 *
 * Alles hier liegt hinter Cloudflare Access - mit Ausnahme der Pfade, die zur
 * MCP-Anmeldung gehoeren. Die brauchen einen Bypass, weil Claude sie aufruft,
 * bevor irgendjemand angemeldet ist. Siehe SETUP.md.
 */
const seitenHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Katalog fuer den MCP-Hub. Ohne Anmeldung, enthaelt nur Tool-Namen und
    // -Beschreibungen. Muss offen sein, damit der Hub ihn holen kann.
    if (url.pathname === "/tools.json") return toolsJson(env, ctx);

    // Anmeldung des MCP: /authorize, /callback, /callback/bestaetigen
    const anmeldung = await accessRouten(request, env as never, url);
    if (anmeldung) return anmeldung;

    // Interner Abrufweg. Nur ueber die Selbstbindung, die der Cron benutzt.
    // Ein Endpunkt, der fremde Adressen abruft, soll nicht allein an Access
    // haengen - deshalb zusaetzlich die Kopfzeile.
    if (url.pathname.startsWith("/intern/sync/")) {
      if (request.headers.get(INTERN_KOPF) !== "1") return fehler("Nicht erlaubt", 403);
      const quelleId = decodeURIComponent(url.pathname.slice("/intern/sync/".length));
      try {
        return json(await quelleAbrufen(env, quelleId));
      } catch (e) {
        // quelleAbrufen faengt Abruffehler selbst ab und schreibt sie in die
        // Datenbank. Hier landet nur, was davor schiefgeht - etwa eine Quelle,
        // die es gar nicht gibt. Das soll sichtbar sein, nicht still verschwinden.
        return json({ dokument_id: quelleId, status: "fehler", meldung: String(e) }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return (await apiRouten(request, env, url)) ?? fehler("Unbekannter Endpunkt", 404);
      } catch (e) {
        console.error("API-Fehler", url.pathname, e);
        return fehler(e instanceof Error ? e.message : String(e), 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

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
 * Noetig, weil Claude sich per Dynamic Client Registration anmeldet - das
 * kennt Cloudflare Access fuer SaaS nicht. Dieser Worker stellt darum eigene
 * Tokens aus und benutzt Access nur als Anmeldeverfahren dahinter.
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
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    provider.fetch(request, env, ctx),

  /**
   * Taeglicher Abruf. Der Handler selbst macht fast nichts - er verteilt die
   * Arbeit auf einen Aufruf je Quelle. Siehe sync/cron.ts.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const ergebnisse = await alleQuellenAnstossen(env);
        const geaendert = ergebnisse.filter((e) => e.status === "ok").length;
        const fehlgeschlagen = ergebnisse.filter((e) => e.status === "fehler").length;
        console.log(
          `Tarifcheck: ${ergebnisse.length} Quellen, ${geaendert} mit Änderung, ` +
            `${fehlgeschlagen} fehlgeschlagen`,
        );

        // Abgelaufene Tokens und verwaiste Grants aus dem KV raeumen. Ohne das
        // waechst die Namespace mit jeder Anmeldung, die nie benutzt wurde.
        try {
          await provider.purgeExpiredData(env);
        } catch (e) {
          console.error("Aufräumen der OAuth-Daten fehlgeschlagen", e);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
