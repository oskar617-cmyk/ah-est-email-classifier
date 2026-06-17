// Offline unit tests for the Mode-B method runner logic (no Gemini, no network
// except a stubbed fetch). Run: node test/runner.test.mjs
import { buildMethodPrompt, validateOutput, getRecipe } from '../worker.js';
import { FIXTURES } from '../fixtures.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } }
async function throws(fn, predicate, msg) {
  try { await fn(); fail++; console.log('  FAIL (no throw):', msg); }
  catch (e) { if (predicate(e)) pass++; else { fail++; console.log('  FAIL (wrong throw):', msg, '->', e.message); } }
}

const classify = FIXTURES['estimating-email-classify'];

// --- validateOutput ---
ok(validateOutput({ type: 'quote', reason: 'has a price' }, classify.outputSchema).length === 0,
  'valid classify output passes');
ok(validateOutput({ reason: 'no type' }, classify.outputSchema).some(e => /missing required 'type'/.test(e)),
  'missing required field is caught');
ok(validateOutput({ type: 'banana', reason: 'x' }, classify.outputSchema).some(e => /enum/.test(e)),
  'bad enum value is caught');
ok(validateOutput({ type: 123, reason: 'x' }, classify.outputSchema).some(e => /expected string/.test(e)),
  'wrong scalar type is caught');
ok(validateOutput('not an object', classify.outputSchema).some(e => /expected object/.test(e)),
  'wrong root type is caught');

// nested array-of-strings (quote-questions) + null-union (quote-analysis)
const questions = FIXTURES['estimating-quote-questions'];
ok(validateOutput({ questions: ['a', 'b'], draftReply: 'hi' }, questions.outputSchema).length === 0,
  'array-of-strings output passes');
ok(validateOutput({ questions: ['a', 7], draftReply: 'hi' }, questions.outputSchema).some(e => /\[1\].*expected string/.test(e)),
  'bad array item is caught with index');
const analysis = FIXTURES['estimating-quote-analysis'];
ok(validateOutput({ company: 'ABC', amount: null, scopeCoverage: 'unsure' }, analysis.outputSchema).length === 0,
  'null is accepted for a ["number","null"] union');
ok(validateOutput({ company: 'ABC', amount: 'lots', scopeCoverage: 'unsure' }, analysis.outputSchema).some(e => /expected number\|null/.test(e)),
  'non-number, non-null amount is caught');

// --- buildMethodPrompt ---
const prompt = buildMethodPrompt(classify, { subject: 'Re: RFQ', bodyText: 'price is $100' });
ok(prompt.includes(classify.recipe), 'prompt contains the recipe text');
ok(prompt.includes('"type"') && prompt.includes('quote-questions'), 'prompt contains the output schema');
ok(prompt.includes('Worked examples'), 'prompt contains few-shot examples');
ok(prompt.includes('price is $100'), 'prompt contains this input');

// --- getRecipe: fixture mode (no token) ---
const pack = await getRecipe('estimating-email-classify', {});
ok(pack && pack.id === 'estimating-email-classify', 'getRecipe returns the fixture pack offline');
await throws(() => getRecipe('does-not-exist', {}), e => e.status === 404, 'unknown fixture id -> 404');

// --- getRecipe: live mode (stubbed fetch) ---
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ status: 409, ok: false, text: async () => 'changed' });
await throws(() => getRecipe('live-409-method', { VANTA_BASE: 'https://x', VANTA_APP_TOKEN: 't' }),
  e => e.status === 409, 'Vanta 409 -> throws status 409 (re-auth)');
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ id: 'live-ok-method', version: '2.0.0', recipe: 'r', outputSchema: { type: 'object' }, examples: [] }) });
const live = await getRecipe('live-ok-method', { VANTA_BASE: 'https://x', VANTA_APP_TOKEN: 't' });
ok(live && live.id === 'live-ok-method' && live.version === '2.0.0', 'live fetch returns the fetched pack');
globalThis.fetch = realFetch;

console.log(`\nrunner.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
