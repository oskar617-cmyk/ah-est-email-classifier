# AH Est Email Classifier — 架构与升级规程

## 锁定角色
- 本 repo 是 AH Estimating 的**服务器边界**,不是提示词库。estimating 专属 prompt/schema 由消费端 `js/methods/` 与 prompt-owning helper 维护;Worker `runPrompt` 只验票、取 key、转发、可选 schema 校验。
- takeoff 暂不内嵌:继续走 `runMethod/getRecipe` 取 Vaenyx recipe,其 correction 才经 `sendCorrection` 回 Vaenyx。四个内嵌任务的学习记录由 App 写 SharePoint 内部 flywheel,不经过 Worker feedback。
- Worker 不存邮件、报价、prompt、模型回答。唯一持久数据是 `KEYS` KV 的公司 Gemini key 记录。

## 请求与响应
- Endpoint:`POST /`;body `{ task, payload }`;成功 `{ result }`;失败 `{ error }`;全部响应带 `X-Worker-Version`。
- `runPrompt` payload 支持 `prompt` 或 `messages[{role,text}]`,可带 `images[{base64,mimeType}]` 与 validator 支持子集内的 draft-07 `schema`。
- 有 schema:最多一次纠错重试,回 `{output,outputValid}`;无 schema:回 `{output,raw}`。
- 管理任务:`setProviderKey{provider:'gemini',apiKey}` 真调 Gemini 成功后才写 KV;`keyStatus` 只回 configured/source/last4/setBy/setAt,永不回 key。
- 仍在用的辅助任务:`visionAmount/visionOcr/matchBudgetItem`;takeoff 路径:`runMethod/getRecipe/sendCorrection`。固定 prompt 的 `classify/extractAmount/summarizeFilename` 只作暂时兼容。

## 安全与数据边界
- 第一层:MSAL ID token 的 RS256 签名 + issuer/tid/aud/exp/nbf + `EMAIL_ALLOWLIST`。`REQUIRE_AUTH=0` 只为 rollout soft gate;带票必验,缺票暂放;签名请求冒烟通过后翻 `1`。
- `setProviderKey/keyStatus` 不吃 soft 例外:必须有效 ticket;写 key 还要通过 `KEY_ADMINS`。
- 第二层:Origin allow-list、CORS fail-closed、每 isolate 90/min。Origin 可伪造,不能代替登录票。
- Gemini key 解析顺序:60 秒 isolate cache → `KEYS` KV → `GEMINI_API_KEY` secret fallback。KV 记录损坏/读取失败时保留 fallback 可用性。
- `VANTA_APP_TOKEN` 只供 takeoff/Vaenyx。任何 key 不进浏览器响应、日志或 git。

## 部署机制(红线)
- 纯 Cloudflare Worker;根目录 `wrangler.toml` 是唯一部署身份;Worker name 固定 `ah-estimating-classifier`。
- Cloudflare 原生 Git 集成:push `main` 即 production deploy,无 staging;每次 push 前必须单独问 Oskar。
- 不转 Pages、不加 Pages workflow、不从 Cloudflare editor 维护第二份源码。
- GitHub private repo 是部署 source,不只是备份;回退只用 `git revert`。

## 升级规程
1. 先读消费端真实调用(`js/ai.js`、`js/runner.js`、`js/classification.js`、`js/methods/`、`js/flywheel.js`)和本文件,列清 task/payload/response 是否变化。
2. Contract 改动尽量向后兼容;不兼容时先让 Worker 同时兼容新旧请求,再发 App,稳定后另版清旧路。
3. Runtime 改动 bump `worker.js` VERSION + 文件头版本史;纯 docs 不 bump runtime VERSION。
4. 跑 `node --check worker.js` 与 `node --test test/*.test.mjs`;新增边界必须补相应 auth/key/runner 测试。
5. 与 ah-estimating 对应 docs/contract 同步;push 前逐次问 Oskar。
6. 上线后按改动真冒烟:auth 变更测 signed request;key 变更测 keyStatus + runPrompt;Vaenyx token 变更测 takeoff 的 getRecipe/runMethod。不能用已内嵌 classify 代替 takeoff 冒烟。

## 退役条件
- 删除任何旧 task 前,先在 ah-estimating 全 repo 查零调用并跑完整测试。
- `visionAmount/visionOcr/matchBudgetItem` 与 takeoff 三任务目前不是死码,不得随固定 prompt handler 一起删除。
- `REQUIRE_AUTH=1` 前必须确认生产 App 每条 Worker 请求都带 ticket,并真测 401 refresh retry。
