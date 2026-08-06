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

/** Zustandslos: pro Anfrage ein frischer Server, keine Durable Objects noetig. */
export function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "tarifcheck", version: "1.0.0" },
        { instructions: ANLEITUNG },
      );
      werkzeugeAnmelden(server, env);
      return server;
    },
    {
      route: "/mcp",
      // Der OAuth-Provider haengt die Angaben zum angemeldeten Nutzer an den
      // Ausfuehrungskontext. Von dort reichen wir sie an die Werkzeuge weiter.
      authContext: { props: (ctx as unknown as { props?: Record<string, unknown> }).props ?? {} },
    },
  );
  return handler(request, env, ctx);
}
