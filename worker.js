// AH Estimating — Classifier Worker (Cloudflare Workers)
//
// Server-side AI gateway for the AH Estimating PWA. The app owns its
// estimating-specific prompts; `runPrompt` verifies the caller, adds the
// company Gemini key, forwards the prompt/media, and optionally validates the
// JSON result. Compatibility helpers remain for vision/amount matching, while
// takeoff still uses the Vaenyx-backed runMethod/getRecipe/feedback path.
//
// The Gemini API key never ships to the browser. Since v0.26 it lives in the
// KEYS KV namespace ("provider-key:gemini" — pasted once by an admin in AH
// Estimating Settings, rotated by pasting again), with the GEMINI_API_KEY
// Worker secret kept as a deploy-time fallback. CORS_ORIGINS is a
// comma-separated list of allowed origins and fails closed when absent.
//
// Endpoint: POST /  (root). The PWA's CONFIG.classifierUrl points here.
// Request body:  { task, payload }
// Response body: { result }            on success
//                { error: "..." }      on failure

// Bump on every release. Mirrored as X-Worker-Version header on every
// response so the live version can be verified post-deploy without
// reading logs. Format: v[MAJOR].[MINOR][.PATCH]. History:
//   v0.01 — initial worker
//   v0.02 — README updates (tuning workflow + doc-dropper warning)
//   v0.03 — switch to gemini-3.1-flash-lite
//   v0.04 — switch to gemini-3-flash
//   v0.05 — add runMethod task (Vanta Mode-B recipe runner)
//   v0.06 — gemini-3-flash 404s on this key; switch to gemini-2.5-flash
//           (fixes classify/extractAmount too)
//   v0.07 — recipe cache: 1-day TTL + serve-stale-on-error
//   v0.08 — add sendCorrection task (Vanta flywheel feedback forwarder)
//   v0.09 — add visionAmount task (read the amount off a scanned PDF/image
//           quote with Gemini vision, when there is no text layer)
//   v0.10 — switch model to gemini-3.1-flash-lite (free tier: far higher daily
//           quota than 2.5-flash's 250 RPD; supports vision + JSON)
//   v0.11 — harden the vision prompt against hallucinated amounts (flash-lite
//           invented a total for a blank image; now told to null unreadables)
//   v0.12 — drop the trade hint from vision (it biased fabrication) + temp 0;
//           blank images now reliably return null across the lite models
//   v0.13 — add matchBudgetItem task (AI picks the budget item for a quote when
//           the filename didn't map)
//   v0.14 — amount prompts (vision + extractAmount) now require the GST-INCLUSIVE
//           grand total (was ambiguous)
//   v0.15 — vision amount: sharper prompt (total labels + read every digit) +
//           retry a null read with a more capable model (gemini-2.5-flash)
//   v0.16 — v0.15 prompt over-pushed: an example figure + "largest number"
//           language made models invent a total for a blank image. Reverted to a
//           label-guided but honest prompt (null unless a total is clearly seen)
//   v0.17 — drop the 2.5-flash retry: it HALLUCINATED a total ($1045 from a blank)
//   v0.18 — root cause was the prompt's "Total/Grand Total/..." LABEL LIST, which
//           primed a receipt hallucination on a blank. Removed it; the simple
//           honest prompt returns null on a blank for BOTH models (verified)
//   v0.19 — drop the 2.5-flash retry for good: its 250 req/day free tier 429s
//           almost immediately under bulk. Single honest 3.1-flash-lite (big free
//           quota, no hallucination). Recall lever is now image quality, not model
//   v0.20 — visionAmount accepts an images[] array (multiple page PNGs), so the
//           app can send HIGH-DPI page renders of a scanned PDF instead of the raw
//           PDF (sharper digits -> better reads, still honest)
//   v0.21 — add visionOcr task (transcribe an image/scan to text so it runs the
//           SAME text amount/analysis path). Amount readers now report gstIncluded
//           (true/false/null) and NO LONGER add GST themselves — the app grosses up
//           an ex-GST total by the 10% default, uniformly across readers
//   v0.22 — lock the front door: requests must carry an allowed Origin (403
//           otherwise — stops anonymous quota burning), CORS_ORIGINS fails closed
//           when unset, and a per-isolate 90 req/min rate limit backs it up
//   v0.23 — runMethod accepts images[] (page renders) as Gemini media parts, so
//           vision methods like estimating-drawing-takeoff can read drawings;
//           text-only methods unchanged
//   v0.24 — add getRecipe task: recipe-pack passthrough for the app's Direct AI
//           mode (Vaenyx blocks browser CORS, so the app fetches JUST the recipe
//           here and runs the model itself on the user's own key). Same cache /
//           409 semantics as runMethod; still behind the Origin gate
//   v0.25 — embed era, step 1 (app AGENTS「AI 内嵌化」). Two things:
//           (1) runPrompt — the app now OWNS its prompts (js/methods/ in the
//               app repo); this Worker just adds the key, forwards, and when the
//               payload carries a JSON-Schema validates the output (same
//               validate/retry semantics as runMethod, so outputValid means the
//               same thing everywhere). Old tasks all stay until cutover.
//           (2) sign-in gate — every task now checks the caller's MSAL ID token
//               (RS256 signature via the tenant's JWKS, tid, aud, exp, and the
//               user on the EMAIL_ALLOWLIST env var). Soft while REQUIRE_AUTH
//               is unset/0: a request that BRINGS a ticket must bring a valid
//               one, a ticketless request still passes (deployed app keeps
//               working until it ships tickets). Flip REQUIRE_AUTH=1 to close.
//               Authorization joins the CORS allow-list for the preflight.
//   v0.26 — company key store: an admin pastes the Gemini key ONCE in AH
//           Estimating (Settings → Model Connections); it lives in KV as
//           "provider-key:gemini" and every task resolves it via geminiKey()
//           (60s isolate cache -> KV -> GEMINI_API_KEY secret fallback). New
//           tasks: setProviderKey (KEY_ADMINS only, hard-gated even in soft
//           auth mode, candidate key validated against Gemini BEFORE storing)
//           and keyStatus (configured/source/last4 — the key itself never
//           goes back to the browser).
//   v0.27 — THE CALLER PICKS THE MODEL. Every Gemini task payload may carry
//           `model` (a plain Gemini model id); absent or blank falls back to
//           GEMINI_MODEL, so an older app build keeps working byte-for-byte.
//           An id that is present but malformed is a 400, never a quiet
//           downgrade to the default — being answered by a model you did not
//           choose is the failure this whole change exists to end. The
//           key-validation call in setProviderKey deliberately stays on the
//           fixed default: it validates the KEY, not the model. (current)
const VERSION = 'v0.27';

