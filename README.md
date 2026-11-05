# approval-visualization-worker

审批可视化 Worker。数据源为 GitHub 仓库的 PR 与 Review：单据 = PR，审批节点 = Review，链路 = 提交 → 各审批人 → 合并/关闭。访问需 GitHub 账号登录，且登录账号须属于配置的组织。

## 目录结构

```
apps/approval-visualization-worker/
├── src/index.ts          路由、登录门禁、OAuth 回调、接口
├── src/session.ts        会话签名与读取（HMAC-SHA256 Cookie）
├── src/github.ts         GitHub API 读取与单据映射
├── src/mock.ts           演示数据，仅 MOCK_MODE=1 使用
├── src/types.ts          单据与节点类型
├── public/index.html     审批可视化页面
├── public/login.html     登录页
├── public/styles.css     样式（华为红 + 灰白扁平）
├── public/app.js         列表、筛选、详情与审批链路渲染
├── scripts/smoke.mjs     健康检查冒烟断言
├── wrangler.jsonc        Workers 与静态资源配置
├── package.json          依赖与命令
├── tsconfig.json         类型检查配置
├── .gitignore            本地开发产物
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

GitHub OAuth App 回调地址填 `https://workspace.noware.cn/auth/callback`。组织如启用第三方应用限制，需由组织管理员批准该 OAuth App。

## 生产部署（GitHub Actions）

流水线文件：`.github/workflows/deploy-worker.yml`。

| 项目 | 配置 |
|---|---|
| 触发 | `main` 分支下本目录或工作流文件变更；`topic/approval-visualization-mvp` 分支仅在提交信息以 `deploy:` 开头时触发；支持 `workflow_dispatch` 手动触发 |
| 运行环境 | `ubuntu-latest`，Node 22，`environment: production` |
| 步骤 | checkout → `npm ci` → `npm run build` → `cloudflare/wrangler-action@v3` 部署 → 生产健康检查 |
| 部署命令 | `deploy --var DEPLOY_COMMIT:<github.sha>` |

仓库需配置：

| 类型 | 名称 | 必须 | 说明 |
|---|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 是 | 需 `Workers Scripts:Edit` |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 是 | 账号 ID |
| Variable | `PRODUCTION_URL` | 否 | 设置后自动执行生产 `/api/health` 校验 |

`DEPLOY_COMMIT` 注入本次提交 SHA，`PRODUCTION_URL` 设置后流水线会用 `EXPECT_COMMIT` 断言生产 `commit` 与本次提交一致。

生产部署默认由 `main` 的合规更新触发。为本次个人应用部署，额外允许 `topic/approval-visualization-mvp` 分支使用 `deploy:` 前缀提交触发；其他 `topic/*` 分支仍不触发生产部署。仓库内不保存任何 Token 或密钥。

## 回滚

Cloudflare Dashboard → Workers & Pages → `approval-visualization-worker` → Deployments，选择上一个成功版本执行 Rollback，然后用 `BASE_URL=<生产地址> npm run smoke` 复核。

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

## 部署触发方式（2026-11-05 现状）

`main` 目前不含该应用，`.github/workflows/deploy-worker.yml` 也尚未进入默认分支，因此"推送 main 自动部署"暂未生效。当前可用的部署通道是：

```bash
curl -X POST -H "Authorization: token <gh-token>" \
  https://api.github.com/repos/noware-cn/workspace/actions/workflows/407164727/dispatches \
  -d '{"ref":"topic/approval-visualization-mvp"}'
```

该动作以目标分支的 workflow 文件执行 `npm ci → tsc → wrangler deploy --var DEPLOY_COMMIT:<sha>`，部署完成后 `/api/health` 的 `commit` 字段即为本次提交 SHA，可直接对账。

应用合入 `main` 后，删除上面这段说明，改由 `deploy-worker.yml` 的 main push 触发即可。
