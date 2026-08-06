// Offline tests for v0.27: THE CALLER PICKS THE MODEL.
//
// The Worker used to hardcode gemini-3.1-flash-lite in six places, and only one
// of them accepted an override — which is why the whole app was pinned to 3.1
// no matter what the settings screen said. Every task now takes the model from
// its payload. These tests watch the URL that actually goes to Google, because
// that string is the only proof that a choice made in the app reached the wire.
//
// No network: fetch is stubbed and every request URL is recorded.
//   node test/model.test.mjs
// Imported dynamically so a Worker WITHOUT this feature reports countable
// failures instead of dying on the import line — a crash scrolls past as noise
// and looks the same as a clean run to anything reading the last line.
let pass = 0, fail = 0;
let modelFor, geminiUrl, validateGeminiKey, doRunPrompt, doClassify, doVisionOcr;
try {
  ({ modelFor, geminiUrl, validateGeminiKey, doRunPrompt, doClassify, doVisionOcr } = await import('../worker.js'));
  if (typeof modelFor !== 'function') throw new Error('modelFor is not exported');
} catch (e) {
  console.log('  FAIL: the Worker lets the caller pick a model at all ->', e.message);
  fail++;
  modelFor = () => '(no modelFor)';
  geminiUrl = () => '(no geminiUrl)';
  const dead = async () => { throw new Error('not implemented'); };
  validateGeminiKey = doRunPrompt = doClassify = doVisionOcr = dead;
}

