# Cinlan Studio

Cinlan Studio is Cinlan's AI creation workspace for image generation, image editing, structured text generation, and durable creative history. Version `0.2.7` uses a same-origin Next.js BFF, PostgreSQL Creative Core, and an independent worker so long-running jobs can survive refreshes and process restarts.

**English** | [简体中文](./README.zh.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Deployment](./deploy/DEPLOY.md)

## Features

- Text-to-image, single-image editing, and multi-image input with up to four references.
- Concurrent multi-output jobs with independent cancellation, retry, refresh recovery, and persisted activity events.
- Capability-driven model, quality, output count, aspect ratio, and creative planning controls.
- Markdown and GFM rendering for text results, including headings, lists, tables, links, and code blocks.
- Scrollable text history with reliable result copying in normal pages and embedded Sub2API pages.
- Paginated creative history that automatically loads additional work as the user scrolls, with deduplication and retry fallback.
- Owner-isolated image assets, streamed originals, cached WebP thumbnails, ETag support, and private browser caching.
- Prompt size parsing for ratios, named orientations, and explicit dimensions such as `1600x440`.
- Sub2API account login, 2FA, embedded SSO, and server-managed per-owner/per-group credentials. Provider keys are never exposed to the browser.
- Capability-based image, text, and video navigation. A missing or deleted group disables only its corresponding capability.

The model catalog is resolved dynamically from the signed-in Sub2API account. `GET /api/v1/models` is authoritative for the active session.

## Architecture

```text
Browser
  -> Cinlan Studio /api/v1/* (Next.js BFF)
       -> PostgreSQL (owners, jobs, events, assets, versions, managed credentials)
       -> CREATIVE_ASSET_STORAGE_DIR (original images and derived thumbnails)

Creative Worker
  -> PostgreSQL lease queue
  -> structured creative planner
  -> Sub2API / provider
```

Account sessions use an AES-256-GCM encrypted HttpOnly cookie. PostgreSQL stores encrypted Sub2API identity tokens and one reusable managed key per owner/group. Raw secrets must not be logged, committed, documented, or packaged.

Creative Core supports PostgreSQL only. Image bytes are stored on the filesystem, while PostgreSQL stores metadata and ownership. WebP previews under `CREATIVE_ASSET_STORAGE_DIR/.thumbnails` are derived cache files and can be regenerated.

## Requirements

- Node.js 22 or 24
- PostgreSQL 14+
- A writable persistent asset directory
- A reachable Sub2API deployment

## Development

```bash
npm ci
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`.

Minimal development configuration:

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

Production must set `CREATIVE_IN_PROCESS_WORKER=false` and run `npm run worker:creative` as a separate service.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Build the Next.js standalone output |
| `npm run start` | Start the regular Next.js production server |
| `npm run db:migrate` | Apply PostgreSQL migrations |
| `npm run worker:creative` | Start the independent Creative Worker |
| `npm run test:markdown` | Verify Markdown/GFM rendering |
| `npm run test:image-size` | Verify explicit dimensions, ratios, and orientation parsing |
| `npm run test:assets` | Verify thumbnail sizing, cache, ETag, streaming, and concurrency |
| `npm run test:smoke` | Run BFF and browser smoke coverage |
| `npm run test:standalone` | Start and probe the standalone build |
| `npm run test:postgres` | Run isolated PostgreSQL integration coverage using `CINLAN_TEST_DATABASE_URL` |
| `npx tsc --noEmit` | Run TypeScript checks |

## API

### Compatibility API

| Action | Endpoint |
| --- | --- |
| Login / 2FA / optional API key | `POST /api/v1/auth/login`, `POST /api/v1/auth/login/2fa`, `POST /api/v1/auth/key` |
| Embedded SSO | `POST /api/v1/auth/embed` |
| Logout | `POST /api/v1/auth/logout` |
| Model catalog | `GET /api/v1/models` |
| Account | `GET /api/v1/me` |
| Generate or edit an image | `POST /api/v1/generate/image` |
| Generate text | `POST /api/v1/generate/text` |
| Generate video | `POST /api/v1/generate/video` |
| Upload a reference | `POST /api/v1/upload` |
| Poll a compatible task | `GET /api/v1/tasks/:id` |
| History | `GET /api/v1/generations` |

### Creative Core API

| Action | Endpoint |
| --- | --- |
| Configuration | `GET /api/v1/creative/config` |
| Create / list jobs | `POST|GET /api/v1/creative/jobs` |
| Read / cancel / retry / delete a job | `GET|PATCH|DELETE /api/v1/creative/jobs/:id` |
| Job activity | `GET /api/v1/creative/jobs/:id/events` |
| Read / delete an asset | `GET|DELETE /api/v1/creative/assets/:id` |

Canonical job flow:

```text
CREATED -> ANALYZING -> READY -> QUEUED -> RUNNING -> VALIDATING -> COMPLETED
```

Terminal alternatives are `PARTIAL_SUCCESS`, `FAILED`, `CANCELLED`, and `EXPIRED`. Cancellation uses the intermediate `CANCEL_REQUESTED` state.

## Production

The production site is [https://studio.cinlan.online](https://studio.cinlan.online). Use the templates and runbook under [`deploy/`](./deploy/).

Do not deploy a Windows-generated standalone directory to Linux. Upload the Linux source package, then run:

```bash
npm ci
npm run db:migrate
npm run build
```

Back up PostgreSQL, `CREATIVE_ASSET_STORAGE_DIR`, and the stable `CINLAN_SESSION_SECRET` as one logical unit.

## Documentation

- [Production deployment](./deploy/DEPLOY.md)
- [BFF and storage architecture](./docs/deployment-bff.md)
- [Creative Core delivery baseline](./docs/creative-core-delivery.md)
- [PostgreSQL operations](./docs/creative-core-postgresql.md)
- [Studio Credential Broker](./docs/studio-credential-broker-delivery.md)

## License

[MIT](./LICENSE)
