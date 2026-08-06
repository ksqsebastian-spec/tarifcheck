import { DurableObject } from "cloudflare:workers";

/**
 * Zaehlt Anmeldeversuche - verlaesslich.
 *
 * Dritter Anlauf, die beiden ersten waren wirkungslos und sahen es nicht:
 *
 * 1. Ein Zaehler in KV. KV ist eventual consistent; bei schnell
 *    aufeinanderfolgenden Versuchen war der Zaehler nie rechtzeitig da.
 *    Zwoelf Fehlversuche liefen ungebremst durch.
 * 2. Der ratelimit-Binding. Der zaehlt je Instanz, nicht je Standort: 13
 *    Aufrufe innerhalb einer Anfrage werden gebremst, 13 einzelne Anfragen
 *    nicht. Die Doku nennt ihn selbst "permissive by design, not suitable for
 *    accurate accounting".
 *
 * Ein Durable Object ist die einzige Stelle in dieser Laufzeitumgebung, die
 * stark konsistent zaehlt: je Schluessel genau eine Instanz, die Aufrufe
 * nacheinander abarbeitet. Was hier gezaehlt wird, stimmt.
 */
export class Bremse extends DurableObject {
  private async stand(fensterMs: number) {
    const jetzt = Date.now();
    const s = await this.ctx.storage.get<{ start: number; anzahl: number }>("stand");
    return !s || jetzt - s.start > fensterMs ? { start: jetzt, anzahl: 0 } : s;
  }

  /** Nur nachsehen. Ein richtiges Passwort soll nichts verbrauchen. */
  async offen(grenze: number, fensterMs: number): Promise<boolean> {
    return (await this.stand(fensterMs)).anzahl < grenze;
  }

  /**
   * Zaehlt einen Fehlversuch.
   *
   * Bewusst nur Fehlversuche: wer sich richtig anmeldet, soll sich nicht am
   * eigenen Limit aussperren koennen.
   */
  async fehlversuch(fensterMs: number): Promise<void> {
    const s = await this.stand(fensterMs);
    s.anzahl += 1;
    await this.ctx.storage.put("stand", s);
    // Aufraeumen, damit nicht fuer jede je gesehene Adresse etwas liegen bleibt.
    await this.ctx.storage.setAlarm(Date.now() + fensterMs * 2);
  }

  async zuruecksetzen(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
