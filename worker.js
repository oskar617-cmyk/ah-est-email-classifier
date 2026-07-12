// AH Estimating — Classifier Worker (Cloudflare Workers)
//
// Proxies Google Gemini for three tasks the AH Estimating PWA needs:
//   - classify         : email reply classification (Quote / Question / etc.)
//   - extractAmount    : pull a quote amount out of body / PDF text
//   - summarizeFilename: short PascalCase snippet for a filename slot
//
// The Gemini API key never ships to the browser. It lives as a Cloudflare
// Worker secret named GEMINI_API_KEY. CORS_ORIGINS is a comma-separated
// list of allowed origins (defaults to "*" if absent).
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
//           text-only methods unchanged (current)
const VERSION = 'v0.23';

// The Gemini model for every call (text + vision). gemini-2.5-flash's free tier
// is only 250 requests/day — too small for bulk folder scans. gemini-3.1-flash-lite
// has a much larger free allowance and still does vision + strict-JSON output.
// (NB: the id "gemini-3-flash" 404s — it doesn't exist; the real ids are
// gemini-3.1-flash-lite / gemini-3-flash-preview. Change here to roll back.)
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

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
      'Access-Control-Allow-Headers': 'Content-Type',
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
    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: 'GEMINI_API_KEY not configured' }, 500, corsHeaders);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    const { task, payload = {} } = body || {};
    try {
      let result;
      if (task === 'classify')               result = await doClassify(env.GEMINI_API_KEY, payload);
      else if (task === 'extractAmount')     result = await doExtractAmount(env.GEMINI_API_KEY, payload);
      else if (task === 'visionAmount')      result = await doVisionAmount(env.GEMINI_API_KEY, payload);
      else if (task === 'visionOcr')         result = await doVisionOcr(env.GEMINI_API_KEY, payload);
      else if (task === 'matchBudgetItem')   result = await doMatchBudgetItem(env.GEMINI_API_KEY, payload);
      else if (task === 'summarizeFilename') result = await doSummarizeFilename(env.GEMINI_API_KEY, payload);
      else if (task === 'runMethod')         result = await doRunMethod(env, payload);
      else if (task === 'sendCorrection')    result = await doSendCorrection(env, payload);
      else return jsonResponse({ error: 'Unknown task' }, 400, corsHeaders);
      return jsonResponse({ result }, 200, corsHeaders);
    } catch (err) {
      // Propagate a Vanta 409 (method changed since this app was authorized)
      // so the PWA can prompt the Owner to re-authorize.
      if (err && err.status === 409) {
        return jsonResponse({ error: 'needs-reauth' }, 409, corsHeaders);
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

  const text = await callGemini(apiKey, prompt);
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

  const text = await callGemini(apiKey, prompt);
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
  const json = parseJson(await callGeminiVision(apiKey, prompt, media, GEMINI_MODEL));
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
  const raw = await callGeminiVision(apiKey, prompt, media, GEMINI_MODEL);
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
  const text = await callGemini(apiKey, prompt);
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

  const text = await callGemini(apiKey, prompt);
  const json = parseJson(text);
  let summary = (json && json.summary) || stripExt(p.originalName || 'Document');
  summary = String(summary).replace(/[^A-Za-z0-9]/g, '').slice(0, 30) || 'Document';
  return { summary };
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
  const ask = (q) => media.length
    ? callGeminiVision(env.GEMINI_API_KEY, q, media, GEMINI_MODEL)
    : callGemini(env.GEMINI_API_KEY, q);

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
export { buildMethodPrompt, validateOutput, getRecipe, doRunMethod };

// ---------- Gemini REST call ----------
// Workers have native fetch but no SDK, so we call Gemini's REST endpoint directly.

async function callGemini(apiKey, prompt) {
  // Model: gemini-2.5-flash — stable, GA, broadly available on our key
  // (gemini-3-flash 404s: "not found for API version v1beta"). Good reasoning
  // for the extractAmount + runMethod analysis tasks; JSON response mode.
  // Bump deliberately to a newer flash once confirmed available on the key.
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent' +
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
