# Cinlan Studio 生产部署

目标：

- 域名：`https://studio.cinlan.online`
- 主机：`8.166.115.153`
- 应用监听：`127.0.0.1:3000`
- PostgreSQL：`127.0.0.1:5432/cinlan-studio`
- Web 与 Creative Worker：独立 systemd service

本文不包含数据库密码、API Key 或 Session Secret。真实值只写入服务器 `/etc/cinlan-studio.env`。

## 1. 前置条件

1. `studio.cinlan.online` 的 A 记录指向目标主机。
2. 安全组和主机防火墙允许 TCP 80/443；3000 和 5432 不对公网开放。
3. 安装 Node.js 24.x、Nginx、PostgreSQL client 和 TLS 工具。
4. PostgreSQL 已创建数据库 `cinlan-studio`，应用账号拥有该数据库所需 DDL/DML 权限。
5. 已准备当前 Linux 源码发布包及其 SHA-256。

Windows 上生成的 `.next/standalone` 含 Windows 原生依赖，不能上传后直接在 Linux 运行。必须上传源码包并在 Linux 服务器构建。

## 2. 校验并安装源码

先在本地核对发布包输出的 SHA-256，再上传到服务器。以下文件名以当前版本为例，实际以发布包为准：

```bash
sha256sum /tmp/cinlan-studio-0.2.8-linux-source-20260911.tar.gz
```

创建系统用户和目录：

```bash
sudo useradd --system --home /opt/cinlan-studio --shell /usr/sbin/nologin cinlan 2>/dev/null || true
sudo install -d -o cinlan -g cinlan /opt/cinlan-studio /var/lib/cinlan-studio/assets
```

首次安装源码包：

```bash
sudo -u cinlan tar -xzf /tmp/cinlan-studio-0.2.8-linux-source-20260911.tar.gz \
  --strip-components=1 -C /opt/cinlan-studio
cd /opt/cinlan-studio
sudo -u cinlan npm ci
sudo -u cinlan npm run test:assets
sudo -u cinlan npm run build
```

升级时先备份当前代码并在维护窗口替换，不要把旧 `.next`、旧 `node_modules` 或 Windows 构建产物混入新版本。

## 3. 配置环境

```bash
sudo install -m 640 -o root -g cinlan deploy/.env.production.example /etc/cinlan-studio.env
sudoedit /etc/cinlan-studio.env
```

必须替换：

- `DATABASE_URL` 中的数据库密码。
- `CINLAN_SESSION_SECRET`，使用稳定的长随机值。

生产关键值应保持：

```dotenv
NODE_ENV=production
HOSTNAME=127.0.0.1
PORT=3000
CINLAN_COOKIE_SECURE=true
CINLAN_EMBEDDED=true
CINLAN_FRAME_ANCESTORS="'self' https://api.cinlan.online"
CINLAN_ALLOWED_ORIGINS=https://studio.cinlan.online https://api.cinlan.online
SUB2API_STUDIO_IMAGE_GROUP_ID=REPLACE_WITH_IMAGE_GROUP_ID
SUB2API_STUDIO_TEXT_GROUP_ID=
SUB2API_STUDIO_VIDEO_GROUP_ID=
SUB2API_STUDIO_MODEL_GROUP_MAP={}
CINLAN_ALLOW_API_KEY_LOGIN=false
CINLAN_STUDIO_INSTALLATION_ID=cinlan-studio-production
CREATIVE_ASSET_STORAGE_DIR=/var/lib/cinlan-studio/assets
CREATIVE_IN_PROCESS_WORKER=false
PGSSLMODE=disable
```

`SUB2API_STUDIO_IMAGE_GROUP_ID`、`SUB2API_STUDIO_TEXT_GROUP_ID`、`SUB2API_STUDIO_VIDEO_GROUP_ID` 分别控制图像、文字、视频能力及侧边栏入口。未配置的能力不会显示；配置分组被确认删除后，对应能力返回 `STUDIO_GROUP_NOT_FOUND`，不会自动切换到其他分组。`SUB2API_STUDIO_GROUP_ID` 仅保留为旧版图片分组兼容项。

账号登录、2FA 和嵌入 SSO 是生产默认入口。只有明确设置 `CINLAN_ALLOW_API_KEY_LOGIN=true` 才显示手动 Key 登录。Web 与独立 Worker 必须加载相同的 `DATABASE_URL`、`CINLAN_SESSION_SECRET` 和 `CINLAN_STUDIO_INSTALLATION_ID`。

不要把 `/etc/cinlan-studio.env` 复制回源码目录或发布包。

`CREATIVE_ASSET_STORAGE_DIR` 必须允许 Web service 用户写入。`0.2.8` 会在该目录下自动创建 `.thumbnails`，其中只保存可重建的 WebP 预览缓存；原图仍保存在原有 `reference/`、`result/` 等目录中。

## 4. 数据库迁移

先备份数据库和资产目录，再执行：

```bash
sudo -u cinlan bash -lc '
  set -a
  source /etc/cinlan-studio.env
  set +a
  cd /opt/cinlan-studio
  npm run db:migrate
'
```

核对迁移记录：

```bash
sudo -u cinlan bash -lc '
  set -a
  source /etc/cinlan-studio.env
  set +a
  psql "$DATABASE_URL" -c "SELECT name, applied_at FROM schema_migrations ORDER BY name"
'
```

