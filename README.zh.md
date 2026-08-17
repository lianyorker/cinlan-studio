# Cinlan Studio（星澜绘坊）

Cinlan Studio 是 Cinlan 的 AI 创作工作台，覆盖图片生成、图片编辑、结构化文字生成和可恢复的创作历史。`0.2.7` 使用 Next.js 同源 BFF、PostgreSQL Creative Core 与独立 Worker，使长时间任务在刷新页面或进程重启后仍可恢复。

[English](./README.md) | **简体中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [部署手册](./deploy/DEPLOY.md)

## 功能

- 文生图、单图编辑，以及最多 4 张参考图的多图输入。
- 多张结果并发任务、单独取消、失败重试、刷新恢复和持久化活动事件。
- 模型能力驱动的质量、张数、比例和创作分析强度控制。
- 文字结果支持 Markdown 与 GFM，正确展示标题、列表、表格、链接和代码块。
- 历史文字详情可独立滚动，并能在普通页面和 Sub2API 嵌入页面可靠复制结果。
- 创作历史支持滚动分页加载、结果去重和失败重试，不再只显示首批 24 条作品。
- Owner 隔离的图片资产、原图流式传输、WebP 缩略图缓存、ETag 和私有浏览器缓存。
- 支持从提示词解析比例、横竖版方向，以及 `1600x440` 这类明确像素尺寸。
- Sub2API 账号登录、2FA、嵌入 SSO，以及服务端按 owner/group 管理的内部凭据；浏览器不会获得 provider key。
- 图片、文字、视频入口按分组能力动态显示；分组未配置或被删除时，只禁用对应能力。

模型目录由当前登录的 Sub2API 账号动态返回，实际能力以 `GET /api/v1/models` 为准。

## 架构

```text
Browser
  -> Cinlan Studio /api/v1/* (Next.js BFF)
       -> PostgreSQL（owner、任务、事件、资产、版本、内部凭据）
       -> CREATIVE_ASSET_STORAGE_DIR（原图和派生缩略图）

Creative Worker
  -> PostgreSQL lease queue
  -> structured creative planner
  -> Sub2API / provider
```

账号会话写入 AES-256-GCM 加密的 HttpOnly Cookie。PostgreSQL 加密保存 Sub2API 身份 token，以及每个 owner/group 唯一复用的内部 Key。密钥不得写入日志、Git、文档或发布包。

Creative Core 只支持 PostgreSQL。图片字节存储在文件系统，PostgreSQL 保存资产元数据和所有权。`CREATIVE_ASSET_STORAGE_DIR/.thumbnails` 中的 WebP 是可重建缓存。

## 环境要求

- Node.js 22 或 24
- PostgreSQL 14+
- 可持久化并允许应用写入的资产目录
- 可访问的 Sub2API 服务

## 开发启动

```bash
npm ci
npm run db:migrate
npm run dev
```

访问 `http://localhost:3000`。

最小开发配置：

```dotenv
SUB2API_BASE_URL=https://api.example.com
SUB2API_STUDIO_IMAGE_GROUP_ID=REPLACE_WITH_IMAGE_GROUP_ID
SUB2API_STUDIO_TEXT_GROUP_ID=
SUB2API_STUDIO_VIDEO_GROUP_ID=
CINLAN_STUDIO_INSTALLATION_ID=cinlan-studio-development
CINLAN_SESSION_SECRET=replace-with-a-stable-random-secret
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/cinlan-studio
CREATIVE_ASSET_STORAGE_DIR=./data/assets
CREATIVE_IN_PROCESS_WORKER=true
```

生产环境必须设置 `CREATIVE_IN_PROCESS_WORKER=false`，并将 `npm run worker:creative` 作为独立服务运行。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建 Next.js standalone 产物 |
| `npm run start` | 启动常规生产服务 |
| `npm run db:migrate` | 执行 PostgreSQL 迁移 |
| `npm run worker:creative` | 启动独立 Creative Worker |
| `npm run test:markdown` | 验证 Markdown/GFM 渲染 |
| `npm run test:image-size` | 验证明晰尺寸、比例和横竖版提示词解析 |
| `npm run test:assets` | 验证缩略图、缓存、ETag、流式读取和并发 |
| `npm run test:smoke` | 执行 BFF 与浏览器烟雾测试 |
| `npm run test:standalone` | 启动并探测 standalone 构建 |
| `npm run test:postgres` | 使用 `CINLAN_TEST_DATABASE_URL` 执行隔离的 PostgreSQL 测试 |
| `npx tsc --noEmit` | TypeScript 类型检查 |

## API

### 兼容 API

| 操作 | 端点 |
| --- | --- |
| 登录 / 2FA / 可选 API Key | `POST /api/v1/auth/login`、`POST /api/v1/auth/login/2fa`、`POST /api/v1/auth/key` |
| 嵌入 SSO | `POST /api/v1/auth/embed` |
| 登出 | `POST /api/v1/auth/logout` |
| 模型目录 | `GET /api/v1/models` |
| 账户信息 | `GET /api/v1/me` |
| 图片生成或编辑 | `POST /api/v1/generate/image` |
| 文字生成 | `POST /api/v1/generate/text` |
| 视频生成 | `POST /api/v1/generate/video` |
| 上传参考图 | `POST /api/v1/upload` |
| 查询兼容任务 | `GET /api/v1/tasks/:id` |
| 历史记录 | `GET /api/v1/generations` |

### Creative Core API

| 操作 | 端点 |
| --- | --- |
| 配置状态 | `GET /api/v1/creative/config` |
| 创建 / 列出任务 | `POST|GET /api/v1/creative/jobs` |
| 查询 / 取消 / 重试 / 删除任务 | `GET|PATCH|DELETE /api/v1/creative/jobs/:id` |
| 任务活动 | `GET /api/v1/creative/jobs/:id/events` |
| 获取 / 删除资产 | `GET|DELETE /api/v1/creative/assets/:id` |

标准任务状态：

```text
CREATED -> ANALYZING -> READY -> QUEUED -> RUNNING -> VALIDATING -> COMPLETED
```

其他终态包括 `PARTIAL_SUCCESS`、`FAILED`、`CANCELLED` 和 `EXPIRED`；取消过程使用 `CANCEL_REQUESTED`。

## 生产部署

生产站点为 [https://studio.cinlan.online](https://studio.cinlan.online)，配置模板和操作手册位于 [`deploy/`](./deploy/)。

不要把 Windows 构建的 standalone 目录部署到 Linux。应上传 Linux 源码包，并在服务器执行：

```bash
npm ci
npm run db:migrate
npm run build
```

PostgreSQL、`CREATIVE_ASSET_STORAGE_DIR` 和稳定的 `CINLAN_SESSION_SECRET` 必须作为一个逻辑数据集同步备份。

## 文档

- [生产部署](./deploy/DEPLOY.md)
- [BFF 与存储架构](./docs/deployment-bff.md)
- [Creative Core 交付基线](./docs/creative-core-delivery.md)
- [PostgreSQL 运维](./docs/creative-core-postgresql.md)
- [Studio Credential Broker](./docs/studio-credential-broker-delivery.md)

## 许可证

[MIT](./LICENSE)