// DEFAULT model — used only when the caller does not name one (see modelFor).
// gemini-2.5-flash's free tier is only 250 requests/day, too small for bulk
// folder scans; gemini-3.1-flash-lite has a much larger free allowance and
// still does vision + strict-JSON output.
// (NB: the id "gemini-3-flash" 404s — it doesn't exist; the real ids are
// gemini-3.1-flash-lite / gemini-3-flash-preview.)
//
// This constant is a TRANSITION fallback, not a choice. Which model runs is the
// app owner's setting, and hardcoding it here is exactly what pinned the whole
// app to 3.1 for months. It is deleted once the app sends a model on every
// call. See ah-estimating/docs/architecture.md, "模型与钥匙:一处设置,处处生效".
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

// Resolve the model for one request. The id is concatenated into the Gemini URL
// PATH while the api key rides in the same URL's query string, so a `/`, `?` or
// `#` smuggled in here would rewrite the request — hence the charset gate.
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
function modelFor(p) {
  let m = (p && typeof p.model === 'string') ? p.model.trim() : '';
  if (!m) return GEMINI_MODEL;
  m = m.replace(/^models\//, '');   // Google's list API returns "models/<id>"
  if (!MODEL_ID_RE.test(m)) {
    const e = new Error(`Unknown model id "${m.slice(0, 60)}" — send a plain Gemini model id, e.g. gemini-3.1-flash-lite`);
    e.status = 400; throw e;
  }
  return m;
}

import { FIXTURES } from './fixtures.js';

// How many of a recipe's worked examples to include as few-shot context.
const MAX_EXAMPLES = 3;
// Per-isolate recipe cache (methodId -> { pack, at }). Vanta is pull-based (it
// can't notify us when a method changes), so we re-fetch a recipe when the
// cached copy is older than RECIPE_TTL_MS — picking up edited recipes and
// auto-updated examples within a day. A 409 on fetch means re-authorization is
// needed; other fetch errors fall back to the stale cached copy.
const recipeCache = new Map();
const RECIPE_TTL_MS = 24 * 60 * 60 * 1000;   // re-fetch a cached recipe once a day

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    // If CORS_ORIGINS is missing, fail CLOSED (deny) — not open to '*'.
    const allowed = parseAllowed(env.CORS_ORIGINS || '');
    const corsOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : (allowed[0] || ''));
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin || 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      'X-Worker-Version': VERSION
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'POST only' }, 405, corsHeaders);
    }
    // ORIGIN GATE: the PWA is the only legitimate caller, and browsers always
    // send Origin on cross-site POSTs. curl/scripts (no Origin) and foreign
    // sites get 403 — otherwise anyone with this URL can burn the whole daily
    // Gemini free-tier quota and stall the email pipeline. (Origin is spoofable
    // server-side, so a light per-isolate rate limit below backs this up.)
    if (!allowed.includes('*') && !allowed.includes(origin)) {
      return jsonResponse({ error: 'Forbidden' }, 403, corsHeaders);
    }
    if (rateLimited()) {
      return jsonResponse({ error: 'Rate limited — slow down and retry shortly' }, 429, corsHeaders);
    }
    // SIGN-IN GATE (all tasks): the Origin gate keeps browsers honest but is
    // spoofable server-side — this is the real lock. Soft while REQUIRE_AUTH
    // is unset/0: a request that BRINGS a ticket must bring a VALID one (our
    // own app should never send junk), a ticketless request still passes so
    // the already-deployed app keeps working until it ships tickets.
    const auth = await verifyCaller(request, env);
    if (!auth.ok && (auth.present || String(env.REQUIRE_AUTH || '') === '1')) {
      return jsonResponse({ error: auth.message }, 401, corsHeaders);
    }
    let body;
    try { body = await request.json(); }
    catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    // NB: no pre-dispatch "key configured?" check — each Gemini task resolves
    // the key via geminiKey(env), whose per-task error tells the human WHERE
    // to fix it (paste it in Settings), which a blanket 500 here never could.
    const { task, payload = {} } = body || {};
    try {
      let result;
      if (task === 'classify')               result = await doClassify(await geminiKey(env), payload);
      else if (task === 'extractAmount')     result = await doExtractAmount(await geminiKey(env), payload);
      else if (task === 'visionAmount')      result = await doVisionAmount(await geminiKey(env), payload);
      else if (task === 'visionOcr')         result = await doVisionOcr(await geminiKey(env), payload);
      else if (task === 'matchBudgetItem')   result = await doMatchBudgetItem(await geminiKey(env), payload);
      else if (task === 'summarizeFilename') result = await doSummarizeFilename(await geminiKey(env), payload);
      else if (task === 'runPrompt')         result = await doRunPrompt(env, payload);
      else if (task === 'runMethod')         result = await doRunMethod(env, payload);
      else if (task === 'getRecipe')         result = await doGetRecipe(env, payload);
      else if (task === 'sendCorrection')    result = await doSendCorrection(env, payload);
      else if (task === 'setProviderKey')    result = await doSetProviderKey(env, payload, auth);
      else if (task === 'keyStatus')         result = await doKeyStatus(env, payload, auth);
      else return jsonResponse({ error: 'Unknown task' }, 400, corsHeaders);
      return jsonResponse({ result }, 200, corsHeaders);
    } catch (err) {
      // Propagate a Vanta 409 (method changed since this app was authorized)
      // so the PWA can prompt the Owner to re-authorize.
      if (err && err.status === 409) {
        return jsonResponse({ error: 'needs-reauth' }, 409, corsHeaders);
      }
      // The key-store tasks gate HARD inside the handler (soft mode does not
      // apply to them) — let their 401/403 out with the human message intact.
      if (err && (err.status === 401 || err.status === 403)) {
        return jsonResponse({ error: err.message }, err.status, corsHeaders);
      }
      if (err && err.status === 400) {
        return jsonResponse({ error: (err.message) || 'Bad request' }, 400, corsHeaders);
      }
      console.error('Worker task failed:', err && err.stack || err);
      return jsonResponse({ error: (err && err.message) || 'Worker error' }, 500, corsHeaders);
    }
  }
};

