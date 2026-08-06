import { apiRouten } from "./api/routen";
import { fehler, json } from "./lib/antwort";
import type { Env } from "./lib/typen";
import { INTERN_KOPF, alleQuellenAnstossen } from "./sync/cron";
import { quelleAbrufen } from "./sync/quelle";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Interner Weg: nur ueber die Selbstbindung, die der Cron benutzt.
    // Von aussen liegt ohnehin Cloudflare Access davor, aber ein Endpunkt,
    // der fremde Adressen abruft, soll nicht allein daran haengen.
    if (url.pathname.startsWith("/intern/sync/")) {
      if (request.headers.get(INTERN_KOPF) !== "1") return fehler("Nicht erlaubt", 403);
      const quelleId = decodeURIComponent(url.pathname.slice("/intern/sync/".length));
      try {
        return json(await quelleAbrufen(env, quelleId));
      } catch (e) {
        // quelleAbrufen faengt Abruffehler selbst ab und schreibt sie in die
        // Datenbank. Hier landen nur Faelle, in denen die Quelle gar nicht
        // existiert - das soll sichtbar sein, nicht still verschwinden.
        return json(
          { dokument_id: quelleId, status: "fehler", meldung: String(e) },
          500,
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        const antwort = await apiRouten(request, env, url);
        return antwort ?? fehler("Unbekannter Endpunkt", 404);
      } catch (e) {
        console.error("API-Fehler", url.pathname, e);
        return fehler(e instanceof Error ? e.message : String(e), 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  /**
   * Taeglicher Abruf. Der Handler selbst macht fast nichts - er verteilt nur
   * die Arbeit auf einen Aufruf je Quelle. Siehe sync/cron.ts.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      alleQuellenAnstossen(env).then((ergebnisse) => {
        const geaendert = ergebnisse.filter((e) => e.status === "ok").length;
        const fehlgeschlagen = ergebnisse.filter((e) => e.status === "fehler").length;
        console.log(
          `Tarifcheck: ${ergebnisse.length} Quellen, ${geaendert} mit Änderung, ` +
            `${fehlgeschlagen} fehlgeschlagen`,
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
