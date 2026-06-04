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
//   v0.04 — switch to gemini-3-flash (current)
const VERSION = 'v0.04';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = parseAllowed(env.CORS_ORIGINS || '*');
    const corsOrigin =
      allowed.includes('*') ? '*'
      : (allowed.includes(origin) ? origin : (allowed[0] || ''));
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin || '*',
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
      else if (task === 'summarizeFilename') result = await doSummarizeFilename(env.GEMINI_API_KEY, payload);
      else return jsonResponse({ error: 'Unknown task' }, 400, corsHeaders);
      return jsonResponse({ result }, 200, corsHeaders);
    } catch (err) {
      console.error('Gemini call failed:', err && err.stack || err);
      return jsonResponse({ error: (err && err.message) || 'Classifier error' }, 500, corsHeaders);
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

  {"amount":<number-or-null>,"currency":"AUD","notes":"<brief reason>"}

Rules:
- amount is a single number, the headline total the supplier is quoting (excluding GST if a separate ex-GST/inc-GST distinction is shown — prefer the inc-GST total).
- If no amount can be confidently extracted, return null.
- Don't invent a number. Don't pick the lowest line item — pick the total.

EMAIL SUBJECT: ${safe(p.subject)}
EMAIL BODY (truncated):
${safe(p.bodyText)}

ATTACHMENT TEXT (truncated):
${safe(p.attachmentText)}`;

  const text = await callGemini(apiKey, prompt);
  const json = parseJson(text);
  if (!json) return { amount: null, currency: 'AUD' };
  return {
    amount: typeof json.amount === 'number' ? json.amount : null,
    currency: json.currency || 'AUD',
    notes: json.notes || ''
  };
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

// ---------- Gemini REST call ----------
// Workers have native fetch but no SDK, so we call Gemini's REST endpoint directly.

async function callGemini(apiKey, prompt) {
  // Model: gemini-3-flash (stable, full Flash tier). Google's recommended
  // default Flash model — stronger reasoning than 3.1-flash-lite, same
  // free tier eligibility, with 1,500 RPD (up from 1,000 on lite). Picked
  // for the extractAmount task which benefits from more reasoning when
  // parsing messy PDF text. Classification and filename tasks unchanged
  // in quality.
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent' +
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

// ---------- helpers ----------

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) }
  });
}

function parseAllowed(s) {
  return String(s || '*').split(',').map(x => x.trim()).filter(Boolean);
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