// ---------- Tasks ----------

async function doClassify(apiKey, p) {
  const prompt = `You are classifying a single supplier email reply for a construction estimator.

CONTEXT (already established by the matcher — relevance is NOT in question):
- This reply is for an RFQ in the trade category: ${safe(p.rfqCategory) || '(unspecified)'}
- For the job at: ${safe(p.jobAddress) || '(unspecified)'}
- The supplier we sent the RFQ to: ${safe(p.supplierCompany) || '(unspecified)'}

You only need to label what KIND of reply this is, not whether it relates to our RFQ. The matcher already determined that — even if the body mentions a different trade word (e.g. "concrete" appearing in a Balustrade RFQ thread), treat it as related to the trade above.

Respond with STRICT JSON only, no prose, no markdown fences, with this shape:

  {"classification":"Quote|Question|Suspicious|Out-of-Office|Decline|Unrelated","confidence":0..1}

Definitions:
- Quote: supplier sent a price (in body or attachment) for the requested work.
- Question: supplier wants more info before quoting (asking about scope, drawings, etc).
- Suspicious: looks like phishing, scam, mismatched sender, or otherwise unusual.
- Out-of-Office: automated away/vacation reply.
- Decline: supplier explicitly says they can't or won't quote.
- Unrelated: use ONLY if the supplier is replying about a completely different topic that has nothing to do with quoting/scope/timing/the job.

Confidence is your best self-estimate of the classification (0 = unsure, 1 = certain).

EMAIL DATA:
Subject: ${safe(p.subject)}
From name: ${safe(p.fromName)}
From email: ${safe(p.fromEmail)}
Body (truncated):
${safe(p.bodyText)}`;

  const text = await callGemini(apiKey, prompt, modelFor(p));
  const json = parseJson(text);
  if (!json) return { classification: 'Question', confidence: 0 };
  return {
    classification: validClassification(json.classification),
    confidence: clamp01(json.confidence)
  };
}

async function doExtractAmount(apiKey, p) {
  const prompt = `Extract the total quoted amount (in AUD) from this supplier email and any attached PDF text.
Respond with STRICT JSON only:

  {"amount":<number-or-null>,"gstIncluded":<true|false|null>,"currency":"AUD","notes":"<brief reason>"}

Rules:
- amount = the final grand total the supplier is quoting (the total payable / grand total line) — a single number. Never the lowest line item.
- gstIncluded = true if that total already includes GST; false if the quote states the figure EXCLUDES GST (e.g. "ex GST", "+ GST", "plus GST", "excluding GST"); null if not stated. Do NOT add or remove GST yourself — report the printed figure and whether it includes GST.
- If no total can be confidently read, amount = null. Don't invent a number.

EMAIL SUBJECT: ${safe(p.subject)}
EMAIL BODY (truncated):
${safe(p.bodyText)}

ATTACHMENT TEXT (truncated):
${safe(p.attachmentText)}`;

  const text = await callGemini(apiKey, prompt, modelFor(p));
  const json = parseJson(text);
  if (!json) return { amount: null, currency: 'AUD', gstIncluded: null };
  return {
    amount: typeof json.amount === 'number' ? json.amount : null,
    gstIncluded: typeof json.gstIncluded === 'boolean' ? json.gstIncluded : null,
    currency: json.currency || 'AUD',
    notes: json.notes || ''
  };
}

// Read the amount (and supplier) off a SCANNED quote — a PDF with no text layer,
// or an image (jpg/png). We send the file itself to Gemini vision (multimodal),
// since there is no text to extract. payload: { fileBase64, mimeType, hint }.
async function doVisionAmount(apiKey, p) {
  // Accept EITHER a single file (fileBase64 + mimeType) OR an array of page
  // images (images:[{base64, mimeType}]). The app renders scanned PDFs to
  // high-DPI PNGs and sends them as images, so the model reads sharper digits.
  const media = mediaFromPayload(p);
  if (!media.length) { const e = new Error('fileBase64 or images required'); e.status = 400; throw e; }
  // NB: do NOT feed the item/trade hint into this prompt — it biases a small
  // model into inventing a plausible company + total when the scan is unreadable
  // (observed: a blank image returned "$1450 from A1 Painting" when hinted
  // "Painting"). Read only what is actually on the page.
  const prompt = `You are shown an image/scan that should be a supplier price quote. Respond with STRICT JSON only:

  {"amount":<number-or-null>,"gstIncluded":<true|false|null>,"currency":"AUD","company":"<supplier name or empty>"}

Rules:
- amount = the final grand total figure ACTUALLY PRINTED on the quote (the total payable / grand total), as a single plain number (no $ or commas). Never a single line item, never the smallest number.
- gstIncluded = true if that printed total already includes GST; false if the quote states the figure EXCLUDES GST (e.g. "ex GST", "+ GST", "plus GST", "excluding GST"); null if it is not stated. Do NOT add or remove GST yourself — just report the printed figure and whether it includes GST.
- company = ONLY a supplier name you can actually read; otherwise "".
- If the image is blank, unreadable, not a price quote (a safety document, a rate card with no single total, etc.), or you cannot clearly SEE a printed total, set amount to null and company to "".
- NEVER guess, estimate, calculate, or invent. A null is FAR better than a wrong number. Only report figures you can actually read on the page.`;
  const json = parseJson(await callGeminiVision(apiKey, prompt, media, modelFor(p)));
  return {
    amount: (json && typeof json.amount === 'number') ? json.amount : null,
    gstIncluded: (json && typeof json.gstIncluded === 'boolean') ? json.gstIncluded : null,
    currency: (json && json.currency) || 'AUD',
    company: (json && json.company) || ''
  };
}

