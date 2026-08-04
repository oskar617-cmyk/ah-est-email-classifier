# ah-est-email-classifier Agent Rules(纯 Cloudflare Worker)

## 1. Identity
- AH Estimating 的公司 AI gateway。主路径 `runPrompt` 只做登录验票、取公司 Gemini key、转发 app 自带 prompt/media、可选 JSON-Schema 校验;另保留 vision/金额辅助任务。Vaenyx `runMethod/getRecipe/sendCorrection` 仅继续服务 takeoff。
- 技术特征:Uses MSAL: token validation only(无前端 client) · Deploy target: Cloudflare Worker(**纯 Worker:push 即上线、无 staging——push/deploy 逐次先问 Oskar**)· PWA: no。

## 2. Read First
1. `worker.js` 头部 VERSION + 版本史注释(响应带 `X-Worker-Version`)
2. `docs/architecture.md` — 当前 contract、安全边界、升级顺序
3. 消费端:ah-estimating 的 `js/runner.js` / `js/ai.js` / `js/classification.js` / `js/methods/` / `js/flywheel.js`

## 3. Current Snapshot
以 `worker.js` VERSION 为准(版本史在文件头注释)。当前 **v0.26**:`runPrompt` 承载 app-owned prompts;所有任务有 MSAL ID token 门(`REQUIRE_AUTH=0` 暂为 soft,app 冒烟后翻 1);公司 Gemini key 存 KV `provider-key:gemini`,`setProviderKey/keyStatus` 即使 soft 期也硬验票且 key 永不回浏览器。固定 prompt 的 `classify/extractAmount/summarizeFilename` 已无 app 调用,先留兼容;`visionAmount/visionOcr/matchBudgetItem` 仍在用;`runMethod/getRecipe/sendCorrection` 留给 takeoff。(替换制。)

## 4. Hard Rules
- API contract 与 ah-estimating 端锁定:改动必须两 repo 同步。
- estimating 专属 prompt/schema 的唯一权威是 ah-estimating `js/methods/` 与相应 helper;本 Worker 不再新增第二份业务 prompt。
- Gemini 主 key 只存 `KEYS` KV;`GEMINI_API_KEY` secret 仅 fallback;`VANTA_APP_TOKEN` 仅供 takeoff 的 Vaenyx 路径。key 永不写日志、响应、git。
- 邮箱只配在 `EMAIL_ALLOWLIST/KEY_ADMINS`,不硬编码进 Worker;`setProviderKey` 必须先真调 Gemini 验 key,成功才覆盖 KV。
- 根目录 `wrangler.toml` = Worker 标记,绝不跑 Pages 转换。
- 换 `VANTA_APP_TOKEN` 后必须冒烟 takeoff 的 `getRecipe/runMethod`,不能拿已内嵌的 classify 当验证。

## 5. Architecture And Data Boundaries
唯一持久数据是 `KEYS` KV 内的公司 Gemini key + setBy/setAt;不存邮件、报价、prompt 或模型输出。主路 app→Worker→Gemini;takeoff 才是 app→Worker→Vaenyx recipe→Gemini。门禁 = MSAL ID token + Origin 白名单 + CORS fail-closed + 90/min 限流。

## 6. Commands
- URL:[ah-estimating-classifier.oskar617.workers.dev](https://ah-estimating-classifier.oskar617.workers.dev)。
- 部署:Cloudflare 原生 Git 集成——**push 到 main 即自动部署上线**(push 前逐次问)。
- GitHub repo:[github.com/oskar617-cmyk/ah-est-email-classifier](https://github.com/oskar617-cmyk/ah-est-email-classifier)(private)。
- 本地自验:`node --check worker.js`;`node --test test/*.test.mjs`。

## 7. Verification And Release
runtime/contract 改动:bump Worker VERSION + 文件头版本史 → 语法 + 全测试 → 与 ah-estimating contract 同步 → 问 Oskar → push(即上线)→ 按所改路径真冒烟。纯 docs 改动不 bump runtime VERSION,但 push 仍须先问。

## 8. Multi-Agent Conflict Hotspots
- task payload/response、schema validator、登录票、KV/key admin、Vaenyx takeoff 路径 = ah-estimating 公共接口:跨 repo 先协调。

## 9. Shared Rulesets
(AH-PWA-MSAL 不适用:本 repo 非 PWA,不负责客户端 MSAL 骨架;只验证 App 送来的 ID token。)

<!-- SHARED-RULESET:AH-SUITE VERSION:3 UPDATED:2026-08-05 -->
- 套件:Auzzie Homes Pty Ltd(墨尔本建筑公司)内部工作 app 套件;各 app 经 jobCode 互联;**`ah-jobs-rego` 是全套件 job 数据唯一 source of truth,任何 app 不得自建 job list**。
- SharePoint 拓扑(锁定):所有 Lists 在 AH Site(`auzziehomes.sharepoint.com/sites/AHSite`);文件/文件夹留各自原站(默认 AHOffice)。List 命名 `[App Name] [Purpose] List`(空格分隔、无连字符);config 存确切字符串,读其他 app 的 List 必须逐字一致。
- 单一 Entra tenant `ff968505-cca0-4cd1-9f6d-68ce6eaf06c7`;one app one registration;admin `oskar@auhs.com.au`。
- 本地测试连的是**真 SharePoint 数据**:测试 job 用明显 TEST 名,测完删除。
- AI 功能默认经 Cloudflare Worker 代理调用(模型 key 不写进前端代码;用户在设置里自带 key 的 Direct 模式除外)。
- 套件踩坑库 = ah-files repo 的 `docs/LESSONS.md`(L 编号);动工前只扫 `## L` 标题清单(`grep -n '^## L'`,一屏看完),命中相关条目才读该节全文,绝不默认全文加载;踩到 >30 分钟的架构坑必须加一条(在只见本 repo 的环境读不到时,请 Oskar 提供)。

## 10. Known Hazards
- push 即上线:半成品绝不 push。
- Gemini 免费 tier 配额共享:选模型/加调用前想想额度。

## 11. Documentation Map
`worker.js`(VERSION + contract 实码)· `docs/architecture.md`(锁定边界与升级规程)· `docs/roadmap.md`(状态/待办)· `README.md`(GitHub 门面)· `test/`(auth/key/runner)。
