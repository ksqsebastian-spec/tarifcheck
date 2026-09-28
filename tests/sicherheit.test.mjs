import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sichereQuellenUrl, sicherAbrufen, istPdf } from '../src/lib/sicherheit.ts';

test('publisher URLs accepted; private networks, credentials and lookalike hosts blocked', () => {
  assert.equal(sichereQuellenUrl('https://www.zoll.de/test.pdf').hostname, 'www.zoll.de');
  for (const url of ['http://www.zoll.de/test.pdf', 'https://127.0.0.1/', 'https://[::1]/', 'https://www.zoll.de.evil.example/', 'https://user:pass@www.zoll.de/', 'https://www.zoll.de:8443/', 'https://169.254.169.254/']) {
    assert.throws(() => sichereQuellenUrl(url));
  }
});

test('PDF signature rejects HTML error pages even when named .pdf', () => {
  assert.equal(istPdf(new TextEncoder().encode('%PDF-1.7\n').buffer), true);
  assert.equal(istPdf(new TextEncoder().encode('<html>Access denied</html>').buffer), false);
  assert.equal(istPdf(new ArrayBuffer(0)), false);
});

test('redirect to an unapproved host is rejected before the second fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.com/private' } }); };
  try {
    await assert.rejects(sicherAbrufen('https://www.zoll.de/test.pdf', {}));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('relative same-publisher redirects work and carry timeout and manual mode', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return calls.length === 1 ? new Response(null, { status: 301, headers: { location: '/new.pdf' } }) : new Response('%PDF-1.7');
  };
  try {
    const response = await sicherAbrufen('https://www.zoll.de/old.pdf', {});
    assert.equal(await response.text(), '%PDF-1.7');
    assert.deepEqual(calls, ['https://www.zoll.de/old.pdf', 'https://www.zoll.de/new.pdf']);
  } finally { globalThis.fetch = original; }
});