// Transcribe ALL readable text off an image/scan (OCR), so a photographed or
// scanned quote can go through the SAME text amount/analysis path (incl. GST
// handling) as a text PDF. Accepts images:[{base64,mimeType}] or fileBase64.
async function doVisionOcr(apiKey, p) {
  const media = mediaFromPayload(p);
  if (!media.length) { const e = new Error('fileBase64 or images required'); e.status = 400; throw e; }
  const prompt = `Transcribe ALL the text you can read in this image/scan, VERBATIM. Preserve line breaks and every number exactly as shown, including dollar amounts and labels like "Total", "Subtotal", "GST", "incl GST", "ex GST", "+ GST". Do not summarise, correct, translate, or add anything. If there is no readable text, return an empty string. Respond with STRICT JSON only: {"text":"<the transcribed text>"}`;
  const raw = await callGeminiVision(apiKey, prompt, media, modelFor(p));
  const json = parseJson(raw);
  return { text: (json && typeof json.text === 'string') ? json.text : (typeof raw === 'string' ? raw : '') };
}

// Build Gemini media parts from a vision payload: an images[] array (page
// renders) or a single fileBase64. Shared by doVisionAmount + doVisionOcr.
function mediaFromPayload(p) {
  p = p || {};
  if (Array.isArray(p.images) && p.images.length) return p.images.filter(im => im && im.base64).map(im => ({ data: im.base64, mimeType: im.mimeType || 'image/png' }));
  if (p.fileBase64) return [{ data: p.fileBase64, mimeType: p.mimeType || 'application/pdf' }];
  return [];
}

// Match a quote to ONE of our budget line items (Scan Quote Folder, when the
// filename didn't map on its own). We pass a numbered item list and ask for the
// index back (not free text), so nothing is invented. payload:
//   { hint (filename item text), scope (optional), items: [{n, name}] }
async function doMatchBudgetItem(apiKey, p) {
  const hint = (p && p.hint) || '';
  const scope = (p && p.scope) || '';
  const items = (p && p.items) || [];
  if ((!hint && !scope) || !items.length) return { n: -1 };
  const list = items.map(it => `${it.n}. ${safe(it.name)}`).join('\n').slice(0, 9000);
  const prompt = `A supplier quote for a residential building job is for: "${safe(hint)}"${scope ? ` (scope: ${safe(scope)})` : ''}.
Choose the ONE budget line item below that best matches this trade / work. Respond with STRICT JSON only:

  {"n": <the number of the best-matching item, or -1 if none clearly matches>}

Only use a number that appears in the list. If unsure, return -1.

Budget items:
${list}`;
  const text = await callGemini(apiKey, prompt, modelFor(p));
  const json = parseJson(text);
  return { n: (json && Number.isInteger(json.n)) ? json.n : -1 };
}

async function doSummarizeFilename(apiKey, p) {
  const prompt = `Suggest a 2-to-3-word PascalCase summary of what this PDF document is, suitable for a filename slot.
Respond with STRICT JSON only:

  {"summary":"<2-to-3 word PascalCase>"}

Examples: "QuoteSummary", "SitePlan", "MaterialList", "TimeAndMaterials", "RevisedQuote".

Original filename: ${safe(p.originalName)}
PDF content (first ~3000 chars):
${safe(p.attachmentText)}`;

  const text = await callGemini(apiKey, prompt, modelFor(p));
  const json = parseJson(text);
  let summary = (json && json.summary) || stripExt(p.originalName || 'Document');
  summary = String(summary).replace(/[^A-Za-z0-9]/g, '').slice(0, 30) || 'Document';
  return { summary };
}

// ---------- company key store (geminiKey / setProviderKey / keyStatus) ----------
//
// The Gemini key is pasted ONCE by an admin in AH Estimating (Settings →
// Model Connections) and lives in KV, so every allowed caller on every
// machine shares it and rotating it is just pasting a new one. The browser
// NEVER gets the key back — keyStatus reports last4 at most. The deploy-time
// GEMINI_API_KEY secret stays as a fallback so nothing breaks before the
// first paste (and nothing dies if KV has an outage).
const KV_KEY_GEMINI = 'provider-key:gemini';
// Per-isolate cache: one KV read per isolate per minute, and a rotation still
// lands everywhere within 60s (immediately on the isolate that stored it —
// see bustKeyCache in doSetProviderKey).
const KEY_CACHE_TTL_MS = 60 * 1000;
let keyCache = { value: null, at: 0 };

// Resolve the Gemini key for a task: cache -> KV -> env secret -> a human
// error that says WHERE to fix it. Every task that talks to Gemini must come
// through here — nothing else reads env.GEMINI_API_KEY.
async function geminiKey(env) {
  if (keyCache.value && (Date.now() - keyCache.at) < KEY_CACHE_TTL_MS) return keyCache.value;
  const { value } = await geminiKeySource(env);
  if (!value) throw new Error('The company Gemini key is not set — an admin can paste it in AH Estimating Settings (Model Connections)');
  keyCache = { value, at: Date.now() };
  return value;
}

