// Offline tests for the v0.25 additions: the sign-in gate and runPrompt.
// No Microsoft, no Gemini — we mint our own RS256 key, publish it through a
// stubbed JWKS fetch, and sign test tickets with it. Run: node test/auth.test.mjs
import { verifyCaller, verifyIdToken, contentsOf, doRunPrompt } from '../worker.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } }
async function throws(fn, re, msg) {
  try { await fn(); fail++; console.log('  FAIL (no throw):', msg); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.log('  FAIL (wrong message):', msg, '->', e.message); } }
}

const TID = 'ff968505-cca0-4cd1-9f6d-68ce6eaf06c7';
const AUD = '07eef32f-8834-424d-b4fd-ad04c91a3fcf';
const ISS = `https://login.microsoftonline.com/${TID}/v2.0`;

// ---- mint a signing key and a JWKS that serves it ----
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', publicKey);
jwk.kid = 'test-key-1';

const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
async function mint(claims, headerOverride) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...(headerOverride || {}) };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput)))
    .toString('base64url');
  return `${signingInput}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const goodClaims = { iss: ISS, tid: TID, aud: AUD, exp: now + 3600, iat: now, preferred_username: 'Oskar@AUHS.com.au' };

// Route the two outbound fetches: JWKS -> our test key; Gemini -> scripted answers.
let geminiAnswers = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/discovery/v2.0/keys')) return { ok: true, json: async () => ({ keys: [jwk] }) };
  if (u.includes('generativelanguage.googleapis.com')) {
    const text = geminiAnswers.length ? geminiAnswers.shift() : '{}';
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
  }
  throw new Error('unexpected fetch in test: ' + u);
};

// ---- verifyIdToken ----
const good = await mint(goodClaims);
const claims = await verifyIdToken(good);
ok(claims.preferred_username === 'Oskar@AUHS.com.au', 'a good ticket verifies and returns its claims');
const expired = await mint({ ...goodClaims, exp: now - 600 });
await throws(() => verifyIdToken(expired), /expired/, 'an expired ticket is refused');
const wrongAud = await mint({ ...goodClaims, aud: 'some-other-app' });
await throws(() => verifyIdToken(wrongAud), /different app/, 'another app\'s ticket is refused');
const wrongTid = await mint({ ...goodClaims, tid: '11111111-2222-3333-4444-555555555555', iss: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0' });
await throws(() => verifyIdToken(wrongTid), /different organisation/, 'another tenant is refused');
const algNone = await mint(goodClaims, { alg: 'none' });
await throws(() => verifyIdToken(algNone), /not the expected kind/, 'alg:none is refused (algorithm confusion)');
const unknownKid = await mint(goodClaims, { kid: 'unknown-key' });
await throws(() => verifyIdToken(unknownKid), /unknown key/, 'an unknown signing key is refused');
// Tamper: swap the payload after signing.
const tampered = good.split('.');
tampered[1] = b64url({ ...goodClaims, preferred_username: 'attacker@evil.com' });
await throws(() => verifyIdToken(tampered.join('.')), /failed verification/, 'a tampered payload fails the signature');
await throws(() => verifyIdToken('not-a-jwt'), /damaged/, 'garbage is refused politely');

// ---- verifyCaller (allow-list + soft-mode signals) ----
const req = tok => new Request('https://x/', tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
const env = { EMAIL_ALLOWLIST: 'oskar@auhs.com.au, est@auhs.com.au' };
let r = await verifyCaller(req(good), env);
ok(r.ok && r.email === 'oskar@auhs.com.au', 'allow-listed caller passes, email case-folded');
const strangerTok = await mint({ ...goodClaims, preferred_username: 'stranger@auhs.com.au' });
r = await verifyCaller(req(strangerTok), env);
ok(!r.ok && r.present && /not set up/.test(r.message), 'valid ticket, un-listed email -> refused with the email named');
r = await verifyCaller(req(null), env);
ok(!r.ok && r.present === false, 'no ticket -> refused but flagged as ABSENT (soft mode passes this one)');
r = await verifyCaller(req(good), { EMAIL_ALLOWLIST: '' });
ok(!r.ok && /no allow-list/.test(r.message), 'empty allow-list fails CLOSED, not open');

// ---- contentsOf ----
ok(contentsOf({ prompt: 'hi' })[0].parts[0].text === 'hi', 'a plain prompt becomes one user turn');
const c = contentsOf({ messages: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' }], images: [{ base64: 'AAAA', mimeType: 'image/png' }] });
ok(c.length === 3 && c[2].parts.length === 2 && c[2].parts[1].inline_data.data === 'AAAA', 'images ride on the LAST user turn');
ok(contentsOf({}) === null && contentsOf({ messages: [] }) === null, 'no prompt and no messages -> null (400 upstream)');

// ---- doRunPrompt: schema validate + one retry ----
// These are about SCHEMA handling, not model choice — but from Worker v0.30 a
// generating call must name a model (there is no default left in the Worker),
// so they name one and then ignore it. That rule has its own tests in
// test/model.test.mjs.
const MODEL = 'gemini-3.7-flash';
const schema = { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['a', 'b'] } } };
geminiAnswers = ['{"kind":"a"}'];
r = await doRunPrompt({ GEMINI_API_KEY: 'k' }, { prompt: 'p', schema, model: MODEL });
ok(r.output && r.output.kind === 'a' && r.outputValid === true, 'valid first answer -> outputValid true');
geminiAnswers = ['{"kind":"zzz"}', '{"kind":"b"}'];
r = await doRunPrompt({ GEMINI_API_KEY: 'k' }, { prompt: 'p', schema, model: MODEL });
ok(r.output && r.output.kind === 'b' && r.outputValid === true, 'a bad first answer is retried once and corrected');
geminiAnswers = ['{"kind":"zzz"}', '{"kind":"zzz"}'];
r = await doRunPrompt({ GEMINI_API_KEY: 'k' }, { prompt: 'p', schema, model: MODEL });
ok(r.outputValid === false && r.output, 'twice-bad -> outputValid false, output still returned for review');
geminiAnswers = ['{"anything":1}'];
r = await doRunPrompt({ GEMINI_API_KEY: 'k' }, { prompt: 'p', model: MODEL });
ok(r.output && r.output.anything === 1 && r.raw === '{"anything":1}' && !('outputValid' in r), 'no schema -> raw passthrough, no fake outputValid');
await throws(() => doRunPrompt({ GEMINI_API_KEY: 'k' }, {}), /prompt or messages required/, 'empty payload -> 400');

globalThis.fetch = realFetch;
console.log(`\nauth+runPrompt: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
