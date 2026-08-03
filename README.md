# ah-est-email-classifier

The server-side AI gateway for the **AH Estimating** PWA. It keeps company credentials out of the browser, verifies the signed-in Auzzie Homes user, and runs Gemini requests on Cloudflare Workers.

- **Live Worker:** [ah-estimating-classifier.oskar617.workers.dev](https://ah-estimating-classifier.oskar617.workers.dev)
- **Cloudflare Worker name:** `ah-estimating-classifier` — do not rename
- **Consumer:** private repo `ah-estimating`
- **Deployment:** GitHub `main` is connected to Cloudflare; every push deploys production
- **Current runtime version:** read `VERSION` in `worker.js` and the `X-Worker-Version` response header

## Current Design

Since Worker v0.25 / AH Estimating v0.86, the app owns its business prompts and schemas in `ah-estimating/js/methods/` and prompt-owning helpers such as `js/classification.js`. The Worker is deliberately a thin server boundary:

1. Check the request Origin and rate limit.
2. Verify the caller's MSAL ID token and allow-listed email.
3. Resolve the company Gemini key from KV, with the deploy-time secret as fallback.
4. Forward the app-built prompt and optional images to Gemini.
5. When a schema is supplied, validate once, request one corrected answer if needed, and return `outputValid`.

The four embedded estimating tasks are `classify`, `match`, `questions`, and `analysis`. Their prompts do **not** live in this repo. Takeoff remains on the older Vaenyx recipe path because it is deliberately parked outside the embed migration.

Keeping the Worker in its own private repo is intentional: AH Estimating stays a static PWA, company credentials and server-side auth remain outside the browser, and the gateway can be deployed or rolled back independently without copying its source into the app.

## Endpoint Contract

`POST /` with:

```json
{ "task": "runPrompt", "payload": { "prompt": "...", "schema": {}, "images": [] } }
```

The app sends its MSAL ID token as `Authorization: Bearer <token>`. Success is `{ "result": ... }`; failure is `{ "error": "human-readable message" }`. Every response carries `X-Worker-Version`.

### Active Tasks

| Task | Purpose |
|---|---|
| `runPrompt` | Run an app-owned prompt or message sequence, optional images and schema validation |
| `visionAmount` / `visionOcr` | Read scanned quote images and PDF page renders |
| `matchBudgetItem` | Match an unmatched quote to a budget item |
| `setProviderKey` | Key-admin-only Gemini key validation and KV rotation |
| `keyStatus` | Report configured/source/last4 metadata without returning the key |
| `runMethod` / `getRecipe` | Vaenyx recipe path retained for takeoff |
| `sendCorrection` | Vaenyx feedback retained for takeoff; embedded tasks use the app's SharePoint flywheel |

The fixed-prompt `classify`, `extractAmount`, and `summarizeFilename` handlers remain temporarily for compatibility, but AH Estimating now sends those prompt-owned paths through `runPrompt`. Do not add new business prompts to this Worker.

## Security And Key Storage

- `KEYS` KV stores `provider-key:gemini` as `{ apiKey, setBy, setAt }`.
- `GEMINI_API_KEY` is a Cloudflare secret used only as fallback when KV has no usable record.
- `VANTA_APP_TOKEN` is a Cloudflare secret used only by the retained Vaenyx/takeoff path.
- `EMAIL_ALLOWLIST` controls who may use the service.
- `KEY_ADMINS` is the smaller set allowed to rotate the company key.
- `REQUIRE_AUTH=0` is the rollout soft gate: a supplied ticket must validate, while a missing ticket temporarily passes. After the signed-request smoke test, set it to `1`.
- CORS fails closed and a per-isolate 90 requests/minute limiter remains as defense in depth.
- Provider keys, quote data, and model outputs must never be logged or committed.

## Local Verification

No build step or runtime package install is required.

```powershell
node --check worker.js
node --test test/*.test.mjs
```

Tests cover the generic runner/schema path, MSAL ticket gate, and KV key lifecycle. Runtime changes must also bump `VERSION`, append the header history, and be smoke-tested against the changed live path after deployment.

## Deploy And Rollback

This is a pure Worker repo, not a Pages app. Cloudflare native Git integration deploys every push to `main`, so obtain Oskar's approval before each push even for docs-only commits.

Rollback with `git revert`; do not rewrite history. Never paste a separate copy into the Cloudflare editor, convert the repo to Pages, or add a Pages deployment workflow. The root `wrangler.toml` is the deployment identity and its `name` must remain `ah-estimating-classifier`.

## Where Changes Belong

- Estimating prompt/schema/tuning change → `ah-estimating/js/methods/` or its prompt-owning helper.
- Internal flywheel behavior → `ah-estimating/js/flywheel*.js`.
- Worker transport, authentication, key storage, validation, or takeoff/Vaenyx bridge → this repo.
- Any task contract change → update and verify both repos together.

## Files

```text
worker.js             Runtime, VERSION history, and endpoint contract
fixtures.js           Offline Vaenyx recipe fixtures
wrangler.toml         Worker identity, vars, and KEYS binding
test/                 Runner, auth, and key-store tests
docs/architecture.md  Locked architecture and upgrade procedure
docs/roadmap.md       Current state and remaining migration work
```
