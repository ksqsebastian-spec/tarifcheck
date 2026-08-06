/** Zeitstempel fuer die Datenbank: ISO-8601 in UTC. */
export const jetzt = (): string => new Date().toISOString();

/** Kompakter Stempel fuer R2-Schluessel: 20260806-0615. */
export function stempel(iso: string = jetzt()): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}
