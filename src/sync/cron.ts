import { aktiveQuellen } from "../lib/db";
import type { Env, SyncErgebnis } from "../lib/typen";

/**
 * Stoesst pro Quelle einen eigenen Aufruf an, statt alle der Reihe nach
 * abzuarbeiten.
 *
 * Zwei Gruende: jede Quelle bekommt ihr eigenes Rechenzeit-Budget (im
 * Free-Plan sind das 10 ms pro Aufruf), und eine haengende oder kaputte
 * Quelle reisst die anderen nicht mit.
 *
 * Der Weg geht ueber die Selbstbindung als RPC, also am Netzwerk vorbei.
 * Ueber HTTP ist dieser Weg gar nicht erst erreichbar - ein Endpunkt, der
 * fremde Adressen abruft, hat im offenen Netz nichts zu suchen.
 */
export async function alleQuellenAnstossen(
  env: Env,
  nur?: string[],
): Promise<SyncErgebnis[]> {
  const { results } = await aktiveQuellen(env);
  const quellen = nur?.length ? results.filter((q) => nur.includes(q.id)) : results;

  const ergebnisse: SyncErgebnis[] = [];

  // In kleinen Gruppen, um nicht in das Limit gleichzeitiger Verbindungen zu laufen.
  const GRUPPE = 5;
  for (let i = 0; i < quellen.length; i += GRUPPE) {
    const teil = quellen.slice(i, i + GRUPPE);
    const antworten = await Promise.allSettled(
      teil.map((q) => env.SELF.quelleAbrufen(q.id)),
    );

    antworten.forEach((a, idx) => {
      if (a.status === "fulfilled") {
        ergebnisse.push(a.value);
      } else {
        // Der Aufruf selbst ist gescheitert, nicht der Abruf. Selten, aber
        // dann fehlt in der Datenbank sonst jede Spur davon.
        ergebnisse.push({
          dokument_id: teil[idx].id,
          status: "fehler",
          meldung: String(a.reason),
        });
      }
    });
  }

  return ergebnisse;
}
