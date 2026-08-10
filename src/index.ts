import { WorkerEntrypoint } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { apiRouten } from "./api/routen";
import { oauthRouten } from "./auth/oauth";

export { Bremse } from "./auth/bremse";
import { fehler } from "./lib/antwort";
import { meldungAnlegen } from "./lib/db";
import type { Env } from "./lib/typen";
import { mcpHandler, toolsJson } from "./mcp/server";
import { alleQuellenAnstossen } from "./sync/cron";
import { quelleAbrufen } from "./sync/quelle";

/**
 * Kopfzeilen, die auf jeder Antwort der Seite stehen. Vorher stand keine
 * einzige davon da.
 *
 * `frame-ancestors 'none'` ist der eigentliche Anlass: hinter der Anmeldung
 * liegen Knoepfe, die schreiben, und die Seite liess sich in einen fremden
 * Rahmen setzen. Gegen das Mitschicken fremder Formulare hilft schon
 * SameSite=Lax am Sitzungskeks; gegen einen untergeschobenen Klick nicht.
 *
 * `'unsafe-inline'` steht nur bei den Stilen, und das mit Absicht: die
 * Oberflaeche faerbt jedes Gewerk ueber ein style-Attribut. Skripte brauchen
 * es nicht - es gibt kein einziges Inline-Skript, alles liegt in /app.js.
 */
const SCHUTZKOPFZEILEN: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function mitSchutz(antwort: Response): Response {
  const kopf = new Headers(antwort.headers);
  for (const [name, wert] of Object.entries(SCHUTZKOPFZEILEN)) kopf.set(name, wert);
  return new Response(antwort.body, {
    status: antwort.status,
    statusText: antwort.statusText,
    headers: kopf,
  });
}

/**
 * Die Seite: Dashboard, JSON-Schnittstelle, der interne Abrufweg und die
 * Anmeldemasken des MCP.
 *
 * Lesen geht ohne Anmeldung. Geschrieben wird nur mit gueltiger Sitzung - das
 * Tor dafuer steht in api/routen.ts, baulich vor allen Schreibrouten.
 */
const seitenHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Katalog fuer den MCP-Hub. Ohne Anmeldung, enthaelt nur Tool-Namen und
    // -Beschreibungen. Muss offen sein, damit der Hub ihn holen kann.
    if (url.pathname === "/tools.json") return mitSchutz(await toolsJson(env, ctx));

    // Anmeldemaske des MCP unter /authorize
    const anmeldung = await oauthRouten(request, env as never, url);
    if (anmeldung) return mitSchutz(anmeldung);

    if (url.pathname.startsWith("/api/")) {
      try {
        return mitSchutz(
          (await apiRouten(request, env, url)) ?? fehler("Unbekannter Endpunkt", 404),
        );
      } catch (e) {
        // Die Meldung der Datenbank gehoert ins Log, nicht in die Antwort:
        // "D1_ERROR: datatype mismatch: SQLITE_MISMATCH" half draussen
        // niemandem und verriet nur, was drinnen laeuft.
        console.error("API-Fehler", url.pathname, e);
        return mitSchutz(
          fehler("Unerwarteter Fehler. Die Einzelheiten stehen im Log (wrangler tail).", 500),
        );
      }
    }

    return mitSchutz(await env.ASSETS.fetch(request));
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
