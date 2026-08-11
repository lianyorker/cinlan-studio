# Creative Core PostgreSQL 运维

Creative Core 只实现 PostgreSQL。数据库保存 owner、加密 Worker credential、job、event、asset metadata、model capability 和 version lineage；图片字节保存在持久化文件系统。

当前生产目标：

- 应用域名：`https://studio.cinlan.online`
- PostgreSQL：`127.0.0.1:5432`
- 数据库：`cinlan-studio`
- 资产目录：`/var/lib/cinlan-studio/assets`

数据库密码、API Key 和 `CINLAN_SESSION_SECRET` 不属于文档或发布包内容。

## 配置

生产模板见 [`../deploy/.env.production.example`](../deploy/.env.production.example)：

```dotenv
DATABASE_URL=postgresql://postgres:REPLACE_WITH_DATABASE_PASSWORD@127.0.0.1:5432/cinlan-studio
CINLAN_SESSION_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
CREATIVE_ASSET_STORAGE_DIR=/var/lib/cinlan-studio/assets
CREATIVE_DATABASE_POOL_SIZE=10
CREATIVE_WORKER_CONCURRENCY=2
CREATIVE_WORKER_INTERVAL_MS=1000
CREATIVE_IN_PROCESS_WORKER=false
CREATIVE_PLANNER_ENABLED=true
CREATIVE_PLANNER_MODEL=gpt-5.2
CREATIVE_PLANNER_EFFORT=xhigh
PGSSLMODE=disable
```

- 本机 loopback PostgreSQL 可使用 `PGSSLMODE=disable`。
- 远程 PostgreSQL 应使用 `PGSSLMODE=require` 和 `PGSSL_REJECT_UNAUTHORIZED=true`，并安装可信 CA。
- `CINLAN_SESSION_SECRET` 必须稳定。更换后，API Key owner fingerprint 会变化，已有加密 Worker credential 无法解密。
- Web 与 Worker 必须读取同一环境文件和同一资产目录。
- `CREATIVE_IN_PROCESS_WORKER=false` 是生产要求；开发环境可选择进程内 Worker。
- 资产目录不能由 Nginx 直接公开，所有读取必须经过 owner-scoped API。

## 迁移

迁移前：

1. 备份数据库与资产目录。
2. 确认 `DATABASE_URL` 指向预期数据库。
3. 停止新任务进入，或在首次上线时先保持 Nginx 未切流。
4. 使用运行应用的系统用户执行迁移。

```bash
sudo -u cinlan bash -lc '
  set -a
  source /etc/cinlan-studio.env
  set +a
  cd /opt/cinlan-studio
  npm run db:migrate
'
```

迁移器使用 PostgreSQL advisory lock，按文件名顺序执行 `db/migrations/*.sql`。每个迁移在事务中执行，并记录到 `schema_migrations`；重复执行会跳过已应用文件。

迁移后核对：

```bash
sudo -u cinlan bash -lc '
  set -a
  source /etc/cinlan-studio.env
  set +a
  psql "$DATABASE_URL" -c "SELECT name, applied_at FROM schema_migrations ORDER BY name"
'
```

不要把 `GET /api/v1/creative/config` 当成数据库健康检查。该接口的 `enabled: true` 只表示进程读到了非空 `DATABASE_URL`；还需要通过数据库查询和实际任务验证连通性。

## Worker

生产使用独立进程：

```bash
npm run worker:creative
```

Worker 使用 `FOR UPDATE SKIP LOCKED` 和 15 分钟 lease。多个 Worker 可以并发运行，但并发上限必须结合 provider 限流与 PostgreSQL 连接数设置。Worker 批次失败时会指数退避，最长 30 秒。

状态机：

```text
CREATED -> ANALYZING -> READY -> QUEUED -> RUNNING -> VALIDATING -> COMPLETED
```

取消使用 `CANCEL_REQUESTED -> CANCELLED`。异常终态包括 `FAILED`、`EXPIRED` 和 `PARTIAL_SUCCESS`。每次状态变化均写入 `creative_job_events`。

## 备份与恢复

PostgreSQL 与资产目录必须在同一个维护窗口备份：

```bash
sudo install -d -m 700 /var/backups/cinlan-studio
sudo -u cinlan bash -lc '
  set -a
  source /etc/cinlan-studio.env
  set +a
  pg_dump --format=custom --file=/var/backups/cinlan-studio/database.dump "$DATABASE_URL"
  tar -czf /var/backups/cinlan-studio/assets.tar.gz -C /var/lib/cinlan-studio assets
'
```

生产上应把备份复制到独立存储并设置保留策略。恢复时先停止 Web 和 Worker，再恢复数据库、资产目录和原 `CINLAN_SESSION_SECRET`，最后启动服务并验证一条历史资产和一条新任务。

只恢复 PostgreSQL 会留下无法读取的资产引用；只恢复文件目录会留下无所有权和无元数据的孤立文件。

## 回退

- 移除 `DATABASE_URL` 会关闭 Creative Core 并恢复兼容图片路径，但不会删除 PostgreSQL 行或资产文件。
- 应用回退时不要删除 Creative Core 表。
- Web 与 Worker 必须同时回退到同一版本。
- 数据库迁移当前只提供向前执行；需要 schema 回退时必须先从已验证备份恢复，而不是手工 drop 表。

## 验证

仓库级检查：

```powershell
npx.cmd tsc --noEmit
npm.cmd run test:smoke
$env:CINLAN_TEST_DATABASE_URL='postgresql://user:password@127.0.0.1:5432/test_database'
npm.cmd run test:postgres
```

`test:postgres` 只读取 `CINLAN_TEST_DATABASE_URL`，在随机 schema 内执行迁移与集成测试，最后删除该 schema；它不会回退使用 `DATABASE_URL`。

生产验收至少包含：

1. 查询 `schema_migrations`。
2. `systemctl is-active cinlan-studio cinlan-studio-worker` 均返回 `active`。
3. `/api/v1/creative/config` 返回 `enabled: true`。
4. 提交一条低成本任务并观察事件前进，不允许长期停在 `CREATED`。
5. 刷新浏览器后任务仍存在，完成图片可打开并带正确扩展名下载。
6. 取消和失败重试分别到达预期状态。
7. 验证 PostgreSQL 与资产目录的成对恢复。

## 已验证模型能力

内置能力采用保守默认值。只有 `verified_at IS NOT NULL` 且 JSON 完整有效的 `model_capabilities.capabilities` 才会覆盖内置值；同一解析结果驱动模型目录、Composer 控件、提交校验与 Worker 校验。

```sql
INSERT INTO model_capabilities(model_slug, capabilities, source, verified_at)
VALUES (
  'provider-model-slug',
  '{"text_to_image":true,"image_edit":false,"multi_image":false,"mask":false,"asynchronous":true,"max_reference_images":0,"max_outputs":1,"aspect_ratios":["1:1"],"qualities":["high"],"resolutions":[]}'::jsonb,
  'provider-contract-YYYY-MM-DD',
  now()
)
ON CONFLICT(model_slug) DO UPDATE SET
  capabilities = EXCLUDED.capabilities,
  source = EXCLUDED.source,
  verified_at = EXCLUDED.verified_at,
  updated_at = now();
```

能力未确认时保持 `verified_at` 为 null。无效或不完整的 JSON 会被忽略，系统继续使用保守内置规则。
