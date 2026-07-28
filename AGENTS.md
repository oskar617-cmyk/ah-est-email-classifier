# ah-est-email-classifier Agent Rules(纯 Cloudflare Worker)

## 1. Identity
- 代理 Gemini 的 Worker,服务 AH Estimating 的 AI 管线:runMethod(取 Vaenyx 配方 → Gemini → draft-07 schema 校验)承载 estimating 的 method 家族(classify / quote-match / quote-questions / quote-analysis / visionOcr / takeoff 等),另有早期任务(extractAmount / summarizeFilename)。
- 技术特征:Uses MSAL: no · Deploy target: Cloudflare Worker(**纯 Worker:push 即上线、无 staging——push/deploy 逐次先问 Oskar**)· PWA: no。

## 2. Read First
1. `worker.js` 头部 VERSION + 版本史注释(响应带 `X-Worker-Version`)
2. 消费端:ah-estimating 的 `js/runner.js` / `js/ai.js` 与其 docs/roadmap(Worker 版本变迁记录在那边)

## 3. Current Snapshot
以 `worker.js` VERSION 为准(交接文档曾停在 v0.04,实际早已远超:v0.21+ 含 `gemini-3.1-flash-lite` 单模型、visionOcr、Origin 白名单 403 + CORS fail-closed + 90/min 限流门禁——细节见 ah-estimating docs/roadmap)。(替换制。)

## 4. Hard Rules
- API contract 与 ah-estimating 端锁定:改动必须两 repo 同步。
- Secrets 在 Cloudflare 端:`GEMINI_API_KEY`、`VANTA_APP_TOKEN`(Vaenyx 配方令牌)、CORS/vars 在 wrangler [vars]。
- 根目录 `wrangler.toml` = Worker 标记,绝不跑 Pages 转换。
- 换 Vaenyx token 后必须冒烟 classify 一次。

## 5. Architecture And Data Boundaries
无持久数据;浏览器永不持令牌(app→Worker→Vaenyx/Gemini);门禁 = Origin 白名单 + 限流。

## 6. Commands
- URL:https://ah-est-email-classifier.oskar617.workers.dev。
- 部署:Cloudflare 原生 Git 集成——**push 到 main 即自动部署上线**(push 前逐次问)。
- GitHub repo:github.com/oskar617-cmyk/ah-est-email-classifier(private)。

## 7. Verification And Release
改完先问 Oskar → push(即上线)→ 真打一次 classify 冒烟 → 通知 ah-estimating 侧核对。

## 8. Multi-Agent Conflict Hotspots
- method 名 / schema / 门禁配置 = ah-estimating 的公共接口:跨 repo 先协调。

## 9. Shared Rulesets

<!-- SHARED-RULESET:AH-SUITE VERSION:2 UPDATED:2026-07-28 -->
- 套件:Auzzie Homes Pty Ltd(墨尔本建筑公司)内部工作 app 套件;各 app 经 jobCode 互联;**`ah-jobs-rego` 是全套件 job 数据唯一 source of truth,任何 app 不得自建 job list**。
- SharePoint 拓扑(锁定):所有 Lists 在 AH Site(`auzziehomes.sharepoint.com/sites/AHSite`);文件/文件夹留各自原站(默认 AHOffice)。List 命名 `[App Name] [Purpose] List`(空格分隔、无连字符);config 存确切字符串,读其他 app 的 List 必须逐字一致。
- 单一 Entra tenant `ff968505-cca0-4cd1-9f6d-68ce6eaf06c7`;one app one registration;admin `oskar@auhs.com.au`。
- 本地测试连的是**真 SharePoint 数据**:测试 job 用明显 TEST 名,测完删除。
- AI 功能默认经 Cloudflare Worker 代理调用(模型 key 不写进前端代码;用户在设置里自带 key 的 Direct 模式除外)。
- 套件踩坑库 = ah-files repo 的 `docs/LESSONS.md`(L 编号);动工前读一遍,踩到 >30 分钟的架构坑必须加一条(在只见本 repo 的环境读不到时,请 Oskar 提供)。
(AH-PWA-MSAL 不适用:本 repo 非 PWA、无 MSAL。)

## 10. Known Hazards
- push 即上线:半成品绝不 push。
- Gemini 免费 tier 配额共享:选模型/加调用前想想额度。

## 11. Documentation Map
`worker.js`(VERSION + 版本史注释)· ah-estimating `docs/roadmap.md`(演进史)· `README.md`。