// Where the key comes from RIGHT NOW (no cache — status must be honest):
// 'app' (the KV record pasted in the app) beats 'fallback-secret' (deploy-time
// env secret) beats 'none'. Shared by geminiKey and doKeyStatus so the two
// can never disagree about precedence.
async function geminiKeySource(env) {
  const rec = await readKeyRecord(env);
  if (rec && rec.apiKey) return { source: 'app', value: String(rec.apiKey), rec };
  if (env && env.GEMINI_API_KEY) return { source: 'fallback-secret', value: env.GEMINI_API_KEY, rec: null };
  return { source: 'none', value: '', rec: null };
}

// Read + parse the KV record { apiKey, setBy, setAt }. A KV outage or a
// mangled record must not take the AI down while the deploy-time secret still
// exists, so failures degrade to "no record" instead of throwing.
async function readKeyRecord(env) {
  if (!(env && env.KEYS)) return null;   // binding absent (old deploy) -> fallback path
  let raw = null;
  try { raw = await env.KEYS.get(KV_KEY_GEMINI); }
  catch (e) { console.warn('KEYS read failed:', e && e.message); return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// The 60s cache would otherwise keep serving the OLD key for up to a minute
// on the isolate that just stored a new one — bust it so a rotation is live
// immediately where it happened. (Exported for the offline tests too.)
function bustKeyCache() { keyCache = { value: null, at: 0 }; }

// Both key-store tasks demand a VALID ticket even while REQUIRE_AUTH=0
// (present + verified + allow-listed). Soft mode exists so the deployed app
// keeps WORKING before it ships tickets — key admin work has no such excuse.
function requireValidTicket(auth) {
  if (auth && auth.ok) return;
  const e = new Error((auth && auth.message) || 'Sign in to AH Estimating first');
  e.status = 401;
  throw e;
}

// setProviderKey { provider, apiKey }: store/rotate the company key.
// KEY_ADMINS is a second, smaller list on top of EMAIL_ALLOWLIST — using the
// AI is not the same privilege as changing its key.
async function doSetProviderKey(env, p, auth) {
  requireValidTicket(auth);
  const admins = parseAllowed(env.KEY_ADMINS || '').map(x => x.toLowerCase());
  if (!admins.includes(auth.email)) {
    const e = new Error(`Only a key admin can change the company key — this account (${auth.email}) is not on the admin list`);
    e.status = 403; throw e;
  }
  const provider = (p && p.provider) || '';
  if (provider !== 'gemini') {
    const e = new Error('Only the gemini key lives here so far');
    e.status = 400; throw e;
  }
  const apiKey = (p && typeof p.apiKey === 'string') ? p.apiKey.trim() : '';
  // Plausibility only — the REAL check is the live Gemini call below. This
  // just catches an empty paste or a key chopped by a line break.
  if (apiKey.length < 20 || /\s/.test(apiKey)) {
    const e = new Error('That does not look like an API key — paste the whole key, with no spaces');
    e.status = 400; throw e;
  }
  if (!env.KEYS) throw new Error('The key store is not configured on this Worker (KEYS binding missing) — tell the admin');
  // Validate BEFORE storing: one tiny real Gemini call with the CANDIDATE
  // key. A typo'd key must never replace a working one, and the admin should
  // see Gemini's actual reason, not a generic "failed".
  //
  // DELIBERATELY on the fixed default model, not modelFor(p) — do not "finish
  // the job" by threading the caller's model in here. This call tests the KEY.
  // On a model the key has no access to it would 404, the catch below would
  // report "That key was rejected", and a perfectly good key could never be
  // rotated in. Gemini's own words are passed through, so an admin can still
  // tell "model not found" from "API key not valid".
  try {
    await callGemini(apiKey, 'Return exactly this JSON: {"ok":true}');
  } catch (err) {
    const e = new Error(`That key was rejected, so it was NOT saved — ${String((err && err.message) || 'Gemini did not answer').slice(0, 300)}`);
    e.status = 400; throw e;
  }
  const rec = { apiKey, setBy: auth.email, setAt: new Date().toISOString() };
  await env.KEYS.put(KV_KEY_GEMINI, JSON.stringify(rec));
  bustKeyCache();
  // NEVER echo the key — last4 is enough for the admin to recognise it.
  return { ok: true, provider: 'gemini', last4: apiKey.slice(-4), setBy: rec.setBy, setAt: rec.setAt };
}

// keyStatus { provider? }: is a key configured and where would it come from.
// last4/setBy/setAt come from the KV record only — the env secret is opaque
// by design (nobody pasted it in the app, so there is nothing to attribute).
async function doKeyStatus(env, p, auth) {
  requireValidTicket(auth);
  const provider = (p && p.provider) || 'gemini';
  if (provider !== 'gemini') {
    const e = new Error('Only the gemini key lives here so far');
    e.status = 400; throw e;
  }
  const { source, rec } = await geminiKeySource(env);
  return {
    provider,
    configured: source !== 'none',
    source,
    last4: rec ? String(rec.apiKey).slice(-4) : '',
    setBy: (rec && rec.setBy) || '',
    setAt: (rec && rec.setAt) || ''
  };
}

// ---------- runPrompt: app-owned prompt runner (embed era) ----------
//
// The estimating-specific prompts + output schemas live IN THE APP repo
// (js/methods/ — one file per task, promptVersion'd there). This Worker no
// longer needs to know what the task IS: it adds the Gemini key, forwards,
// and — when the payload carries a schema — validates the output shape with
// the same validate/one-retry semantics as doRunMethod, so outputValid means
// exactly the same thing to every consumer.
//
// payload: { prompt: "..." }  OR  { messages: [{ role:'user'|'model', text }] }
//          images?: [{ base64, mimeType }]   — ride as media on the last user turn
//          schema?: JSON-Schema (draft-07 SUBSET — see validateOutput; keep app
//                   schemas inside that subset, never lean on unknown keywords)
// returns: { output, outputValid }           with a schema
//          { output, raw }                   without one (output = best-effort JSON)
async function doRunPrompt(env, p) {
  const contents = contentsOf(p);
  if (!contents) { const e = new Error('prompt or messages required'); e.status = 400; throw e; }
  const schema = (p && p.schema && typeof p.schema === 'object') ? p.schema : null;
  const apiKey = await geminiKey(env);   // after the 400 checks — a bad request should say so, not "no key"
  // Resolved ONCE: the validation retry below must go back to the SAME model.
  // Retrying on a different one would mean the answer you finally get is not
  // from the model you chose, which is the whole thing this release is ending.
  const model = modelFor(p);

  let raw = await geminiGenerate(apiKey, contents, model);
  let output = parseJson(raw);
  if (!schema) return { output, raw };

  let errs = validateOutput(output, schema);
  if (errs.length) {
    // One conversational retry: show the model its own answer and the errors.
    const retry = contents.concat([
      { role: 'model', parts: [{ text: raw || '' }] },
      { role: 'user', parts: [{ text: `Your previous answer failed validation: ${errs.slice(0, 5).join('; ')}. Return CORRECTED strict JSON only that matches the schema.` }] }
    ]);
    raw = await geminiGenerate(apiKey, retry, model);
    output = parseJson(raw);
    errs = validateOutput(output, schema);
  }
  return { output: output != null ? output : null, outputValid: errs.length === 0 };
}

// Normalise a runPrompt payload into Gemini `contents`. A plain prompt becomes
// one user turn; a messages array keeps its turns. Page images attach to the
// LAST user turn (that is the turn the question is in).
function contentsOf(p) {
  const media = mediaFromPayload({ images: p && p.images })
    .map(m => ({ inline_data: { mime_type: m.mimeType || 'image/png', data: m.data } }));
  if (Array.isArray(p && p.messages) && p.messages.length) {
    const contents = p.messages
      .filter(m => m && typeof m.text === 'string' && m.text)
      .map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] }));
    if (!contents.length) return null;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === 'user') { contents[i].parts.push(...media); break; }
    }
    return contents;
  }
  if (p && typeof p.prompt === 'string' && p.prompt) {
    return [{ role: 'user', parts: [{ text: p.prompt }, ...media] }];
  }
  return null;
}

