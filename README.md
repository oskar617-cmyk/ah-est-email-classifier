# ah-est-email-classifier

A Cloudflare Worker that proxies Google Gemini for the **AH Estimating** PWA's email reply classification. The Gemini API key never reaches the browser — it lives as a Cloudflare Worker secret.

- **Live Worker URL:** https://ah-estimating-classifier.oskar617.workers.dev
- **Worker name in Cloudflare:** `ah-estimating-classifier` (do not rename — see `wrangler.toml`)
- **Auto-deploy:** every commit to `main` here triggers a Cloudflare deploy (~30s)

## Tech Stack

- Cloudflare Workers (free tier — 100,000 requests/day)
- Google Gemini API (`gemini-2.5-flash`)
- Single-file `worker.js`, no build step, no npm

## Endpoint Contract

The PWA depends on this — don't change shapes without updating the PWA in lockstep.

**`POST /`** with JSON body:

```json
{ "task": "classify" | "extractAmount" | "summarizeFilename", "payload": { ... } }
```

Response: `{ "result": { ... } }` on success, `{ "error": "..." }` on failure.

### Tasks

| Task                 | Payload                                                                                         | Result                                                                                |
|----------------------|-------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `classify`           | `{ subject, fromName, fromEmail, bodyText, rfqCategory, jobAddress, supplierCompany }`          | `{ classification, confidence }` — classification ∈ Quote / Question / Suspicious / Out-of-Office / Decline / Unrelated |
| `extractAmount`      | `{ subject, bodyText, attachmentText }`                                                          | `{ amount, currency: "AUD", notes }` — amount is a number or null                     |
| `summarizeFilename`  | `{ originalName, attachmentText }`                                                               | `{ summary }` — PascalCase, ≤30 chars, alphanumeric only                              |

## Secrets / Variables

Set in the Cloudflare dashboard (**Workers & Pages → ah-estimating-classifier → Settings → Variables and Secrets**), never committed here:

| Name             | Type   | Value                                                  |
|------------------|--------|--------------------------------------------------------|
| `GEMINI_API_KEY` | Secret | Gemini API key from https://aistudio.google.com        |
| `CORS_ORIGINS`   | Text   | `https://oskar617-cmyk.github.io` (the PWA's origin)   |

## Deploy

Don't paste into the Cloudflare editor. The flow is:

1. Update `worker.js` here on GitHub (drag-drop new file → commit to `main`)
2. Cloudflare detects the commit and auto-deploys within ~30 seconds
3. Verify via the **Deployments** tab on the Worker page

Rollback: revert the commit on GitHub — Cloudflare auto-deploys the previous version.

## File Structure

```
worker.js          The whole Worker — single file, ESM default export
wrangler.toml      Worker name, entry point, runtime compatibility date
README.md          This file
```

## Free Tier Limits

- **Cloudflare Workers:** 100,000 requests/day, 10ms CPU per request. Wait time on `fetch` to Gemini doesn't count as CPU, so we fit comfortably.
- **Gemini API (free tier):** 1,500 requests/day for `gemini-2.5-flash`. At ~3 calls per supplier reply, that covers ~500 replies/day — far above real usage.

