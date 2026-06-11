# AH Est Email Classifier(Cloudflare Worker)
> 本文件与 docs/ 由 claude.ai 的 Claude 于 2026-06-11 交接,是本项目的 context 来源。工作中保持更新:每完成阶段性改动,更新 docs/roadmap.md。

- 是什么:代理 Google Gemini 的 Cloudflare Worker,服务 AH Estimating PWA。三任务:`classify`(邮件回复 6 分类)、`extractAmount`(从邮件 / PDF 文本提报价金额)、`summarizeFilename`(PascalCase 文件名片段)
- 模型:`gemini-3-flash`;`worker.js` 内有 `VERSION` 常量(现 v0.04)+ 版本史注释;响应带 `X-Worker-Version` header
- Secrets(存 Cloudflare 端):`GEMINI_API_KEY`、`CORS_ORIGINS`
- ⚠️ 部署机制:Cloudflare 原生 Git 集成——push 到 main 即自动部署上线。任何 push 前必须单独向 Oskar 确认
- ⚠️ 根目录 `wrangler.toml` = Worker 标记;绝不对本 repo 跑任何 Pages 转换
- API contract 与 PWA 端锁定,改动必须与 `ah-estimating` 同步