// Low-level Gemini call taking prepared `contents` (multi-turn capable). The
// older callGemini/callGeminiVision keep their own request-building untouched —
// every pre-embed task keeps its exact behaviour until it is retired.
async function geminiGenerate(apiKey, contents, model) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' + (model || GEMINI_MODEL) + ':generateContent' +
    '?key=' + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------- runMethod: Vanta Mode-B recipe runner ----------
//
// Fetch a method's recipe pack from Vanta (or a local fixture when no token is
// configured), build a few-shot prompt, run it on Gemini, then validate the
// output against the method's JSON-Schema. One retry on validation failure,
// then degrade to { outputValid:false } so the caller surfaces it for review
// instead of acting on a bad shape.
async function doRunMethod(env, p) {
  const methodId = p && p.methodId;
  const input = (p && p.input) || {};
  if (!methodId) { const e = new Error('methodId required'); e.status = 400; throw e; }

  const pack = await getRecipe(methodId, env);   // throws { status:409 } on reauth
  const prompt = buildMethodPrompt(pack, input);
  // Vision-capable methods (e.g. drawing takeoff): the app can attach page
  // images alongside the recipe input — they ride as Gemini media parts, not
  // as recipe input (schemas stay small). Text-only methods are unchanged.
  const media = mediaFromPayload({ images: p && p.images });
  const apiKey = await geminiKey(env);
  // The recipe pack carries no model of its own, so this is the caller's choice
  // like every other task. Resolved once so the retry inside `ask` cannot drift.
  const model = modelFor(p);
  const ask = (q) => media.length
    ? callGeminiVision(apiKey, q, media, model)
    : callGemini(apiKey, q, model);

  let output = parseJson(await ask(prompt));
  let errs = validateOutput(output, pack.outputSchema);
  if (errs.length) {
    const retry = prompt +
      `\n\nYour previous answer failed validation: ${errs.slice(0, 5).join('; ')}. ` +
      `Return CORRECTED strict JSON only that matches the schema.`;
    output = parseJson(await ask(retry));
    errs = validateOutput(output, pack.outputSchema);
  }

  return {
    output: output != null ? output : null,
    outputValid: errs.length === 0,
    version: pack.version || null,
    contentHash: pack.contentHash || null
  };
}

// ---------- getRecipe: recipe-pack passthrough for the app's Direct AI mode ----------
//
// Vaenyx does not allow browser CORS, so when the app runs its Direct engine
// (user's own model key) it fetches JUST the recipe pack here — the model call
// never touches this Worker. Reuses getRecipe's cache + 409 (re-auth) handling.
async function doGetRecipe(env, p) {
  const methodId = p && p.methodId;
  if (!methodId) { const e = new Error('methodId required'); e.status = 400; throw e; }
  return getRecipe(methodId, env);   // throws { status: 409 } on reauth
}

// ---------- sendCorrection: Vanta flywheel feedback forwarder ----------
//
// Forward a human correction of an AI output to Vanta so the method can learn
// from it. The browser never holds the token, so it POSTs the assembled
// feedback object here and we relay it to Vanta with the app token. Ingest-only
// on Vanta's side (de-identify + Owner-approve happen there). Payload:
//   { methodId, feedback: { version, input, aiOutput, correctedOutput,
//                           reaction, occurredAt, note? } }
// Soft-fails 403 (token lacks "Send corrections" permission) and 404 (endpoint
// not live yet) as { ok:false, status, error } so the PWA logs but never breaks.
async function doSendCorrection(env, p) {
  const methodId = p && p.methodId;
  const feedback = p && p.feedback;
  if (!methodId) { const e = new Error('methodId required'); e.status = 400; throw e; }
  if (!feedback || typeof feedback !== 'object') { const e = new Error('feedback object required'); e.status = 400; throw e; }
  if (!feedback.version) { const e = new Error('feedback.version required'); e.status = 400; throw e; }
  if (!(env && env.VANTA_BASE && env.VANTA_APP_TOKEN)) {
    return { ok: false, skipped: 'vanta-not-configured' };
  }

  const url = `${env.VANTA_BASE.replace(/\/$/, '')}/v1/library/methods/${encodeURIComponent(methodId)}/feedback`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.VANTA_APP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(feedback)
  });
  if (res.status === 409) { const e = new Error('Method changed since authorization'); e.status = 409; throw e; }
  let data = null;
  try { data = await res.json(); } catch (e) { /* leave null */ }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && data.error) || `feedback ${res.status}` };
  }
  return { ok: true, id: (data && data.id) || null, status: res.status };
}

