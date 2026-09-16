// Offline tests for v0.36: fetchUrl — reading a page a supplier linked to.
//
// The risky parts are not the happy path. They are: a link that points inside
// our own network, a link that is really a PDF or an image, a page that needs a
// sign-in, and a page so big it would blow the request up. Each gets its own
// answer, in words a human can act on.
//   node --test test/fetchurl.test.mjs
let pass = 0, fail = 0;
let doFetchUrl, htmlToText, publicHttpUrl;
try {
  ({ doFetchUrl, htmlToText, publicHttpUrl } = await import('../worker.js'));
  if (typeof doFetchUrl !== 'function') throw new Error('doFetchUrl is not exported');
} catch (e) {
  console.log('  FAIL: the Worker can fetch a linked page at all ->', e.message);
  fail++;
  const dead = async () => { throw new Error('not implemented'); };
  doFetchUrl = dead; htmlToText = () => ''; publicHttpUrl = () => { throw new Error('not implemented'); };
}
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } };
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want),
  `${msg}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
async function throws(fn, re, msg) {
  try { await fn(); fail++; console.log('  FAIL (no throw):', msg); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.log('  FAIL (wrong message):', msg, '->', e.message); } }
}
const run = async (fn, what) => {
  try { return await fn(); } catch (e) { fail++; console.log(`  FAIL: ${what} threw ->`, e.message); return {}; }
};

let seen = [];
const reply = (body, { type = 'text/html; charset=utf-8', status = 200, url = 'https://app.example.com/compare/abc', length = 0 } = {}) => ({
  ok: status >= 200 && status < 300, status, url,
  headers: { get: k => (String(k).toLowerCase() === 'content-type' ? type : (String(k).toLowerCase() === 'content-length' ? (length || null) : null)) },
  text: async () => body
});
const stub = answer => { globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return typeof answer === 'function' ? answer() : answer; }; };

// ---- 1. a page becomes readable text, and the furniture is dropped ----------
seen = [];
stub(reply(`<!doctype html><html><head><title>PBR Solar - Compare Your Designs</title>
  <style>.a{color:red}</style><script>gtag('config','X');</script></head>
  <body><h1>Your proposal</h1><table><tr><td>System</td><td>$10,659.82</td></tr>
  <tr><td>Battery</td><td>$9,285.59</td></tr></table><p>Total&nbsp;including&nbsp;GST: $16,500.00</p>
  <noscript>Turn on JavaScript</noscript></body></html>`));
let r = await run(() => doFetchUrl({ url: 'https://app.example.com/compare/abc' }), 'fetchUrl');
eq(r.kind, 'page', 'a normal page comes back as a page');
ok(/\$16,500\.00/.test(r.text), 'the total survives into the text');
ok(/\$10,659\.82/.test(r.text) && /\$9,285\.59/.test(r.text), 'so do the line prices');
ok(!/gtag|color:red|Turn on JavaScript/.test(r.text), 'scripts, styles and noscript are dropped - they are not words');
eq(r.title, 'PBR Solar - Compare Your Designs', 'the page title comes back');
ok(/Total including GST/.test(r.text), '&nbsp; becomes a plain space, so the label reads normally');
ok(r.text.includes('System') && r.text.includes('Battery'), 'table cells keep their labels');

// 🔴 Nothing of ours travels to a stranger's site.
const init = (seen[0] || {}).init || {};
const headerNames = Object.keys(init.headers || {}).map(h => h.toLowerCase());
ok(!headerNames.includes('cookie') && !headerNames.includes('authorization'), 'no cookie and no key are sent to the linked site');
ok(/AH-Estimating-Quote-Reader/.test((init.headers || {})['User-Agent'] || ''), 'we say who we are rather than pretending to be a browser');

// ---- 2. a link into our own network is refused, in our words ----------------
for (const bad of ['http://localhost:8181/admin', 'http://127.0.0.1/x', 'http://192.168.1.50/quote',
  'http://10.0.0.8/', 'http://169.254.169.254/latest/meta-data/', 'http://printer.local/status']) {
  await throws(() => doFetchUrl({ url: bad }), /private network/, `${bad} is refused as a private address`);
}
await throws(() => doFetchUrl({ url: 'file:///C:/secrets.txt' }), /Only web addresses/, 'a file:// link is refused');
await throws(() => doFetchUrl({ url: 'https://user:pw@example.com/q' }), /password in it/, 'an address carrying a password is refused');
await throws(() => doFetchUrl({ url: 'not a url' }), /not a web address/, 'nonsense is refused before any request');
ok(typeof publicHttpUrl('https://example.com/a').href === 'string', 'a plain https address passes the check');

// ---- 3. a PDF link is an ANSWER, not a failure -----------------------------
stub(reply('%PDF-1.7 ...', { type: 'application/pdf', url: 'https://cdn.example.com/q.pdf' }));
r = await run(() => doFetchUrl({ url: 'https://cdn.example.com/q.pdf' }), 'pdf link');
eq([r.kind, r.url], ['pdf', 'https://cdn.example.com/q.pdf'], 'a PDF is reported as a PDF so the app can say what to do with it');

// ---- 4. anything else says what it actually is ------------------------------
stub(reply('\x89PNG', { type: 'image/png' }));
await throws(() => doFetchUrl({ url: 'https://example.com/logo.png' }), /image\/png/, 'a picture link names its own type');

// ---- 5. a page behind a sign-in says so -------------------------------------
stub(reply('<html>Forbidden</html>', { status: 403 }));
await throws(() => doFetchUrl({ url: 'https://portal.example.com/q/1' }), /403.*sign-in/, '403 says it needs a sign-in we do not have');
stub(reply('<html>gone</html>', { status: 404 }));
await throws(() => doFetchUrl({ url: 'https://portal.example.com/q/1' }), /404.*gone/, '404 says the page is gone');
globalThis.fetch = async () => { throw new Error('network down'); };
await throws(() => doFetchUrl({ url: 'https://portal.example.com/q/1' }), /Could not open that link/, 'no answer at all is its own message');

// ---- 6. a huge page is cut, and says it was cut -----------------------------
stub(reply(`<html><body>${'word '.repeat(20000)}</body></html>`));
r = await run(() => doFetchUrl({ url: 'https://example.com/long' }), 'long page');
eq([r.text.length, r.truncated, r.chars > 12000], [12000, true, true], 'the text is capped at 12,000 characters and says it was cut');
stub(reply('<html>small</html>', { length: 9 * 1024 * 1024 }));
await throws(() => doFetchUrl({ url: 'https://example.com/huge' }), /too big/, 'a page that announces 9MB is refused before it is read');

// ---- 7. htmlToText on its own ----------------------------------------------
eq(htmlToText('<p>One</p><p>Two</p>'), 'One\nTwo', 'paragraphs become lines, not one run-on sentence');
eq(htmlToText('a &amp; b &lt;c&gt; &#36;5'), 'a & b <c> $5', 'entities are decoded, including numeric ones');
eq(htmlToText(''), '', 'nothing in, nothing out');

console.log(`\nfetchurl: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
