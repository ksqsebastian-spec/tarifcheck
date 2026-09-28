/** Exact publisher hosts: redirects are checked as strictly as the initial URL. */
export const QUELLEN_HOSTS = new Set([
  'api.soka-bau.de', 'www.soka-bau.de', 'www.zoll.de', 'www.bmas.de',
  'www.gesetze-im-internet.de', 'www.malerkasse.de',
  'www.geruestbauhandwerk.de', 'www.tischler-nord.de',
]);
export function sichereQuellenUrl(wert: string): URL {
  const url = new URL(wert);
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || !QUELLEN_HOSTS.has(url.hostname)) {
    throw new Error('Nur HTTPS-Adressen der freigegebenen Herausgeber sind erlaubt.');
  }
  return url;
}
export function istPdf(bytes: ArrayBuffer): boolean {
  return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
}
export async function sicherAbrufen(url: string, headers: Record<string, string>): Promise<Response> {
  let ziel = sichereQuellenUrl(url);
  const signal = AbortSignal.timeout(30_000);
  for (let i = 0; i < 6; i++) {
    const response = await fetch(ziel, { headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Weiterleitung ohne Zieladresse');
    ziel = sichereQuellenUrl(new URL(location, ziel).href);
  }
  throw new Error('Zu viele Weiterleitungen bei der Quelle');
}