// Fetch + cache a recipe pack. Live mode (env.VANTA_BASE + VANTA_APP_TOKEN):
// plain GET with the bearer token, no hash in the request. A 409 means the
// method changed since this app was authorized -> bubble up for re-auth. No
// token configured: fall back to the bundled fixture so the runner is testable
// offline.
async function getRecipe(methodId, env) {
  const hit = recipeCache.get(methodId);
  if (hit && (Date.now() - hit.at) < RECIPE_TTL_MS) return hit.pack;
  try {
    let pack;
    if (env && env.VANTA_BASE && env.VANTA_APP_TOKEN) {
      const url = `${env.VANTA_BASE.replace(/\/$/, '')}/v1/library/methods/${encodeURIComponent(methodId)}/recipe`;
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${env.VANTA_APP_TOKEN}` } });
      if (res.status === 409) { const e = new Error('Method changed since authorization'); e.status = 409; throw e; }
      if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error(`Recipe fetch ${res.status}: ${t.slice(0, 200)}`); e.status = res.status; throw e; }
      pack = await res.json();
    } else {
      pack = FIXTURES[methodId];
      if (!pack) { const e = new Error(`No fixture recipe for ${methodId}`); e.status = 404; throw e; }
    }
    recipeCache.set(methodId, { pack, at: Date.now() });
    return pack;
  } catch (e) {
    // Re-auth must surface; otherwise prefer a stale cached recipe over failing.
    if (e.status === 409) throw e;
    if (hit) { console.warn('recipe fetch failed, serving stale copy:', e.message); return hit.pack; }
    throw e;
  }
}

// Assemble recipe + output schema + synthetic few-shot examples + this input.
function buildMethodPrompt(pack, input) {
  const examples = (pack.examples || []).slice(0, MAX_EXAMPLES).map((ex, i) =>
    `Example ${i + 1}:\nINPUT:\n${JSON.stringify(ex.input)}\nOUTPUT:\n${JSON.stringify(ex.output)}`
  ).join('\n\n');
  return `${pack.recipe || ''}

Respond with STRICT JSON only — no prose, no markdown fences — conforming to this JSON Schema (draft-07):
${JSON.stringify(pack.outputSchema || {})}
${examples ? `\nWorked examples:\n${examples}\n` : ''}
Now produce the output JSON for this INPUT:
${JSON.stringify(input)}`;
}

// Minimal JSON-Schema (draft-07 subset) validator: type, enum, required,
// properties, items. Unknown keywords pass (Ajv strict:false parity). Returns
// an array of error strings (empty = valid).
function validateOutput(data, schema, path = '') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  const where = path || 'root';

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchType(data, t))) {
      errs.push(`${where}: expected ${types.join('|')}, got ${jsType(data)}`);
      return errs; // wrong type — deeper checks would be noise
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(e => e === data)) {
    errs.push(`${where}: value ${JSON.stringify(data)} not in enum`);
  }
  if (schema.properties && data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in data) errs.push(...validateOutput(data[k], sub, `${path}.${k}`));
    }
  }
  if (Array.isArray(schema.required)) {
    for (const k of schema.required) {
      if (!data || typeof data !== 'object' || !(k in data)) errs.push(`${where}: missing required '${k}'`);
    }
  }
  if (schema.items && Array.isArray(data)) {
    data.forEach((it, i) => errs.push(...validateOutput(it, schema.items, `${path}[${i}]`)));
  }
  return errs;
}

function matchType(d, t) {
  switch (t) {
    case 'object':  return d != null && typeof d === 'object' && !Array.isArray(d);
    case 'array':   return Array.isArray(d);
    case 'string':  return typeof d === 'string';
    case 'number':  return typeof d === 'number' && isFinite(d);
    case 'integer': return typeof d === 'number' && Number.isInteger(d);
    case 'boolean': return typeof d === 'boolean';
    case 'null':    return d === null;
    default:        return true;
  }
}

function jsType(d) {
  return Array.isArray(d) ? 'array' : (d === null ? 'null' : typeof d);
}

// Exported for offline unit tests (node). Cloudflare only uses `export default`.
export { buildMethodPrompt, validateOutput, getRecipe, doRunMethod,
         doRunPrompt, contentsOf, verifyCaller, verifyIdToken,
         geminiKey, doSetProviderKey, doKeyStatus, bustKeyCache,
         modelFor, GEMINI_MODEL, doClassify, doVisionOcr };

// ---------- Gemini REST call ----------
// Workers have native fetch but no SDK, so we call Gemini's REST endpoint directly.

// model = the caller's choice, already resolved by modelFor(). Omitted falls
// back to GEMINI_MODEL, which keeps every pre-v0.27 call site working untouched.
async function callGemini(apiKey, prompt, model) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' + (model || GEMINI_MODEL) + ':generateContent' +
    '?key=' + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  // Standard response shape: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || '';
}

// Gemini vision call: same model, but the file (PDF/image) rides along as
// inline_data so the model can READ a scan/photo that has no text layer.
// media = array of { data (base64), mimeType }. One or more page images / a file.
async function callGeminiVision(apiKey, prompt, media, model) {
  const parts = [{ text: prompt }];
  for (const m of (Array.isArray(media) ? media : [])) {
    if (m && m.data) parts.push({ inline_data: { mime_type: m.mimeType || 'application/pdf', data: m.data } });
  }
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' + (model || GEMINI_MODEL) + ':generateContent' +
    '?key=' + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini vision ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------- sign-in gate (MSAL ID token) ----------
//
// The PWA sends the signed-in user's MSAL ID token as `Authorization: Bearer`.
// We verify the RS256 signature against the tenant's published JWKS, then the
// claims: our tenant (tid), our app (aud), not expired, and the user's email on
// EMAIL_ALLOWLIST (comma-separated env var — emails are config, never code).
// Failure messages are written for the human who will read them in a toast.
//
// Tenant + app id are the suite's identity — the same constants every AH app
// carries in config.js — not per-deploy configuration.
const TENANT_ID = 'ff968505-cca0-4cd1-9f6d-68ce6eaf06c7';
const APP_CLIENT_ID = '07eef32f-8834-424d-b4fd-ad04c91a3fcf';
const JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_S = 120;
let jwksCache = { keys: null, at: 0 };

// -> { ok, present, email?, message? }. `present` lets the caller distinguish
// "no ticket at all" (soft mode passes it) from "a ticket that failed" (never
// passes — our own app must not be sending junk).
async function verifyCaller(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, present: false, message: 'Your sign-in ticket is missing — reload AH Estimating and try again' };
  let claims;
  try { claims = await verifyIdToken(m[1]); }
  catch (e) { return { ok: false, present: true, message: e.message }; }
  const email = String(claims.preferred_username || claims.email || claims.upn || '').toLowerCase();
  const allowed = parseAllowed(env.EMAIL_ALLOWLIST || '').map(x => x.toLowerCase());
  if (!allowed.length) return { ok: false, present: true, message: 'The AI service has no allow-list configured — tell the admin (EMAIL_ALLOWLIST is empty)' };
  if (!allowed.includes(email)) return { ok: false, present: true, message: `This account (${email || 'unknown'}) is not set up for the AI service — ask the admin to add it` };
  return { ok: true, present: true, email };
}

// Verify signature + standard claims; returns the claims or throws with a
// human-readable message. Signature first would waste a JWKS fetch on an
// expired ticket, so cheap claim checks run before the crypto.
async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Your sign-in ticket is damaged — reload AH Estimating and sign in again');
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); }
  catch (e) { throw new Error('Your sign-in ticket is damaged — reload AH Estimating and sign in again'); }
  // RS256 only — accepting whatever the header claims is the classic
  // algorithm-confusion hole ("alg":"none" etc).
  if (!header || header.alg !== 'RS256') throw new Error('Your sign-in ticket is not the expected kind — sign out and back in');
  const now = Math.floor(Date.now() / 1000);
  if (!(typeof claims.exp === 'number' && claims.exp > now - CLOCK_SKEW_S)) {
    throw new Error('Your sign-in ticket has expired — the app will fetch a fresh one when you retry');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_S) {
    throw new Error('Your sign-in ticket is not valid yet — check this computer\'s clock');
  }
  if (claims.tid !== TENANT_ID) throw new Error('This sign-in belongs to a different organisation — use your Auzzie Homes account');
  if (claims.aud !== APP_CLIENT_ID) throw new Error('This sign-in ticket is for a different app — reload AH Estimating and sign in again');
  if (claims.iss !== `https://login.microsoftonline.com/${TENANT_ID}/v2.0`) {
    throw new Error('This sign-in ticket did not come from Microsoft sign-in — sign out and back in');
  }
  const jwk = await jwkFor(header.kid);
  if (!jwk) throw new Error('Your sign-in ticket was signed with an unknown key — sign out and back in');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const okSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!okSig) throw new Error('Your sign-in ticket failed verification — sign out and back in');
  return claims;
}

