// Offline tests for v0.37: the approved-model list.
//
// The point of this list is that the WORKER refuses a model nobody tested and
// put into use, instead of trusting that a button looked disabled. The two
// dangerous mistakes it must not make: refusing everything when no list has
// been pushed yet (that would stop the inbox on every older copy of the app),
// and accepting anything once a list exists.
//   node --test test/modelallow.test.mjs
let pass = 0, fail = 0;
let doSetModelAllow, doGetModelAllow, requireApprovedModel, doRunPrompt;
try {
  ({ doSetModelAllow, doGetModelAllow, requireApprovedModel, doRunPrompt } = await import('../worker.js'));
  if (typeof doSetModelAllow !== 'function') throw new Error('doSetModelAllow is not exported');
} catch (e) {
  console.log('  FAIL: the approved-model list exists at all ->', e.message);
  fail++;
  const dead = async () => { throw new Error('not implemented'); };
  doSetModelAllow = doGetModelAllow = requireApprovedModel = doRunPrompt = dead;
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

let store = {};
const ENV = { KEYS: { get: async k => store[k] ?? null, put: async (k, v) => { store[k] = v; }, delete: async k => { delete store[k]; } } };
const USER = { ok: true, email: 'est@auhs.com.au' };
const STRANGER = { ok: false, message: 'Sign in to AH Estimating first' };

// ---- 1. no list pushed yet: nothing is refused -----------------------------
store = {};
await run(() => requireApprovedModel(ENV, 'gemini', 'gemini-3.7-flash'), 'unconfigured check');
eq(await run(() => doGetModelAllow(ENV, {}, USER), 'getModelAllow'), { models: [], setBy: '', setAt: '' },
  'an unconfigured Worker says so plainly rather than inventing a list');

// ---- 2. a pushed list is enforced, both ways --------------------------------
const set = await run(() => doSetModelAllow(ENV, { models: [
  { id: 'gemini-3.7-flash', provider: 'gemini' },
  { id: 'openai/gpt-oss-120b', provider: 'groq' },
  { id: 'openai/gpt-oss-120b', provider: 'groq' },          // duplicate
  { id: '', provider: 'groq' }                                // junk
] }, USER), 'setModelAllow');
eq([set.ok, set.count, set.setBy], [true, 2, 'est@auhs.com.au'], 'duplicates and blanks are dropped, and who set it is recorded');
await run(() => requireApprovedModel(ENV, 'gemini', 'gemini-3.7-flash'), 'approved gemini');
await run(() => requireApprovedModel(ENV, 'groq', 'openai/gpt-oss-120b'), 'approved groq');
await throws(() => requireApprovedModel(ENV, 'groq', 'qwen/qwen3.6-27b'), /not on this app's approved list/,
  'a model nobody put into use is refused');
await throws(() => requireApprovedModel(ENV, 'groq', 'qwen/qwen3.6-27b'), /Test it and press Use/,
  'and the refusal says exactly what to do about it');
// The same id under a company that was never approved for it is still refused.
await throws(() => requireApprovedModel(ENV, 'openrouter', 'openai/gpt-oss-120b'), /not on this app's approved list/,
  'the company has to match too - an id alone is not the evidence');

// ---- 3. runPrompt actually consults it --------------------------------------
store['provider-key:groq'] = JSON.stringify({ apiKey: 'gsk-live' });
await throws(() => doRunPrompt(ENV, { prompt: 'hi', provider: 'groq', model: 'qwen/qwen3.6-27b' }),
  /not on this app's approved list/, 'runPrompt refuses before it ever calls the provider');
let called = false;
globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }), text: async () => '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}' }; };
await run(() => doRunPrompt(ENV, { prompt: 'hi', provider: 'groq', model: 'openai/gpt-oss-120b' }), 'approved runPrompt');
ok(called, 'an approved model goes through to the provider as before');

// ---- 4. only a signed-in caller may change the list -------------------------
await throws(() => doSetModelAllow(ENV, { models: [] }, STRANGER), /Sign in/, 'a stranger cannot rewrite the list');
await throws(() => doGetModelAllow(ENV, {}, STRANGER), /Sign in/, 'nor read it');
await throws(() => doSetModelAllow(ENV, { models: 'everything' }, USER), /must be a list/, 'nonsense is refused');

// ---- 5. emptying the list turns the lock OFF, and says so by being empty ----
await run(() => doSetModelAllow(ENV, { models: [] }, USER), 'empty the list');
await run(() => requireApprovedModel(ENV, 'groq', 'anything-at-all'), 'unlocked again');

console.log(`\nmodelallow: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
