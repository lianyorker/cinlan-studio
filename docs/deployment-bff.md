# Cinlan Studio BFF 与存储架构

## 请求链路

```text
Browser -> Cinlan Studio same-origin BFF -> Sub2API -> Provider
                    |                     ^
                    v                     |
             PostgreSQL <- Creative Worker
                    |
             persistent asset directory
```

浏览器只访问同源 `/api/v1/*`。登录、模型目录、生成、上传、任务查询和历史记录均由 Next.js Route Handler 代理；Sub2API 继续负责账号分组、模型路由、余额、倍率和计费。

浏览器不保存 Sub2API 管理密钥，也不把用户 API Key 写入 LocalStorage。登录会话使用 AES-256-GCM 加密的 HttpOnly Cookie。Creative Worker 需要的 API Key 通过同一个 `CINLAN_SESSION_SECRET` 加密后写入 PostgreSQL。

## 两种运行模式

### Creative Core 模式

存在非空 `DATABASE_URL` 时启用：

- `/api/v1/generate/image` 创建 PostgreSQL 持久化任务并返回兼容的 `task_id`。
- `/api/v1/upload` 将图片写入持久化资产目录，并把所有权与元数据写入 PostgreSQL。
- `/api/v1/tasks/:id` 和 `/api/v1/generations` 从 Creative Core 读取任务与历史。
- 独立 Worker 使用 PostgreSQL lease 获取任务，执行创作规划、provider 提交、轮询、结果校验与持久化。
- 刷新页面后，前端可从服务端恢复活动任务和历史结果。

生产环境只支持该模式，并要求独立 Worker。

### 兼容模式

未配置 `DATABASE_URL` 时：

- `GET /api/v1/creative/config` 返回 `enabled: false`。
- `/api/v1/generate/image` 直接使用兼容 provider 路径。
- 上传可以返回开发用内联 `data:` URL。
- 服务端不会提供 PostgreSQL 持久化任务、跨设备历史或 Worker 恢复。

兼容模式用于本地开发和回退，不是生产 A+ Core 的验收形态。

## 必需环境变量

```dotenv
SUB2API_BASE_URL=https://api.cinlan.online
CINLAN_SESSION_SECRET=replace-with-a-stable-random-secret
SUB2API_STUDIO_GROUP_ID=

DATABASE_URL=postgresql://user:password@127.0.0.1:5432/database_name
CREATIVE_ASSET_STORAGE_DIR=/var/lib/cinlan-studio/assets
CREATIVE_IN_PROCESS_WORKER=false
```

- 生产环境必须设置稳定、随机的 `CINLAN_SESSION_SECRET`。
- `CREATIVE_ASSET_STORAGE_DIR` 必须由 Web 和 Worker 共享，并位于持久化磁盘。
- `SUB2API_STUDIO_GROUP_ID` 可为空；设置时只允许使用指定工作室分组。
- 不得在仓库、发布包、systemd unit 或文档中填入真实密码和密钥。

登录仅在 `Cinlan Studio` Key 属于目标 Composite 分组时复用；不存在时由 BFF 创建。不会静默回退到任意分组。

## PostgreSQL 所有权

- 登录会话使用稳定的上游用户 ID 作为 owner。
- API Key 会话使用 HMAC fingerprint 作为 owner ID，原始 Key 不参与所有权查询。
- Job、event、asset 和 version 的读取、更新与删除均校验 `owner_id`。
- PostgreSQL 保存资产元数据；文件内容保存在 `CREATIVE_ASSET_STORAGE_DIR`。

历史不再只依赖浏览器 IndexedDB。Creative Core 启用后，服务端历史是权威来源；浏览器本地历史只保留兼容用途。

## 嵌入模式

```dotenv
CINLAN_EMBEDDED=true
CINLAN_FRAME_ANCESTORS="'self' https://api.cinlan.online"
CINLAN_ALLOWED_ORIGINS=https://studio.cinlan.online https://api.cinlan.online
CINLAN_COOKIE_SECURE=true
```

`CINLAN_EMBEDDED=true` 会在生产环境把会话 Cookie 设置为 `SameSite=None; Secure`。`CINLAN_FRAME_ANCESTORS` 控制 CSP `frame-ancestors`。反向代理改变公开 origin 时，必须把真实 origin 加入 `CINLAN_ALLOWED_ORIGINS`，否则有状态请求会被 Origin 校验拒绝。

Sub2API Custom Page 会在 iframe 和“新窗口打开”URL 中附加：

- `user_id`
- `token`
- `theme`
- `lang`
- `ui_mode=embedded`
- `src_host`
- `src_url`

Studio 首次加载时将 `token`、`user_id` 和 `src_host` 发送到同源 `POST /api/v1/auth/embed`。BFF 使用 token 调用 Sub2API `/api/v1/auth/me`，校验返回用户与 `user_id` 一致，再创建或复用 `Cinlan Studio` Key 并写入加密 HttpOnly Cookie。客户端捕获参数后立即从地址栏删除 `token`、`user_id`、`src_host` 和 `src_url`，不会写入 LocalStorage。

`theme` 和 `lang` 保留在清理后的 URL 中，并分别同步到 Studio 主题与语言。无效 token、用户不匹配和未授权 `src_host` 必须返回明确的 4xx/5xx，不能降级为信任未验证 JWT。

因为 Sub2API 当前把 token 放在 query string，初始导航仍会经过 CDN 与 Nginx。生产 Nginx 模板使用不包含 `$args` 的专用 access log，避免在源站访问日志中记录 token；CDN 侧也应禁用包含 query 的日志或对该参数脱敏。更理想的后续协议是短时一次性 code exchange。

## 生产边界

- PostgreSQL 是唯一数据库实现；没有 SQLite adapter。
- 资产目录不能直接配置成公开静态目录，必须通过 owner-scoped asset API 获取。
- 单机文件系统不支持多节点复制；横向扩容前需要先引入共享文件系统或对象存储。
- PostgreSQL 与资产目录必须作为一个逻辑数据集同步备份、恢复。
- Web 与 Worker 的代码版本和 `CINLAN_SESSION_SECRET` 必须一致。

具体操作见 [`../deploy/DEPLOY.md`](../deploy/DEPLOY.md) 和 [`creative-core-postgresql.md`](./creative-core-postgresql.md)。
