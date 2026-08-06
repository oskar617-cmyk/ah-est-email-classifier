// Offline tests for the v0.26 company key store: geminiKey resolution order,
// setProviderKey (hard gate + validate-before-store) and keyStatus. No
// Microsoft, no Gemini, no KV — same stub pattern as auth.test.mjs: mint our
// own RS256 key, serve it through a stubbed JWKS fetch, script Gemini's
// answers, and back KV with a plain object. Run: node test/keys.test.mjs
import worker, { geminiKey, doSetProviderKey, doKeyStatus, bustKeyCache, verifyCaller } from '../worker.js';

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
async function mint(claims) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput)))
    .toString('base64url');
  return `${signingInput}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const ticketFor = email => mint({ iss: ISS, tid: TID, aud: AUD, exp: now + 3600, iat: now, preferred_username: email });

// ---- stub KV + outbound fetch (JWKS -> our key, Gemini -> scripted) ----
const store = {};
const KEYS = { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } };

// geminiScript entries: { ok:true, text } (an answer) or { ok:false, status, body }.
let geminiScript = [];
let geminiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/discovery/v2.0/keys')) return { ok: true, json: async () => ({ keys: [jwk] }) };
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    const s = geminiScript.length ? geminiScript.shift() : { ok: true, text: '{"ok":true}' };
    if (!s.ok) return { ok: false, status: s.status || 400, text: async () => s.body || 'boom' };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: s.text }] } }] }) };
  }
  throw new Error('unexpected fetch in test: ' + u);
};

// user@ is allowed to USE the AI but is not a key admin — the interesting gap.
const env = {
  KEYS,
  EMAIL_ALLOWLIST: 'oskar@auhs.com.au,est@auhs.com.au,user@auhs.com.au',
  KEY_ADMINS: 'oskar@auhs.com.au,est@auhs.com.au',
  CORS_ORIGINS: 'https://ah-estimating.pages.dev',
  REQUIRE_AUTH: '0'
};

const req = tok => new Request('https://x/', tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
const authAdmin = await verifyCaller(req(await ticketFor('Oskar@AUHS.com.au')), env);
const authUser  = await verifyCaller(req(await ticketFor('user@auhs.com.au')), env);
const authNone  = await verifyCaller(req(null), env);
ok(authAdmin.ok && authUser.ok && !authNone.ok && authNone.present === false, 'test tickets verify as expected');

// ---- (a) geminiKey read-through order: KV > env secret > human throw ----
bustKeyCache();
await throws(() => geminiKey({ KEYS }), /not set — an admin can paste it in AH Estimating Settings/,
  'no KV record, no secret -> the "paste it in Settings" message, not a code error');
bustKeyCache();
ok(await geminiKey({ KEYS, GEMINI_API_KEY: 'env-secret-key' }) === 'env-secret-key',
  'no KV record -> the deploy-time secret is the fallback');
bustKeyCache();
store['provider-key:gemini'] = JSON.stringify({ apiKey: 'AIzaKvCompanyKey00001111', setBy: 'oskar@auhs.com.au', setAt: '2026-08-01T00:00:00.000Z' });
ok(await geminiKey({ KEYS, GEMINI_API_KEY: 'env-secret-key' }) === 'AIzaKvCompanyKey00001111',
  'a KV record beats the env secret');
// The 60s cache: a KV change made BEHIND the Worker's back is served stale...
store['provider-key:gemini'] = JSON.stringify({ apiKey: 'AIzaSneakyDirectEdit0000', setBy: 'x', setAt: 'x' });
ok(await geminiKey({ KEYS }) === 'AIzaKvCompanyKey00001111',
  'within 60s the cached key is served (one KV read per isolate per minute)');

// ---- (b) ...but a successful setProviderKey busts the cache immediately ----
geminiScript = [{ ok: true, text: '{"ok":true}' }];
const setRes = await doSetProviderKey(env, { provider: 'gemini', apiKey: 'AIzaRotatedByAdmin9876' }, authAdmin);
ok(await geminiKey(env) === 'AIzaRotatedByAdmin9876',
  'setProviderKey busts the cache — the new key is live immediately, not in 60s');

// ---- (e) the success response + the stored record ----
ok(setRes.ok === true && setRes.provider === 'gemini' && setRes.last4 === '9876',
  'success response carries ok + provider + last4');
ok(setRes.setBy === 'oskar@auhs.com.au' && !Number.isNaN(Date.parse(setRes.setAt)),
  'success response says who set it and when (ISO)');
ok(!JSON.stringify(setRes).includes('AIzaRotatedByAdmin9876'),
  'the response NEVER contains the key itself');
const storedRec = JSON.parse(store['provider-key:gemini']);
ok(storedRec.apiKey === 'AIzaRotatedByAdmin9876' && storedRec.setBy === 'oskar@auhs.com.au' && !Number.isNaN(Date.parse(storedRec.setAt)),
  'KV record holds the key + setBy + ISO setAt');

// ---- (c) hard gate: valid ticket required, then KEY_ADMINS on top ----
await throws(() => doSetProviderKey(env, { provider: 'gemini', apiKey: 'AIzaValidLooking00000000' }, authNone),
  /ticket is missing/, 'no ticket -> refused even though REQUIRE_AUTH=0');
await throws(() => doSetProviderKey(env, { provider: 'gemini', apiKey: 'AIzaValidLooking00000000' }, authUser),
  /key admin/, 'allow-listed but not a key admin -> refused, mentions admin');
const callsBefore = geminiCalls;
// v0.28 opened this to every provider the Worker can actually CALL. The rule
// worth keeping is not "gemini only" — it is that the two lists cannot drift:
// a provider it has no caller for must be refused, not stored and left to fail
// on the first real job.
await throws(() => doSetProviderKey(env, { provider: 'openai', apiKey: 'sk-SomeOtherProvider0000' }, authAdmin),
  /not a provider this Worker can call/, 'a provider with no caller here is refused');
await throws(() => doSetProviderKey(env, { provider: 'gemini', apiKey: '   ' }, authAdmin),
  /does not look like an API key/, 'a blank/mangled paste is refused');
ok(geminiCalls === callsBefore, 'refused candidates never reach Gemini');

// ---- (d) a dead candidate key is validated and NOT stored ----
const recBefore = store['provider-key:gemini'];
geminiScript = [{ ok: false, status: 400, body: 'API key not valid. Please pass a valid API key.' }];
await throws(() => doSetProviderKey(env, { provider: 'gemini', apiKey: 'AIzaDeadCandidateKey0000' }, authAdmin),
  /NOT saved.*API key not valid/, 'dead candidate -> refused with the provider\'s real reason');
ok(store['provider-key:gemini'] === recBefore, 'the working key is untouched after a failed validation');

// ---- end-to-end through the fetch handler: the gate holds in soft mode ----
const post = (task, payload, tok) => worker.fetch(new Request('https://x/', {
  method: 'POST',
  headers: { 'Origin': 'https://ah-estimating.pages.dev', 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: JSON.stringify({ task, payload })
}), env);
let res = await post('setProviderKey', { provider: 'gemini', apiKey: 'AIzaValidLooking00000000' }, null);
ok(res.status === 401, 'end-to-end: ticketless setProviderKey is 401 even in soft mode');
res = await post('keyStatus', {}, null);
ok(res.status === 401, 'end-to-end: ticketless keyStatus is 401 even in soft mode');
res = await post('setProviderKey', { provider: 'gemini', apiKey: 'AIzaValidLooking00000000' }, await ticketFor('user@auhs.com.au'));
ok(res.status === 403 && /key admin/.test((await res.json()).error), 'end-to-end: non-admin gets a 403 with the admin message');

// ---- (f) keyStatus shapes for source app / fallback-secret / none ----
let st = await doKeyStatus(env, {}, authUser);
ok(st.provider === 'gemini' && st.configured === true && st.source === 'app'
  && st.last4 === '9876' && st.setBy === 'oskar@auhs.com.au' && !Number.isNaN(Date.parse(st.setAt)),
  'keyStatus source=app: last4/setBy/setAt from the KV record (provider defaults to gemini)');
ok(!JSON.stringify(st).includes('AIzaRotatedByAdmin9876'), 'keyStatus never leaks the key');
delete store['provider-key:gemini'];
st = await doKeyStatus({ ...env, GEMINI_API_KEY: 'env-secret-key' }, { provider: 'gemini' }, authUser);
ok(st.configured === true && st.source === 'fallback-secret' && st.last4 === '' && st.setBy === '' && st.setAt === '',
  'keyStatus source=fallback-secret: configured but anonymous (env secret is opaque)');
st = await doKeyStatus(env, {}, authUser);
ok(st.configured === false && st.source === 'none' && st.last4 === '',
  'keyStatus source=none when there is no key anywhere');
await throws(() => doKeyStatus(env, {}, authNone), /ticket is missing/,
  'keyStatus also demands a valid ticket, even in soft mode');
// ---- (g) 🔴 keyStatus answers for EVERY provider this Worker can call -------
// It used to refuse everything but Gemini. The moment the app grew a shared-key
// box for Groq and Cerebras (v1.2.0), each one showed a red "Could not check
// this key: Only the gemini key lives here so far" above a box that would have
// taken a key perfectly well (Oskar 2026-08-06: "后面两个无法连接api").
// A Worker WITHOUT this fix throws here instead of answering. Catch it so the
// file still prints a total: a crash reads the same as a clean run to anything
// checking the last line.
const statusOf = async (e, p_) => { try { return await doKeyStatus(e, p_, authUser); } catch (err) { return { error: err.message }; } };
store['provider-key:groq'] = JSON.stringify({ apiKey: 'gsk_liveLookingKey1234', setBy: 'oskar@auhs.com.au', setAt: '2026-08-06T00:00:00.000Z' });
st = await statusOf(env, { provider: 'groq' });
ok(st.provider === 'groq' && st.configured === true && st.source === 'app' && st.last4 === '1234',
  'keyStatus answers for groq, from that provider\'s own KV record');
ok(!JSON.stringify(st).includes('gsk_liveLookingKey1234'), 'and never leaks that key either');
st = await statusOf(env, { provider: 'cerebras' });
ok(st.configured === false && st.source === 'none' && st.last4 === '',
  'a provider with no key saved reports none - not an error');
// The deploy-time secret is Gemini's alone: another provider must never inherit
// it and claim to be configured when nothing was ever pasted for it.
st = await statusOf({ ...env, GEMINI_API_KEY: 'env-secret-key' }, { provider: 'cerebras' });
ok(st.configured === false && st.source === 'none',
  'and it does NOT pick up the Gemini deploy-time secret');
await throws(() => doKeyStatus(env, { provider: 'openai' }, authUser), /is not a provider this Worker can call/,
  'a provider this Worker cannot call is still refused, by name');
await throws(() => doKeyStatus(env, { provider: 'nonsense' }, authUser), /is not a provider this Worker can call/,
  'and so is anything unrecognised');

// ---- (h) 🔴 forgetting a key you no longer use -----------------------------
// There was no way to remove a stored key at all: an unused provider key sat on
// the server for ever. Clearing is an EXPLICIT flag, never "empty apiKey means
// delete" — a mis-wired form posting '' would otherwise wipe the company key
// and stop every computer at once.
store['provider-key:groq'] = JSON.stringify({ apiKey: 'gsk_stillHereForNow123', setBy: 'oskar@auhs.com.au', setAt: '2026-08-06T00:00:00.000Z' });
const cleared = await doSetProviderKey(env, { provider: 'groq', clear: true }, authAdmin);
ok(cleared.ok === true && cleared.cleared === true && cleared.provider === 'groq', 'clear reports what it did');
ok(store['provider-key:groq'] === undefined, 'and the record is really gone from the store');
st = await statusOf(env, { provider: 'groq' });
ok(st.configured === false && st.source === 'none', 'keyStatus agrees straight afterwards');
// An empty paste must NOT be read as "delete".
store['provider-key:groq'] = JSON.stringify({ apiKey: 'gsk_mustSurviveThis1234', setBy: 'x', setAt: 'x' });
await throws(() => doSetProviderKey(env, { provider: 'groq', apiKey: '' }, authAdmin),
  /does not look like an API key/, 'an EMPTY apiKey is refused, not treated as a delete');
ok(JSON.parse(store['provider-key:groq']).apiKey === 'gsk_mustSurviveThis1234', 'and the stored key survives it');
// Forgetting is a key-admin action like setting one.
await throws(() => doSetProviderKey(env, { provider: 'groq', clear: true }, authUser),
  /key admin/, 'a non-admin cannot forget a key either');
await throws(() => doSetProviderKey(env, { provider: 'groq', clear: true }, authNone),
  /ticket is missing/, 'nor can a ticketless caller');
ok(JSON.parse(store['provider-key:groq']).apiKey === 'gsk_mustSurviveThis1234', 'both refusals left the key alone');
await throws(() => doSetProviderKey(env, { provider: 'openai', clear: true }, authAdmin),
  /not a provider this Worker can call/, 'and an unknown provider is still refused on the clear path');

globalThis.fetch = realFetch;
console.log(`\nkeys: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
