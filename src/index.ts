import { WorkerEntrypoint } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { apiRouten } from "./api/routen";
import { oauthRouten } from "./auth/oauth";

export { Bremse } from "./auth/bremse";
import { fehler } from "./lib/antwort";
import { meldungAnlegen } from "./lib/db";
import { ICON_ICO, ICON_PNG_180, ICON_PNG_512, ICON_SVG } from "./lib/icons.generated";
import type { Env } from "./lib/typen";
import { mcpHandler, toolsJson } from "./mcp/server";
import { alleQuellenAnstossen } from "./sync/cron";
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
        return fehler(e instanceof Error ? e.message : String(e), 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Was die Selbstbindung dem Cron anbietet.
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

  /**
   * Antwortet, ohne etwas zu tun.
   *
   * Damit laesst sich pruefen, ob die Selbstbindung wirklich traegt - und
   * nicht nur richtig konfiguriert aussieht. Ohne sie faende der taegliche
   * Lauf keine Quelle mehr und wuerde stillschweigend nichts tun. Genau die
   * Sorte Fehler, die man erst Wochen spaeter am veralteten Stand bemerkt.
   */
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
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    provider.fetch(request, env, ctx),

  /**
   * Taeglicher Abruf. Der Handler selbst macht fast nichts - er verteilt die
   * Arbeit auf einen Aufruf je Quelle. Siehe sync/cron.ts.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const ergebnisse = await alleQuellenAnstossen(env);
          const geaendert = ergebnisse.filter((e) => e.status === "ok").length;
          const fehlgeschlagen = ergebnisse.filter((e) => e.status === "fehler").length;
          console.log(
            `Tarifcheck: ${ergebnisse.length} Quellen, ${geaendert} mit Änderung, ` +
              `${fehlgeschlagen} fehlgeschlagen`,
          );
        } catch (e) {
          // Scheitert der Lauf als Ganzes - Selbstbindung weg, Datenbank nicht
          // erreichbar -, dann scheitert er fuer jede Quelle zugleich, und
          // keine einzelne kann es vermerken. Ohne diese Meldung stuende auf
          // der Seite weiter der Stand von gestern, ohne jeden Hinweis darauf,
          // dass seither nichts mehr geprueft wurde.
          const text = e instanceof Error ? e.message : String(e);
          console.error("Täglicher Lauf komplett gescheitert", e);
          try {
            await meldungAnlegen(env, {
              art: "fehler",
              titel: "Täglicher Lauf komplett gescheitert",
              beschreibung:
                `Der Lauf ist abgebrochen, bevor auch nur eine Quelle geprüft ` +
                `werden konnte: ${text}\n\n` +
                `Solange das so bleibt, veraltet der gesamte Bestand still. ` +
                `Unter "Übersicht" steht, wann zuletzt wirklich geprüft wurde; ` +
                `/api/gesundheit meldet dasselbe als "lauf_ueberfaellig".`,
            });
          } catch {
            // Wenn nicht einmal das geht, ist die Datenbank selbst weg. Dann
            // bleibt nur das Log - und der ueberfaellige Stand auf der Seite.
          }
        }

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
