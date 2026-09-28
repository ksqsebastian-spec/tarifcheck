import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env, SyncErgebnis } from '../lib/typen';
import { aktiveQuellen } from '../lib/db';

/** On-demand executor. ChatGPT owns the schedule; this has no timer of its own. */
export class TarifUpdate extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const quellen = await step.do('Quellen laden', async () => {
      await this.env.DB.prepare('INSERT OR IGNORE INTO sync_laeufe (id, gestartet_am) VALUES (?, ?)')
        .bind(event.instanceId, new Date().toISOString()).run();
      return (await aktiveQuellen(this.env)).results.map(q => q.id);
    });
    const ergebnisse: SyncErgebnis[] = [];
    for (const id of quellen) {
      try {
        ergebnisse.push(await step.do(`Prüfen ${id}`, {
          retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
          timeout: '3 minutes',
        }, async () => {
          const result = await this.env.SELF.quelleAbrufen(id);
          if (result.status === 'fehler') throw new Error(result.meldung || 'Abruf fehlgeschlagen');
          return result;
        }));
      } catch (e) {
        ergebnisse.push({ dokument_id: id, status: 'fehler', meldung: String(e) });
      }
    }
    const fehler = ergebnisse.filter(e => e.status === 'fehler').length;
    const result = { quellen: quellen.length, fehler, ergebnisse };
    await step.do('Ergebnis speichern', async () => {
      await this.env.DB.prepare('UPDATE sync_laeufe SET beendet_am = ?, status = ?, ergebnisse = ? WHERE id = ?')
        .bind(new Date().toISOString(), fehler ? 'teilfehler' : 'ok', JSON.stringify(result), event.instanceId).run();
    });
    await step.do('OAuth aufräumen', async () => {
      try { await this.env.SELF.oauthAufraeumen(); }
      catch (error) { console.error('OAuth cleanup failed', error); }
    });
    return result;
  }
}
