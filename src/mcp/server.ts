import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../lib/typen";
import { werkzeugeAnmelden } from "./werkzeuge";

const ANLEITUNG = `
Tarifverträge der Gruppenwerk-Gewerke: Bau, Gerüstbau, Maler, Tischler.

Alle Werkzeuge liefern ein Feld "vorbehalte". Was dort steht, gehört in die
Antwort — es entscheidet, ob eine Zahl überhaupt belastbar ist. Insbesondere:

- Tischlerhandwerk hat keine Allgemeinverbindlicherklärung. Es gibt keine
  amtliche Volltextquelle; automatisch überwacht wird nur eine Downloadseite.
- Wo "quelle_typ" gleich "watch" ist, ist der Inhalt der Text einer
  Downloadseite und KEIN Vertragstext. Niemals als Vertragsinhalt wiedergeben.
- Beim Maler-Rahmentarifvertrag kursieren ältere Fassungen. Ohne Stand und
  Gültigkeitsdatum ist eine Zahl daraus wertlos — beides immer mitnennen.

Für gezielte Fragen tarife_durchsuchen benutzen, nicht ganze Verträge lesen.
`.trim();

export const VERSION = "1.0.0";

const bauen = (env: Env) => {
  const server = new McpServer(
    { name: "tarifcheck", version: VERSION },
    { instructions: ANLEITUNG },
  );
  werkzeugeAnmelden(server, env);
  return server;
};

/**
 * Katalog fuer den MCP-Hub, ohne Anmeldung erreichbar.
 *
 * Der Hub holt hier die Tool-Liste, um sie anzuzeigen. Bewusst nicht abgefragt,
 * sondern beim eigentlichen Server erfragt: eine zweite, von Hand gepflegte
 * Liste wuerde frueher oder spaeter etwas anderes behaupten als der Server
 * tatsaechlich kann.
 *
 * Preisgegeben werden nur Namen und Beschreibungen der Werkzeuge - keine
 * Tarifdaten. Die liegen hinter dem Token.
 */
export async function toolsJson(env: Env, ctx: ExecutionContext): Promise<Response> {
  const anfrage = new Request("https://intern/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  const antwort = await createMcpHandler(() => bauen(env), { route: "/mcp" })(
    anfrage,
    env,
    ctx,
  );

  const roh = await antwort.text();
  const zeile = roh.includes("data:")
    ? roh.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : roh;

  let tools: unknown[] = [];
  try {
    tools = JSON.parse(zeile ?? "{}")?.result?.tools ?? [];
  } catch {
    // Lieber eine leere Liste als eine halb geparste - der Hub zeigt dann
    // "nicht erreichbar" statt einer erfundenen Auswahl.
  }

  return new Response(
    JSON.stringify({ server: { name: "tarifcheck", version: VERSION }, tools }, null, 2),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    },
  );
}

/** Zustandslos: pro Anfrage ein frischer Server, keine Durable Objects noetig. */
export function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const handler = createMcpHandler(
    () => bauen(env),
    {
      route: "/mcp",
      // Der OAuth-Provider haengt die Angaben zum angemeldeten Nutzer an den
      // Ausfuehrungskontext. Von dort reichen wir sie an die Werkzeuge weiter.
      authContext: { props: (ctx as unknown as { props?: Record<string, unknown> }).props ?? {} },
    },
  );
  return handler(request, env, ctx);
}
