# markdown-reviewer

个人 Markdown 文档审批工作台。数据源为 GitHub 仓库的 PR 与 Review：单据 = PR，审批节点 = Review，链路 = 提交 → 各审批人 → 合并/关闭。访问需 GitHub 账号登录，且登录账号须属于配置的组织。

## 目录结构

```
├── src/index.ts          路由、登录门禁、OAuth 回调、接口
├── src/session.ts        会话签名与读取（HMAC-SHA256 Cookie）
├── src/diff.ts           GitHub API 封装（PR、文件、评论、Review）
├── src/mock.ts           演示数据，仅 MOCK_MODE=1 使用
├── public/index.html     工作台页面
├── public/diff.js        工作台控制器
├── public/diff-model.js  统一差异模型
├── public/marked.min.js  vendored marked@12
├── public/purify.min.js  vendored DOMPurify 3.2
├── public/styles.css     样式
├── public/app.js         列表、筛选与审批链路
├── scripts/smoke.mjs     健康检查冒烟断言
├── wrangler.jsonc        Cloudflare Worker 配置
├── package.json          依赖与命令
├── tsconfig.json         类型检查配置
└── README.md             本文件
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 健康检查，200 与 JSON |
| GET | `/auth/login` | 否 | 跳转 GitHub 授权 |
| GET | `/auth/callback` | 否 | 换取身份、校验组织、写入会话 Cookie |
| GET | `/auth/logout` | 否 | 清除会话 |
| GET | `/api/me` | 是 | 当前登录账号 |
| GET | `/api/approvals` | 是 | 单据列表（PR 列表） |
| GET | `/api/approvals/{number}` | 是 | 单据详情（含审批链路） |
| GET | `/` | 是 | 已登录返回界面，未登录返回登录页 |

`/api/health` 返回示例：

```json
{
  "status": "ok",
  "service": "approval-visualization-worker",
  "environment": "production",
  "timestamp": "2026-11-05T02:10:00.000Z",
  "commit": "1b544fe",
  "endpoints": ["/api/health", "/api/approvals", "/api/me"]
}
```

健康检查不访问数据库、GitHub API 或任何外部服务，因此可独立判定 Worker 是否运行。

## 登录与鉴权

1. `/auth/login` 生成随机 `state` 写入短期 Cookie，跳转 GitHub 授权页（scope `read:org`）。
2. `/auth/callback` 校验 `state`，用 `code` 换取令牌，读取用户信息。
3. 若配置 `GITHUB_ORG`，调用 `/user/memberships/orgs/{org}` 校验成员身份；非成员返回 403。
4. 通过后写入 AES-GCM 加密会话 Cookie（8 小时有效）；OAuth 访问令牌仅保存在加密会话中，不单独明文写入 Cookie 或数据库。

会话密钥与 OAuth 凭据均为 Worker 侧 Secret，不写入仓库。

## 数据源

服务端使用 `GITHUB_DATA_TOKEN` 读取仓库数据；提交 Review 时使用当前登录会话中的 OAuth 令牌（OAuth scope 包含 `repo`），避免只读数据令牌导致提交失败。

- `GITHUB_DATA_TOKEN` 仅用于读取 PR、Review、Diff 和文件正文，建议只读、仅限该仓库；
- 登录会话令牌用于提交 Review 和行级评论；
- 未配置 `GITHUB_DATA_TOKEN` 时，读取接口回退到登录会话令牌。

## 本地开发

```bash
npm ci
npx wrangler dev --local --var MOCK_MODE:1 --var SESSION_SECRET:local-dev-secret
# 默认 http://127.0.0.1:8787
```

演示模式（不连 GitHub，不需要任何凭据）：

```bash
curl -c /tmp/jar http://localhost:8787/auth/login    # 直接建立演示会话
```

演示模式下 `/auth/login` 直接建立会话，页面右上角标注「演示数据（MOCK）」。

## 构建与检查

```bash
npm run build        # tsc --noEmit
npx wrangler deploy --dry-run --outdir dist
```

## 生产配置

Worker Secret（用 `npx wrangler secret put <NAME>` 写入，不进仓库）：

| 名称 | 说明 |
|---|---|
| `SESSION_SECRET` | 会话签名密钥，至少 32 字符随机值 |
| `GITHUB_CLIENT_ID` | OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | OAuth App 的 Client Secret |
| `GITHUB_DATA_TOKEN` | 读取仓库 PR 的令牌，建议只读、仅限该仓库 |

`wrangler.jsonc` 中的普通变量：`SERVICE_NAME`、`ENVIRONMENT`、`GITHUB_ORG`、`GITHUB_REPO`、`MOCK_MODE`。

GitHub OAuth App 回调地址填 `<Worker 对外域名>/auth/callback`。仓库内未声明自定义域（见 `wrangler.jsonc`），生产域名（如是否沿用 `workspace.noware.cn`）需在 Cloudflare Dashboard 配置后核对。组织如启用第三方应用限制，需由组织管理员批准该 OAuth App。

## CI/CD

| 工作流 | 触发 | 内容 |
|---|---|---|
| `.github/workflows/ci.yml` | Pull Request / 手动 | `npm ci` → `tsc --noEmit` → `node --test`（64 个用例）；另有 `Production health` 作业跑线上验证 |
| `.github/workflows/deploy-worker.yml` | 合入 `main` / 手动选分支 | 同上校验 → `wrangler deploy --var DEPLOY_COMMIT:<sha>` → 部署后跑线上验证 |

线上验证统一写在 `test/production.test.mjs`（依赖 `*.workers.dev` 与 `api.cloudflare.com`）：

| 断言 | 需要的环境变量 |
|---|---|
| `/api/health` 200、`status=ok`、`commit` 非空且等于 `EXPECT_COMMIT` | `PROD_BASE_URL`、可选 `EXPECT_COMMIT` |
| 线上 Worker 的 `DEPLOY_COMMIT` 等于 `EXPECT_COMMIT`，且 3 个必需运行时 Secret 均已配置（`GITHUB_DATA_TOKEN` 可选） | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |

本地不设这些变量时两条用例自动 skip，`npm test` 可离线全绿；需要手动核对线上时跑 `PROD_BASE_URL=... npm run test:prod`（或把 `PROD_BASE_URL` 换成 `http://127.0.0.1:8787` 验证 `wrangler dev`）。

