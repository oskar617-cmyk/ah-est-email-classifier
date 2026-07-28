# ah-est-email-classifier

A Cloudflare Worker that proxies Google Gemini for the **AH Estimating** PWA's email reply classification. The Gemini API key never reaches the browser — it lives as a Cloudflare Worker secret.

- **Live Worker URL:** https://ah-estimating-classifier.oskar617.workers.dev
- **Worker name in Cloudflare:** `ah-estimating-classifier` (do not rename — see `wrangler.toml`)
- **Auto-deploy:** every commit to `main` here triggers a Cloudflare deploy (~30s)

## Tech Stack

- Cloudflare Workers (free tier — 100,000 requests/day)
- Google Gemini API (`gemini-3-flash`)
- Single-file `worker.js`, no build step, no npm

## Versioning

This Worker tracks a single `VERSION` constant at the top of `worker.js` (e.g. `v0.04`). It's bumped on every release and exposed as the `X-Worker-Version` response header so the live version can be verified post-deploy without reading logs.

To verify: hit any response and check `X-Worker-Version` in the Network tab. Or run `fetch('https://ah-estimating-classifier.oskar617.workers.dev', { method: 'OPTIONS' }).then(r => console.log(r.headers.get('X-Worker-Version')))` in any browser console.

History tracked as a comment block in `worker.js` next to the `VERSION` constant — bump and append on every release.

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
| `CORS_ORIGINS`   | Text   | `https://oskar617-cmyk.github.io`(已关停;现用 pages.dev,CORS 清理待批) |

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
- **Gemini API (free tier):** the model in use is `gemini-3-flash` (stable, Google's recommended default Flash model). Free tier runs at roughly 10 RPM, 250,000 TPM, 1,500 requests/day — far above real usage at ~3 calls per supplier reply. Check the [current quotas page](https://ai.google.dev/gemini-api/docs/rate-limits) for live numbers.

## Tuning Workflow

Tuning is done in a dedicated Claude sub-chat off the main "AH Estimating" project. The cycle:

1. **Collect data in the PWA.** As supplier replies come in, the PWA logs every Gemini decision plus how you reacted (Confirmed / Edited / Rejected, with original input, Gemini's output, your correction, and an optional "why" note).
2. **Export.** PWA → Settings → AI Tuning → **Export For Analysis**. Produces a markdown file named `gemini-decisions-YYYY-MM-DD.md`. Each export starts from the last export timestamp, so you never reanalyse the same decisions twice.
3. **Paste into the sub-chat.** Open the "AH Est Email Classifier" sub-chat in Claude and attach (or paste) the markdown export.
4. **Diagnosis before code.** Claude analyses for patterns, tells you in plain language what it thinks Gemini is getting wrong systematically, and waits for you to confirm before writing any code. A bad prompt edit is worse than no edit.
5. **Tuned `worker.js`.** Once you confirm the diagnosis, Claude produces a full updated `worker.js` bundled as `ah-est-email-classifier-[short-summary].zip`, with a clear note of what changed in the prompts.
6. **Drop into this repo.** Drag the new `worker.js` into the GitHub web UI (overwriting the old one), commit to `main`.
7. **Auto-deploy.** Cloudflare detects the commit and deploys within ~30 seconds. Next supplier reply uses the smarter prompt.
8. **Rollback if needed.** If a tuning round makes things worse: GitHub → Commits → revert that commit, OR Cloudflare Worker → Settings → Version History → restore the previous version. Either path puts the old prompts back in <1 minute.

### What stays the same across tuning rounds

- Worker name (`ah-estimating-classifier`)
- Worker URL
- Three tasks: `classify`, `extractAmount`, `summarizeFilename`
- Request/response contract (see Endpoint Contract above)
- The six classification values (Quote / Question / Suspicious / Out-of-Office / Decline / Unrelated)
- Gemini model (`gemini-3-flash` — only changed with explicit approval)

Tuning is about the *content* of the prompts inside the three task functions, not the Worker's shape.

## Do NOT Convert This Repo With doc-dropper

The `doc-dropper` tool's "make repo private" toggle migrates a repo from GitHub Pages hosting to Cloudflare Pages hosting. **This repo is not a GitHub Pages site — it's a Cloudflare Worker deployed via Cloudflare's native Git integration.** Running doc-dropper's conversion against this repo would:

- Create a parallel Cloudflare **Pages** project alongside the existing Worker (different products, different deploy targets, both triggered on every commit)
- Add a `.github/workflows/deploy.yml` that runs `wrangler pages deploy` on every push — useless here, but pollutes the repo and your Cloudflare account
- Add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` GitHub Secrets that this repo doesn't need

The Worker itself wouldn't break (Cloudflare's API treats Workers and Pages as separate surfaces — `wrangler pages` can't clobber a Worker's config or bindings), but you'd end up with a dead `ah-est-email-classifier.pages.dev` Pages project sitting next to the real Worker, deploying garbage on every commit.

**If doc-dropper is well-behaved, it should refuse to touch any repo containing a `wrangler.toml` at the root.** That file is the canonical "this repo deploys to Cloudflare as a Worker (or other non-Pages target)" marker.

To manage this repo's privacy: use GitHub's own Settings → General → Danger Zone → Change visibility. No tool needed.
