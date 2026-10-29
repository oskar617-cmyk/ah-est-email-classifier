// Read-only public quotation retrieval. No session, cookies or provider key is forwarded.
const MAX_BYTES = 3 * 1024 * 1024;
const fail = (message, status) => { const e = new Error(message); e.status = status; return e; };
async function boundedBytes(res) {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw fail('That page is too big to read', 413);
  if (!res.body?.getReader) {
    const bytes = new TextEncoder().encode(await res.text());
    if (bytes.length > MAX_BYTES) throw fail('That page is too big to read', 413);
    return bytes;
  }
  const reader = res.body.getReader(), parts = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_BYTES) throw fail('That page is too big to read', 413);
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export async function fetchQuoteResource(p, { publicHttpUrl, htmlToText }) {
  let u = publicHttpUrl(p?.url), res;
  const signal = AbortSignal.timeout(15000);
  for (let hop = 0; hop <= 4; hop++) {
    try { res = await fetch(u.href, { redirect: 'manual', credentials: 'omit', signal,
      headers: { 'User-Agent': 'Vaestimating-Quote-Reader/1.0', Accept: 'application/pdf,text/html,application/xhtml+xml,text/plain;q=0.9' } }); }
    catch (e) { throw fail(`Could not open that link: ${e.message || 'no answer'}`, 502); }
    if (![301,302,303,307,308].includes(res.status)) break;
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (!location || hop === 4) throw fail('That link has too many redirects', 502);
    u = publicHttpUrl(new URL(location, u).href);
  }
  if (!res.ok) throw fail(`That link answered ${res.status}${[401,403].includes(res.status) ? ' — it needs a sign-in we do not have' : res.status === 404 ? ' — that page is gone' : ''}`, res.status);
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const url = publicHttpUrl(res.url || u.href).href;
  if (/pdf/.test(type) && !p.includeDocument) return { kind: 'pdf', url, contentType: 'application/pdf', text: '' };
  if (!/pdf|text\/html|xhtml|text\/plain/.test(type)) throw fail(`That link is ${type.split(';')[0] || 'not a page'}, which cannot be read as a quote`, 415);
  const bytes = await boundedBytes(res);
  if (/pdf/.test(type)) {
    if (!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-')) throw fail('The linked PDF is not a valid PDF document', 422);
    return { kind: 'pdf', url, contentType: 'application/pdf', base64: base64(bytes), size: bytes.length, capturedAt: new Date().toISOString() };
  }
  const raw = new TextDecoder().decode(bytes);
  const title = htmlToText((/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(raw) || [])[1] || '').slice(0,200);
  const full = /text\/plain/.test(type) ? raw.replace(/\r\n/g, '\n').trim() : htmlToText(raw);
  if (p.includeDocument && full.length > 180000) throw fail('That quotation is too long to read completely; download its original PDF', 413);
  const text = p.includeDocument ? full : full.slice(0,12000);
  const downloads = [];
  for (const m of raw.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = htmlToText(m[2]);
    if (!/download|\.pdf(?:[?#]|$)/i.test(m[1] + ' ' + label) || /accept|decline|approve|pay|sign|unsubscribe|terms|conditions/i.test(label + ' ' + m[1])) continue;
    try { const link = publicHttpUrl(new URL(m[1].replace(/&amp;/g, '&'), url).href).href;
      if (!downloads.some(d => d.url === link)) downloads.push({ url: link, label: label || 'Download Quote PDF' });
    } catch { /* unsafe targets are not offered */ }
    if (downloads.length === 5) break;
  }
  return { kind: 'page', url, contentType: type.split(';')[0], title, text, chars: full.length,
    truncated: full.length > text.length, downloads, capturedAt: new Date().toISOString() };
}
