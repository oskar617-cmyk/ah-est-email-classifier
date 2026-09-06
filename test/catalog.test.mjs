// Offline tests for v0.28: listModels + the shared Vaenyx relay key.
//
// Two jobs that both serve "set it once, every device has it":
//  - listModels asks GOOGLE what models this key can use, so a new Gemini turns
//    up in the dropdown by itself. It is not the Survey button — that asks an
//    AI, and an AI will invent models.
//  - getRelayKey / setRelayKey keep the app's Vaenyx key in KV so each browser
//    collects it once. That key is the ONE credential meant to reach a browser,
//    so who may collect it is the thing worth testing hardest.
//
// No network, no KV: fetch is stubbed and KV is a plain object.
//   node test/catalog.test.mjs
let pass = 0, fail = 0;
let doListModels, doGetRelayKey, doSetRelayKey;
try {
  ({ doListModels, doGetRelayKey, doSetRelayKey } = await import('../worker.js'));
  if (typeof doListModels !== 'function') throw new Error('doListModels is not exported');
} catch (e) {
  console.log('  FAIL: the Worker has the catalogue + relay-key tasks at all ->', e.message);
  fail++;
  const dead = async () => { throw new Error('not implemented'); };
  doListModels = doGetRelayKey = doSetRelayKey = dead;
}