const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n        want ${want}\n        got  ${got}`);
async function throws(fn, re, msg) {
  try { await fn(); fail++; console.log('  FAIL (no throw):', msg); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.log('  FAIL (wrong message):', msg, '->', e.message); } }
}

// ---- record every URL, answer whatever the test scripted --------------------
let urls = [];
let answers = [];
globalThis.fetch = async (url) => {
  urls.push(String(url));
  const text = answers.length ? answers.shift() : '{}';
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
};
// The model sits between "/models/" and ":generateContent" in the request path.
const modelsHit = () => urls.map(u => (u.match(/\/models\/([^:]+):generateContent/) || [])[1]);
const reset = (...scripted) => { urls = []; answers = scripted; };
// A task that blows up is a FAIL for the assertions that follow it, not a
// crash that takes the whole file down before it can report anything.
const run = async (fn, what) => {
  try { return await fn(); }
  catch (e) { fail++; console.log(`  FAIL: ${what} threw ->`, e.message); return null; }
};

const ENV = { KEYS: { get: async () => JSON.stringify({ apiKey: 'k-live' }), put: async () => {} } };

// ---- 0. 🔴 v0.30: NO MODEL ID IS WRITTEN IN THIS WORKER ----------------------
// Asserted against the source, not only behaviour: a reinstated constant would
// quietly restore the exact bug this release deletes — the app saying one model
// and a different one answering.
const SRC = await (await import('node:fs')).promises.readFile(new URL('../worker.js', import.meta.url), 'utf8');
const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const hard = CODE.match(/['"]gemini-[a-z0-9.-]+['"]/g) || [];
ok(hard.length === 0, `no Gemini model id is hardcoded in worker.js -> found ${JSON.stringify(hard)}`);

// ---- 1. modelFor: the resolver -----------------------------------------------
// Absent is now a REFUSAL, not a fallback. It practically only happens when a
// device still has an app build from before v1.1.0 cached, so the message says
// to reload rather than reporting a bad request.
for (const p of [{}, { model: '' }, { model: '   ' }, undefined]) {
  await throws(async () => modelFor(p), /did not say which model/,
    `${JSON.stringify(p)} is refused instead of silently substituted`);
}
try { modelFor({}); } catch (e) {
  ok(e.status === 400, 'and it is a 400 the caller can see');
  ok(/[Rr]eload/.test(e.message), 'that tells the user what to actually do about it');
}
eq(modelFor({ model: 'gemini-3.7-flash' }), 'gemini-3.7-flash', 'a named model is used verbatim');
eq(modelFor({ model: '  gemini-3.7-flash  ' }), 'gemini-3.7-flash', 'trimmed');
// Google's list API returns ids as "models/<id>"; pasting one straight in must work.
eq(modelFor({ model: 'models/gemini-3.7-flash' }), 'gemini-3.7-flash', 'the models/ prefix from Google\'s list is stripped');

// 🔴 The id lands in the URL PATH while the api key rides in the same URL's
// query string, so a smuggled separator would rewrite the request.
for (const bad of ['a/../b', 'x?key=stolen', 'y#frag', 'a b', 'a&b=1', '../../etc', 'x'.repeat(65)]) {
  await throws(async () => modelFor({ model: bad }), /not a usable/, `"${bad}" is refused, not passed into the URL`);
}
// And refused LOUDLY — never quietly swapped for the default.
try { modelFor({ model: 'x?key=stolen' }); } catch (e) {
  ok(e.status === 400, 'a bad id is a 400 the caller can see');
  ok(!e.message.includes('k-live'), 'the error never echoes anything key-shaped');
}

// ---- 2. 🔴 the choice actually reaches Google -------------------------------
reset('{"ok":true}');
await run(() => doRunPrompt(ENV, { prompt: 'hi', model: 'gemini-3.7-flash' }), 'runPrompt');
eq(modelsHit()[0], 'gemini-3.7-flash', 'runPrompt calls the model the app chose');

reset('{"ok":true}');
await throws(() => doRunPrompt(ENV, { prompt: 'hi' }), /did not say which model/,
  'and a request naming none is refused end-to-end, not just in the resolver');
eq(urls.length, 0, 'with nothing sent to Google — no model ran');

// The one internal guard: even a caller inside this file cannot go model-less
// and produce ".../models/:generateContent".
await throws(async () => geminiUrl('', 'k-live'), /without a model/, 'geminiUrl refuses an empty model');
ok(!(() => { try { geminiUrl('', 'k-live'); } catch (e) { return e.message.includes('k-live'); } return false; })(),
  'and that guard never echoes the key');

reset('{"type":"quote"}');
await run(() => doClassify('k', { subject: 's', bodyText: 'b', model: 'gemini-3.7-flash' }), 'classify');
eq(modelsHit()[0], 'gemini-3.7-flash', 'classify does too - it is the highest-volume task');

reset('some text');
await run(() => doVisionOcr('k', { images: [{ base64: 'AAA', mimeType: 'image/png' }], model: 'gemini-3.7-flash' }), 'visionOcr');
eq(modelsHit()[0], 'gemini-3.7-flash', 'and so does the picture reader');

// ---- 3. the validation retry must NOT change model --------------------------
// Two answers: the first fails the schema, the second passes. Both must go to
// the same model - being answered by a model you did not pick is the exact
// failure this release exists to end.
reset('{"wrong":1}', '{"n":2}');
const SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };
const out = (await run(() => doRunPrompt(ENV, { prompt: 'hi', schema: SCHEMA, model: 'gemini-3.7-flash' }), 'runPrompt retry')) || {};
eq(urls.length, 2, 'the schema retry really happened');
eq(modelsHit()[1], 'gemini-3.7-flash', 'the retry goes back to the SAME model');
ok(out.outputValid === true, 'and the corrected answer is accepted');

// ---- 4. a bad id stops the call, it does not downgrade it -------------------
reset('{"ok":true}');
await throws(() => doRunPrompt(ENV, { prompt: 'hi', model: 'gemini/../evil' }), /not a usable/,
  'runPrompt refuses a malformed id');
eq(urls.length, 0, 'and nothing was sent to Google at all');

// ---- 4b. 🔴 a provider's model id is judged by THAT provider's rules --------
// Oskar 2026-08-06: "后面两个无法连接api". Groq and Cerebras could not be called at
// all. modelFor applied Gemini's URL-path charset (no slash) to every provider,
// but OpenAI-compatible ids are namespaced -- and theirs travel in the JSON
// BODY, where a slash cannot rewrite anything. Every Groq model was refused,
// with a message telling the user to send a Gemini id instead.
// eqSafe, not eq: on a Worker WITHOUT this fix modelFor throws here, and a
// thrown error would take the whole file down before it printed a total — which
// reads exactly like a clean run to anything checking the last line.
const eqSafe = (fn, want, msg) => {
  let got; try { got = fn(); } catch (e) { got = `threw: ${e.message}`; }
  eq(got, want, msg);
};
for (const id of ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-scout-17b']) {
  eqSafe(() => modelFor({ model: id }, 'groq'), id, `"${id}" is accepted for an OpenAI-compatible provider`);
  await throws(async () => modelFor({ model: id }, 'gemini'), /not a usable gemini model id/,
    `and still refused for GEMINI, where it would rewrite the URL`);
}
// The slash is the only relaxation. Anything that could still break a request stays out.
for (const bad of ['x?key=stolen', 'y#frag', 'a b', 'a&b=1', 'x'.repeat(97)]) {
  await throws(async () => modelFor({ model: bad }, 'groq'), /not a usable groq model id/,
    `"${bad}" is refused for groq too`);
}
// And the advice names the right provider — "send a plain Gemini model id" is
// not something you can act on when you are choosing a Groq model.
try { modelFor({ model: 'a b' }, 'groq'); } catch (e) {
  ok(/groq/.test(e.message) && !/Gemini model id/.test(e.message),
    'the error names the provider you were actually using');
  ok(/vendor\/model/.test(e.message), 'and describes the right shape');
  ok(!/gemini-[0-9]/.test(e.message), 'without naming a model id — that would put one back in the Worker');
}
// "models/" is Google's list format; stripping it elsewhere would mangle a name.
eqSafe(() => modelFor({ model: 'models/foo' }, 'groq'), 'models/foo', 'the Google prefix is not stripped from other providers');

// ---- 4c. end to end: a Groq call is not judged by Gemini's rules ------------
reset('{"ok":true}');
await run(() => doRunPrompt(ENV, { prompt: 'hi', model: 'openai/gpt-oss-120b', provider: 'groq' }), 'groq runPrompt');
ok(urls.length === 1, 'a Groq request actually goes out');
ok(!/generativelanguage/.test(urls[0] || ''), 'and not to Google');

// ---- 5. checking a KEY needs no model ---------------------------------------
// This is what let the constant go. Saving a key used to require picking a model
// to test it with, and picking one meant hardcoding one. models.list proves the
// key works and names nothing.
reset();
await run(() => validateGeminiKey('k-candidate'), 'validateGeminiKey');
eq(urls.length, 1, 'validating a key makes exactly one call');
ok(/\/v1beta\/models\?/.test(urls[0] || ''), 'to the model LIST endpoint, not a generation');
ok(!/generateContent/.test(urls[0] || ''), 'so no model id appears anywhere in it');
ok(!(urls[0] || '').includes('k-candidate'), 'and the candidate key stays out of the URL (it rides in a header)');

console.log(`\nmodel: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