仓库 Secret（Settings → Secrets and variables → Actions）：

| 名称 | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，权限 `Workers Scripts:Edit`；建议同时限定到本账号 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（Dashboard 右侧栏可复制） |

仓库 Variable `PROD_BASE_URL`（当前值 `https://approval-visualization-worker.dante-sun-4ec.workers.dev`）：线上验证的地址；绑自定义域后改成自定义域名即可。`deploy-worker.yml` 在变量缺失时会退化为从 `wrangler deploy` 输出里解析 `*.workers.dev` 地址。

- Worker 运行时 Secret（`SESSION_SECRET`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_DATA_TOKEN`）与 CI 无关：部署不会覆盖，首次仍需 `npx wrangler secret put <NAME>`；线上验证会断言必需的 3 个 Secret 存在（`GITHUB_DATA_TOKEN` 可选，缺省时读取接口回退登录者令牌）。
- 部署提交号写入 Worker 变量 `DEPLOY_COMMIT`，`GET /api/health` 的 `commit` 字段可直接核对；部署后验证会断言 `/api/health` 与线上绑定都等于本次提交。
- 手动部署：`npm run deploy`；带提交号：`npm run deploy:ci`（优先读 `GITHUB_SHA`，回退 `WORKERS_CI_COMMIT_SHA`）。
- 部署是全量上传后切流量，构建/测试失败时不会改动线上版本。

## 回滚

Cloudflare Dashboard → Workers & Pages → 对应 Worker → Deployments，选择上一个成功版本执行 Rollback；或命令行：

```bash
npx wrangler rollback --name approval-visualization-worker
```

回滚后用 `GET /api/health` 核对 `commit` 是否回到期望版本。

## 变更查看与行级评审批注（2026-11-05）

页面新增「变更查看与评审批注」页签，能力与 GitHub 权限一一对应：

| 能力 | 接口 | 说明 |
| --- | --- | --- |
| 取 PR 元信息与文件清单 | `GET /api/approvals/{n}/diff` | 返回 `meta`、`files`（含 patch）、`comments` |
| 取改前/改后原文 | `GET /api/approvals/{n}/file?path=&ref=` | `ref` 传 base 或 head 的 commit sha，供渲染视图对照 |
| 一次提交多条意见 | `POST /api/approvals/{n}/comments` | 合并为一条 `event=COMMENT` 的 review，行号取 head 侧真实行 |

实现要点：

- 行号优先由渲染块的真实行号锚点映射；无法映射时仅接受唯一、连续的文本匹配，存在歧义时不生成评论锚点。
- 草稿绑定创建时的 head commit SHA；PR 有新提交时旧草稿会标记过期并禁止提交，必须重新定位。
- 删除文件和重命名文件分别按 GitHub 文件状态读取 base/head 正文；新增文件的 base 侧和删除文件的 head 侧为空。
- 渲染视图按 Markdown 原文分块，每块挂真实行号锚点，评论始终回落到 `path + line`。
- 已合并或已关闭的 PR 不允许再写评论，接口返回 409，页面显示只读提示。
- 提交 Review 成功后服务端立即失效该 PR 的 diff 缓存，页面无需整页强刷即可看到新评论；正文按 `path + headSha + baseSha` 复用，不因评论刷新重新拉取。