// Microsoft rotates signing keys; an unknown kid gets ONE forced re-fetch
// (covers rotation mid-cache) before we give up.
async function jwkFor(kid) {
  let keys = await getJwks(false);
  let jwk = keys.find(k => k && k.kid === kid);
  if (!jwk) { keys = await getJwks(true); jwk = keys.find(k => k && k.kid === kid); }
  return jwk || null;
}

async function getJwks(forceFresh) {
  if (!forceFresh && jwksCache.keys && (Date.now() - jwksCache.at) < JWKS_TTL_MS) return jwksCache.keys;
  let res;
  try { res = await fetch(JWKS_URL); } catch (e) { res = null; }
  if (!res || !res.ok) {
    // Serve stale keys over failing everyone: rotation is slow, outages aren't.
    if (jwksCache.keys) return jwksCache.keys;
    throw new Error('Sign-in checking is unavailable right now (key service unreachable) — try again shortly');
  }
  const data = await res.json();
  jwksCache = { keys: (data && data.keys) || [], at: Date.now() };
  return jwksCache.keys;
}

function b64urlBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }

// ---------- helpers ----------

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) }
  });
}

function parseAllowed(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Light per-isolate rate limit (sliding 60s window). The app's own usage is
// sequential (scan loop, pipeline) and stays far below this; a scripted
// quota-burn attack trips it. Per-isolate only — a determined attacker can
// spread across isolates, but combined with the Origin gate it raises the bar
// enough for an internal tool.
const RATE_LIMIT_PER_MIN = 90;
let rlWindowStart = 0, rlCount = 0;
function rateLimited() {
  const now = Date.now();
  if (now - rlWindowStart > 60000) { rlWindowStart = now; rlCount = 0; }
  return ++rlCount > RATE_LIMIT_PER_MIN;
}

function safe(s) {
  return (s == null ? '' : String(s)).slice(0, 5000);
}

function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }
  return null;
}

function validClassification(v) {
  const allowed = ['Quote', 'Question', 'Suspicious', 'Out-of-Office', 'Decline', 'Unrelated'];
  return allowed.includes(v) ? v : 'Question';
}

function clamp01(n) {
  const x = typeof n === 'number' ? n : 0;
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function stripExt(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}