// A task that blows up is a FAIL for what follows, never a crash that takes the
// file down before it can report — a crash and a clean run look identical to
// anything reading the last line.
const run = async (fn, what) => {
  try { return await fn(); }
  catch (e) { fail++; console.log(`  FAIL: ${what} threw ->`, e.message); return { models: [], token: '' }; }
};
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } };
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want),
  `${msg}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
async function throws(fn, re, msg) {
  try { await fn(); fail++; console.log('  FAIL (no throw):', msg); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.log('  FAIL (wrong message):', msg, '->', e.message); } }
}

// ---- stub the world ---------------------------------------------------------
let store = {};
const KEYS = {
  get: async k => store[k] ?? null,
  put: async (k, v) => { store[k] = v; },
  delete: async k => { delete store[k]; }
};
const ENV = { KEYS, KEY_ADMINS: 'oskar@auhs.com.au,est@auhs.com.au' };
let reply = null, seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), headers: (init && init.headers) || {} });
  if (typeof reply === 'function') return reply();
  return { ok: true, status: 200, json: async () => reply };
};
const ADMIN = { ok: true, email: 'oskar@auhs.com.au' };
const USER = { ok: true, email: 'est@auhs.com.au' };
const STRANGER = { ok: false, message: 'Sign in to AH Estimating first' };

const model = (name, methods, extra) => ({ name, supportedGenerationMethods: methods, ...(extra || {}) });
const reset = r => { seen = []; reply = r; store = { 'provider-key:gemini': JSON.stringify({ apiKey: 'k-live' }) }; };

// ---- 1. listModels: Google's answer, filtered honestly ----------------------
reset({ models: [
  model('models/gemini-3.7-flash', ['generateContent'], { displayName: 'Gemini 3.7 Flash', description: 'newest', inputTokenLimit: 1048576 }),
  model('models/gemini-3.6-flash', ['generateContent', 'countTokens'], { displayName: 'Gemini 3.6 Flash' }),
  model('models/text-embedding-004', ['embedContent'], { displayName: 'Embeddings' }),
  model('models/imagen-3', ['predict'], { displayName: 'Imagen 3' })
] });
let r = await run(() => doListModels(ENV), 'listModels');
eq(r.models.map(m => m.id), ['gemini-3.7-flash', 'gemini-3.6-flash'],
  'only models you can hold a conversation with — embeddings and image generators are not chat models');
eq((r.models[0] || {}).label, 'Gemini 3.7 Flash', 'the display name is used when there is one');
eq((r.models[0] || {}).inputTokenLimit, 1048576, 'and the token limit comes through');
ok(/^models\//.test('models/x') && !/^models\//.test((r.models[0] || {}).id || ''),
  'the models/ prefix is stripped — leaving it builds /models/models/... on the next call');

// A model with no displayName must still be offered, under its id.
reset({ models: [model('models/gemini-x', ['generateContent'])] });
r = await run(() => doListModels(ENV), 'listModels');
eq([r.models.length, (r.models[0] || {}).label], [1, 'gemini-x'], 'a missing display name falls back to the id, it does not drop the model');

// 🔴 The key travels in a header, never the URL: a URL reaches logs, history
// and referrers, and this is the company's key.
reset({ models: [] });
await run(() => doListModels(ENV), 'listModels');
ok(!/k-live/.test((seen[0] || {}).url || ''), 'the api key is NOT in the request URL');
eq(((seen[0] || {}).headers || {})['x-goog-api-key'], 'k-live', 'it rides in the header instead');
ok(/pageSize=1000/.test((seen[0] || {}).url || ''),
  'a big page is asked for — the default 50 silently truncates and reads as "the API is broken"');

// Paging: page 2 must actually be fetched.
reset(null);
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const first = calls === 1;
  seen.push({ url: String(url), headers: {} });
  return { ok: true, status: 200, json: async () => first
    ? { models: [model('models/a', ['generateContent'])], nextPageToken: 'PAGE2' }
    : { models: [model('models/b', ['generateContent'])] } };
};
r = await run(() => doListModels(ENV), 'listModels paging');
eq(r.models.map(m => m.id), ['a', 'b'], 'every page is collected, not just the first');
ok(/pageToken=PAGE2/.test((seen[1] || {}).url || ''), 'and the token is passed back');

// Google saying no is reported in Google's words, not swallowed into an empty list.
globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid' } }) });
await throws(() => doListModels(ENV), /API key not valid/, 'Google\'s own reason is passed through');

// ---- 2. 🔴 who may collect the relay key -----------------------------------
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
reset(null);
await run(() => doSetRelayKey(ENV, { token: 'vaenyx_app_abcdefghijklmnop' }, ADMIN), 'setRelayKey');
eq((await run(() => doGetRelayKey(ENV, {}, USER), 'getRelayKey')).token, 'vaenyx_app_abcdefghijklmnop',
  'a signed-in user on the allowlist collects it — that is the whole point');
await throws(() => doGetRelayKey(ENV, {}, STRANGER), /Sign in/,
  'no valid ticket, no key — hard, even while the sign-in gate is soft for everything else');
await throws(() => doGetRelayKey(ENV, {}, undefined), /Sign in/, 'and a missing ticket is not a loophole');

// Handing one out is a bigger privilege than using one.
await throws(() => doSetRelayKey(ENV, { token: 'vaenyx_app_abcdefghijklmnop' }, { ok: true, email: 'someone@auhs.com.au' }),
  /Only a key admin/, 'a non-admin cannot replace it');
await throws(() => doSetRelayKey(ENV, { token: 'vaenyx_app_x' }, STRANGER), /Sign in/, 'nor can a stranger');

// An obviously wrong paste is refused rather than stored and left to fail later.
await throws(() => doSetRelayKey(ENV, { token: 'vaenyx_method_abcdefghijkl' }, ADMIN),
  /starts with vaenyx_app_/, 'a Method Token is not this app\'s relay key');
await throws(() => doSetRelayKey(ENV, { token: 'short' }, ADMIN), /starts with vaenyx_app_/, 'nor is a stub');
eq((await run(() => doGetRelayKey(ENV, {}, USER), 'getRelayKey')).token, 'vaenyx_app_abcdefghijklmnop',
  'and a refused paste leaves the working key untouched');

// Clearing is explicit, and absence is not an error — most of the time there is
// simply no shared key yet and the app uses whatever this browser holds.
await run(() => doSetRelayKey(ENV, { token: '' }, ADMIN), 'clear');
eq((await run(() => doGetRelayKey(ENV, {}, USER), 'getRelayKey')).token, '', 'an empty token clears it');
store = {};
eq((await run(() => doGetRelayKey(ENV, {}, USER), 'getRelayKey')).token, '', 'no record at all is an empty answer, not a failure');

// A mangled record must not take the app down either.
store = { 'relay-key:vaenyx': '{not json' };
eq((await run(() => doGetRelayKey(ENV, {}, USER), 'getRelayKey')).token, '', 'a corrupt record degrades to "none"');

// ---- listModels for an OpenAI-compatible provider (v0.34) -------------------
// Groq answers GET /models in the shape they all copied from OpenAI; retired
// models stay in the list with active:false and must not be offered.
store['provider-key:groq'] = JSON.stringify({ apiKey: 'gsk-live' });
seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), headers: (init && init.headers) || {} });
  const body = { data: [
    { id: 'qwen/qwen3.8-27b', owned_by: 'Alibaba', active: true, context_window: 131072 },
    { id: 'llama-4-scout', owned_by: 'Meta', active: false },
    { id: 'whisper-large-v3', owned_by: 'OpenAI', active: true }
  ] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};
r = await run(() => doListModels(ENV, { provider: 'groq' }), 'listModels groq');
eq(r.models.map(m => m.id), ['qwen/qwen3.8-27b', 'whisper-large-v3'], 'active models come back under their ids; a retired one (active:false) is dropped');
ok(/api\.groq\.com\/openai\/v1\/models$/.test((seen[0] || {}).url || ''), 'asked at that provider\'s /models endpoint');
eq(((seen[0] || {}).headers || {}).Authorization, 'Bearer gsk-live', 'with the company key as a Bearer header');
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }), text: async () => JSON.stringify({ error: { message: 'Invalid API Key' } }) });
await throws(() => doListModels(ENV, { provider: 'groq' }), /Groq refused the model list — Invalid API Key/, 'a refusal carries the provider\'s own words');
await throws(() => doListModels(ENV, { provider: 'nosuch' }), /not a provider this Worker can list/, 'an unknown provider is refused, not guessed at');

console.log(`\ncatalog: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
