// Offline tests for v0.29: providers other than Gemini.
//
// Nearly every free API speaks OpenAI's chat-completions shape, so ONE adapter
// covers Groq, OpenRouter, DeepSeek and the rest — a new provider is a row in a
// table, not new logic. The thing worth testing is not the happy path but the
// two ways this hurts you: a provider the app routes here that this Worker
// cannot actually call, and a refusal that arrives as "call failed" instead of
// the provider's own reason.
//   node test/providers.test.mjs
let pass = 0, fail = 0;
let callOpenAICompatible, OPENAI_COMPATIBLE, KNOWN_PROVIDERS, textOf, doRunPrompt, doSetProviderKey;
try {
  ({ callOpenAICompatible, OPENAI_COMPATIBLE, KNOWN_PROVIDERS, textOf, doRunPrompt, doSetProviderKey } =
    await import('../worker.js'));
  if (typeof callOpenAICompatible !== 'function') throw new Error('callOpenAICompatible is not exported');
} catch (e) {
  console.log('  FAIL: the Worker can call a provider other than Gemini at all ->', e.message);
  fail++;
  const dead = async () => { throw new Error('not implemented'); };
  callOpenAICompatible = doRunPrompt = doSetProviderKey = dead;
  OPENAI_COMPATIBLE = {}; KNOWN_PROVIDERS = new Set(); textOf = () => '';
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

let sent = [], answer = null;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), init, body: JSON.parse((init && init.body) || '{}') });
  if (typeof answer === 'function') return answer();
  return resp(true, 200, answer);
};
// A real Response exposes BOTH json() and text(), and the Worker reads the body
// as TEXT so a refusal that is not JSON keeps the provider's own words. A stub
// with json() only made that look like a regression.
const resp = (ok, status, obj) => ({
  ok, status,
  json: async () => obj,
  text: async () => JSON.stringify(obj)
});

const reply = txt => ({ choices: [{ message: { content: txt } }] });
const store = { 'provider-key:groq': JSON.stringify({ apiKey: 'gsk-live' }) };
const ENV = { KEYS: { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } } };
const reset = a => { sent = []; answer = a; };

// ---- 1. the request is the shape they all copied from OpenAI ---------------
reset(reply('{"n":1}'));
let out = await run(() => callOpenAICompatible('groq', 'gsk-live', 'llama-3.3-70b', 'hello', null), 'groq call');
eq(out, '{"n":1}', 'the answer comes back out of choices[0].message.content');
const req = sent[0] || { body: {}, init: { headers: {} } };
ok(/api\.groq\.com/.test(sent[0].url) && /\/chat\/completions$/.test(sent[0].url), 'to that provider\'s chat endpoint');
eq(req.body.model, 'llama-3.3-70b', 'with the model the caller named');
eq(req.body.messages[0].content, 'hello', 'and the prompt as one user turn');
eq(req.body.temperature, 0, 'temperature 0 — these read quotes, they do not write poetry');
eq(req.init.headers.Authorization, 'Bearer gsk-live', 'the key is a bearer header, never in the URL');
ok(!/gsk-live/.test(sent[0].url), 'and really is not in the URL');

// Pictures ride as content parts on the user turn — the OpenAI image shape.
reset(reply('read it'));
await run(() => callOpenAICompatible('groq', 'k', 'm', 'what is this', [{ data: 'AAAA', mimeType: 'image/png' }]), 'vision call');
const parts = (sent[0] || { body: {} }).body.messages[0].content;
ok(Array.isArray(parts) && parts[0].type === 'text' && parts[1].type === 'image_url', 'a picture becomes an image_url part');
ok(/^data:image\/png;base64,AAAA$/.test(parts[1].image_url.url), 'as a data url with the right mime type');

// ---- 2. 🔴 a refusal arrives in the provider's own words -------------------
reset(null);
globalThis.fetch = async () => resp(false, 401, { error: { message: 'Invalid API Key' } });
await throws(() => callOpenAICompatible('groq', 'bad', 'm', 'hi', null), /Invalid API Key/,
  'the provider says why — "call failed" costs an hour guessing between key, model and quota');
await throws(() => callOpenAICompatible('groq', 'bad', 'm', 'hi', null), /Groq/, 'and it says WHICH provider');
globalThis.fetch = async () => { throw new Error('dns go boom'); };
await throws(() => callOpenAICompatible('groq', 'k', 'm', 'hi', null), /could not be reached/, 'unreachable is its own answer');

// ---- 2b. 🔴 a refusal that is NOT JSON still says something useful ----------
// Oskar 2026-08-06: a brand new Cerebras key came back as a bare "HTTP 402".
// res.json() threw on that body, the .catch swallowed it, and the provider's
// reason was replaced by the status number — which tells you nothing to fix.
const textResp = (status, s) => ({ ok: false, status, json: async () => { throw new Error('not json'); }, text: async () => s });
globalThis.fetch = async () => textResp(402, '<html><body>Payment Required</body></html>');
await throws(() => callOpenAICompatible('cerebras', 'k', 'm', 'hi', null), /Payment Required/,
  'an HTML refusal is stripped to its words instead of being dropped');
