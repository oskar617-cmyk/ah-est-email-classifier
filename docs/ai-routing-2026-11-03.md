# Shared AI Transport — 2026-11-03

Source release v0.41. Native model formats, safe transport, completion checks and model identity checks use pinned Core SDK 1.4.0, commit 8467ee7. The App still owns authentication, company scope, prompts, schemas and business validation. Existing credential storage and notification/file permissions are unchanged.

Default automatic paid fallback is disabled. Invalid output, model substitution and unknown outcomes do not trigger another inference. Such fallback would need explicit selection, advance paid authorization, enforceable budget and atomic reservation; this release enables none.

All validation used local mocks or temporary synthetic data, including credential/permission boundaries, provider failures and the SDK manifest. No real provider, SharePoint mutation, mail, push notification or D1 query was performed. Deploy health can verify the revision but does not constitute live provider acceptance.

Publication follows this repository's per-push/deploy confirmation rule. No new external resources or credentials are created by this change.
