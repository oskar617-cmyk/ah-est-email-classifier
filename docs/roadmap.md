## v0.40 Linked Quotation Evidence (2026-10-30)
- Approved for release by Oskar. Bounded PDF downloads and full readable quotation pages retain source evidence; unsafe hosts, action links, oversized bodies and redirect chains are rejected. Existing preview clients remain compatible.
- Syntax and all 20 Node tests pass (including existing grouped runner tests). Released `574e9ca`; production reports X-Worker-Version:v0.40. Unsupported GET returns 405 and an unsigned fetchUrl request from the allowed origin returns 401.
- Paired frontend v1.79.0 is live on both Pages targets. Pre-release bounded reader verification retrieved the real Industria original PDF (84,198 bytes); no post-release signed linked-document fetch or new AI Re-Read is claimed. Existing AIRCOOL amount/attachments were inspected read-only, without final quote save. No model, key, resource, fee or supplier-mail change.

# AH Est Email Classifier — 状态与待办

## 当前状态
- **v0.26(2026-08-02)**:公司 Gemini key 由 AH Estimating Settings 粘一次,真调用验证后存 `KEYS` KV;`setProviderKey/keyStatus` 有独立 admin 门;`GEMINI_API_KEY` secret 只作 fallback。
- **v0.25(2026-08-02)**:进入内嵌时代。新增 generic `runPrompt`;estimating 的 classify/match/questions/analysis prompt + schema 移到 App;新增 MSAL ID token 验票,现 `REQUIRE_AUTH=0` soft rollout。
- **v0.24 及以前**:建立 Vaenyx recipe runner/反馈、vision OCR/金额读取、budget item 匹配、Origin/CORS/限流。takeoff 仍使用这条 Vaenyx 路径。
- AH Estimating **v0.86.0** 已接 `runPrompt`、ID ticket、KV key 管理和 SharePoint 内部 flywheel。Worker 的固定 prompt classify/extractAmount/summarizeFilename 已无 App 调用;vision/match 辅助任务与 takeoff 路径仍在用。

## 待办
- 生产 signed-request 冒烟:普通 `runPrompt`、401 强制 refresh retry、`keyStatus`、公司 key Test 均通过后,把 `REQUIRE_AUTH` 从 `0` 翻成 `1` 关死 ticketless 请求。
- 稳定观察后逐项审计固定 prompt handlers;只有消费端零调用 + 测试覆盖通过才退役,不连带删除 vision/match/takeoff。
- takeoff 继续停在 Vaenyx,直到 Oskar 恢复新 method 工作;不得借清旧任务顺手迁移。

## 历史来源
完整逐版行为史在 `worker.js` VERSION 注释;消费端迁移与产品决策在 ah-estimating `docs/architecture.md`「AI 能力布局」和 `docs/roadmap.md` v0.86.0 版本志。