globalThis.fetch = async () => textResp(402, '');
await throws(() => callOpenAICompatible('cerebras', 'k', 'm', 'hi', null), /billing or credits/,
  'and an EMPTY refusal at least explains what that status number means');
await throws(() => callOpenAICompatible('cerebras', 'k', 'm', 'hi', null), /402/, 'without hiding the number itself');
globalThis.fetch = async () => textResp(429, '');
await throws(() => callOpenAICompatible('groq', 'k', 'm', 'hi', null), /rate limit or free quota/,
  '429 is named too — the one people hit weekly');
// A body that DOES say something must win over our generic explanation.
globalThis.fetch = async () => resp(false, 402, { error: { message: 'Add a payment method to continue' } });
await throws(() => callOpenAICompatible('cerebras', 'k', 'm', 'hi', null), /Add a payment method to continue/,
  'the provider\'s own words come first when there are any');

// ---- 3. 🔴 the two lists must not drift ------------------------------------
// The app routes a job here from its OWN list of providers. One named there and
// missing here would arrive as a mystery instead of running.
globalThis.fetch = async () => resp(true, 200, reply('{}'));
for (const p of Object.keys(OPENAI_COMPATIBLE)) {
  ok(KNOWN_PROVIDERS.has(p), `${p} is in the known-provider list as well as the table`);
  ok(/^https:\/\//.test(OPENAI_COMPATIBLE[p].baseUrl), `${p} has an https base url`);
  ok(!!OPENAI_COMPATIBLE[p].label, `${p} has a human label for its error messages`);
}
ok(KNOWN_PROVIDERS.has('gemini'), 'gemini is known even though it is not OpenAI-compatible');
await throws(() => callOpenAICompatible('nosuch', 'k', 'm', 'hi', null), /Unknown provider/, 'an unlisted provider is refused, not guessed at');
await throws(() => doRunPrompt(ENV, { prompt: 'hi', provider: 'nosuch', model: 'm' }),
  /not a provider this Worker can call/, 'and runPrompt refuses it before doing anything');

// ---- 4. runPrompt routes by the CALLER's provider, never by guessing -------
reset(reply('{"ok":true}'));
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return resp(true, 200, reply('{"ok":true}')); };
await run(() => doRunPrompt(ENV, { prompt: 'hi', provider: 'groq', model: 'llama-3.3-70b' }), 'runPrompt via groq');
ok(/api\.groq\.com/.test((sent[0] || {}).url || ''), 'a groq job goes to groq, not to Gemini');
reset(null);
globalThis.fetch = async (url) => { sent.push({ url: String(url) }); return resp(true, 200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }); };
await run(() => doRunPrompt({ ...ENV, GEMINI_API_KEY: 'g' }, { prompt: 'hi', model: 'gemini-3.6-flash' }), 'runPrompt default');
ok(/generativelanguage\.googleapis\.com/.test((sent[0] || {}).url || ''), 'and no provider named still means Gemini');

// ---- 5. flattening a Gemini payload for a provider that wants messages -----
eq(textOf([{ parts: [{ text: 'a' }, { text: 'b' }] }]), 'a\n\nb', 'every part is kept');
eq(textOf(null), '', 'and nothing is not a crash');

// ---- 6. a reasoning model's thinking is not its answer (v0.33) -------------
// Groq's Qwen (and any model on reasoning_format "raw") sends its thinking in
// <think>…</think> ahead of the JSON. The brace inside the thinking used to be
// taken as the start of the object, so a correct answer "failed the schema".
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), init, body: JSON.parse((init && init.body) || '{}') });
  return typeof answer === 'function' ? answer() : resp(true, 200, answer);
};
const okSchema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
const qwen = { prompt: 'Return exactly this JSON: {"ok":true}', provider: 'groq', model: 'qwen/qwen3.6-27b', schema: okSchema };
reset(reply('<think>\nThe user wants {"ok":true}. I must return exactly that.\n</think>\n{"ok":true}'));
out = await run(() => doRunPrompt(ENV, qwen), 'runPrompt with <think>');
eq(out, { output: { ok: true }, outputValid: true }, 'the answer after the thinking is the answer');
reset(reply('Thinking about {"ok":false} first...\n</think>\n```json\n{"ok":true}\n```'));
out = await run(() => doRunPrompt(ENV, qwen), 'runPrompt, closing tag only');
eq(out, { output: { ok: true }, outputValid: true }, 'a closing tag with no opening tag (Qwen chat template) is handled too');
reset(reply('<think>still thinking about {"ok":'));
out = await run(() => doRunPrompt(ENV, qwen), 'runPrompt, truncated thinking');
eq(out, { output: null, outputValid: false }, 'thinking that never finished is not mistaken for an answer');
reset(reply('Draft: {"ok":false}\nFinal answer: {"ok":true}'));
out = await run(() => doRunPrompt(ENV, qwen), 'runPrompt, prose then answer');
eq(out, { output: { ok: true }, outputValid: true }, 'the LAST balanced object is the answer, not first-brace-to-last-brace');

console.log(`\nproviders: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