结果必须包含 `001_creative_core.sql`、`003_studio_credential_broker.sql` 和 `004_creative_job_retry_tuning.sql`。缺少 `001` 或 `003` 时账号仍可登录，但模型目录和生成会明确返回 `CREATIVE_SCHEMA_OUTDATED`；缺少 `004` 时现有表不会采用新的 `max_attempts` 默认值，发布前必须补齐迁移。

## 5. 安装 systemd service

```bash
sudo cp deploy/cinlan-studio.service deploy/cinlan-studio-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cinlan-studio cinlan-studio-worker
sudo systemctl status cinlan-studio cinlan-studio-worker --no-pager
```

查看日志：

```bash
sudo journalctl -u cinlan-studio -u cinlan-studio-worker -n 200 --no-pager
sudo journalctl -u cinlan-studio -u cinlan-studio-worker -f
```

先从服务器本机验证 Web：

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/api/v1/creative/config
```

返回 `enabled: true` 只表示已配置 `DATABASE_URL`，还必须通过迁移查询和实际任务确认数据库与 Worker 正常。

## 6. Nginx 与 TLS

先为 `studio.cinlan.online` 获取有效证书，并确认以下文件存在：

```text
/etc/letsencrypt/live/studio.cinlan.online/fullchain.pem
/etc/letsencrypt/live/studio.cinlan.online/privkey.pem
```

再安装仓库配置：

```bash
sudo cp deploy/nginx-studio.cinlan.online.conf /etc/nginx/conf.d/studio.cinlan.online.conf
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 将 80 重定向到 443，并只代理到 `127.0.0.1:3000`。上传上限为 25 MB，长请求读写超时为 300 秒。

`/api/v1/creative/assets/` 响应包含 Owner 私有内容。Nginx 或 CDN 不得启用共享缓存；必须保留 `w` query、`If-None-Match`、`ETag` 和应用返回的 `Cache-Control: private`。

模板的 `cinlan_studio_no_args` access log 不记录 query string，避免 Sub2API Custom Page 传入的 URL token 落入源站日志。若 Nginx 已有全局 access log，还要确认没有第二份包含 `$request` 的站点日志。Cloudflare/CDN 日志也需要对 `token` 参数脱敏。

部署后清理 `studio.cinlan.online` 的 CDN 页面缓存，避免旧的 `frame-ancestors 'self'` 响应继续命中。

## 7. 上线验收

```bash
curl --fail --silent --show-error --head https://studio.cinlan.online/
curl --fail --silent --show-error https://studio.cinlan.online/api/v1/creative/config
sudo systemctl is-active cinlan-studio cinlan-studio-worker
```

检查 iframe 响应头：

```bash
curl -sSI https://studio.cinlan.online/ | grep -iE 'content-security-policy|referrer-policy'
```

期望至少包含：

```text
content-security-policy: frame-ancestors 'self' https://api.cinlan.online
referrer-policy: no-referrer
```

浏览器验收：

1. 使用 Sub2API 账号、2FA 或嵌入 SSO 登录，模型目录成功加载；仅在显式开启时验收手动 API Key。
2. 上传一张参考图后仅创建一条任务，提交完成后输入区参考图被清理。
3. 一条低成本 `1:1` 图片任务进入活动状态，刷新页面后仍可恢复。
4. 任务不长期停在 `CREATED`，Worker 日志持续推进状态。
5. 完成结果只出现一次，可预览并以正确图片扩展名下载。
6. 取消任务到达 `CANCELLED`；失败任务可重试并创建一条新任务。
7. 上游 `Bad Gateway` 或 `No available compatible accounts` 显示为明确失败，不伪装成成功。
8. 从 Sub2API Custom Page 打开 iframe，不再出现“拒绝连接”。
9. 点击“新窗口打开”后自动登录，地址栏不再包含 `token` 和 `user_id`，主题与语言保持一致。
10. 浏览器标签页显示 `/providers/logo.png` favicon。
11. 历史卡片请求 `/api/v1/creative/assets/{id}?w=480` 并返回 WebP；打开详情和下载时仍请求不带 `w` 的原图。
12. 使用卡片响应的 `ETag` 再次请求并携带 `If-None-Match`，应返回 `304`。
13. 同时请求同一资产的相同宽度时，`.thumbnails` 中只产生一个完整 WebP 文件且没有残留 `.tmp`。
14. 文字结果中的 `#`、`##`、列表、表格和代码块按 Markdown 渲染；历史文字详情可滚动，复制结果得到完整原文。
15. 使用 `1600x440`、`1600*440`、`9:16`、`横版`、`竖版` 等提示词时，任务参数和 Provider 请求采用对应尺寸或方向，不回落为固定方图。

## 8. 更新与回退

更新顺序：

1. 备份 PostgreSQL、资产目录和当前代码。
2. 上传并校验新的 Linux 源码包。
3. 在 Linux 执行 `npm ci && npm run test:assets && npm run build`。
4. 执行向前迁移。
5. 同时重启 Web 与 Worker。
6. 重复上线验收。

```bash
sudo systemctl restart cinlan-studio cinlan-studio-worker
```

回退时恢复上一版源码并同时重启两个 service。不要删除 Creative Core 表；如果新迁移无法与旧代码兼容，只能按已验证的 PostgreSQL 与资产目录成对备份恢复。

## 9. 备份

备份方法与恢复约束见 [`../docs/creative-core-postgresql.md`](../docs/creative-core-postgresql.md)。必须成对备份：

- PostgreSQL `cinlan-studio` 数据库。
- `/var/lib/cinlan-studio/assets`；其中 `.thumbnails` 可不备份，但原图目录必须备份。
- 服务器秘密管理系统中的稳定 `CINLAN_SESSION_SECRET`。
