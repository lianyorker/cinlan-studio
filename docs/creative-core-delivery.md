# Creative Core Delivery Baseline

Last updated: 2026-08-11.

## Decisions

| ID | Decision | Status |
| --- | --- | --- |
| CC-001 | Implement A+ Core with PostgreSQL only. | Approved |
| CC-002 | Store asset metadata in PostgreSQL and image bytes on persistent disk. | Approved |
| CC-003 | Keep `/api/v1/generate/image` as a compatibility facade and use durable jobs when `DATABASE_URL` is configured. | Approved |
| CC-004 | Display bounded activity summaries, never hidden model chain-of-thought. | Approved |
| CC-005 | Keep planner depth, provider quality, and output resolution as separate concepts. | Approved |
| CC-006 | Do not expose unverified capabilities such as masks or 4K output. | Approved |
| CC-007 | Use the authorized PostgreSQL database only for isolated validation; do not retain test rows. | Approved |
| CC-008 | Production target is `studio.cinlan.online` with local PostgreSQL database `cinlan-studio`; credentials remain external configuration. | Approved |
| CC-009 | Build Linux runtime artifacts on Linux; Windows standalone output is validation-only. | Approved |
| CC-010 | Image, text, and video navigation is capability-configured; durable Creative Core jobs remain image-only. | Approved |
| CC-011 | Support Sub2API Custom Page iframe and new-window SSO by validating URL tokens upstream, matching `user_id`, and storing only an encrypted HttpOnly session. | Approved |
| CC-012 | Evaluate `frame-ancestors` at runtime and allow `https://api.cinlan.online`; never bake production embedding policy into a Windows build. | Approved |

## Delivered scope

- Durable text-to-image, image edit, and multi-image edit jobs.
- Structured creative planning with deterministic fallback.
- PostgreSQL owners, encrypted worker credentials, jobs, events, assets, model capabilities, and versions.
- Persistent filesystem storage for reference and result image bytes.
- Recoverable provider submission and polling through a leased worker.
- Reconnectable activity events and server-backed paginated history.
- Capability-driven controls and distinct quality/resolution semantics.
- Cancellation, failed-job retry, soft deletion, idempotent submission, and version lineage.
- Compatibility mapping for existing image, upload, task, and generation APIs.
- Correct content type and filename extension for downloaded assets.
- Owner-scoped WebP thumbnails with bounded widths, disk caching, private validators, and streamed original assets.
- Sub2API iframe/new-window bootstrap, source allowlist, URL token removal, theme/language handoff, and browser favicon.
- Account-backed Studio credential broker with explicit image/text/video group routing, encrypted identity sessions, per-owner/group key reuse, and serialized key rotation.

## Non-goals

- SQLite or a switchable database adapter.
- Organization management, approval workflows, or team RBAC.
- Multi-node asset replication or object storage.
- Raw model chain-of-thought or fabricated reasoning traces.
- Enabling unsupported provider features based only on a model slug.
- Claiming durable Creative Core jobs for text or video generation.

## State machine

```text
CREATED -> ANALYZING -> READY -> QUEUED -> RUNNING -> VALIDATING -> COMPLETED
```

Terminal alternatives: `PARTIAL_SUCCESS`, `FAILED`, `CANCELLED`, `EXPIRED`.

Cancellation:

```text
CREATED|ANALYZING|READY|QUEUED|RUNNING -> CANCEL_REQUESTED -> CANCELLED
```

Every transition writes a persisted event. Legacy task and history facades map internal phases to `PENDING`, `IN_QUEUE`, and `IN_PROGRESS` while preserving terminal outcomes.

## Request contract

| Field | Semantics |
| --- | --- |
| `model` | Provider model slug |
| `prompt` | Original user instruction, maximum 8,000 characters |
| `count` / `n` | Requested output count, capability-gated and capped at 4 |
| `aspect_ratio` / `aspectRatio` | Capability-approved image ratio |
| `quality` | Provider quality setting; never interpreted as resolution |
| `resolution` | Explicit `1K`, `2K`, or `4K` only when verified for the model |
| `analysis_mode` | `standard` or `deep` structured planning |
| `image`, `image[]`, `imageUrl`, `imageUrls` | Ordered reference images or uploaded asset URLs |
| `mask` | Optional mask transport, hidden unless verified |
| `parent_job_id` | Completed source job for version continuation |
| `idempotency_key` | Owner-scoped stable submission key |

GPT Image built-in capabilities currently allow image editing, up to four references, up to four outputs, ratios declared in `lib/model-capabilities.ts`, and provider qualities `low`, `medium`, `high`. Built-ins do not claim explicit `1K`/`2K`/`4K` resolution controls.

## Ownership and secret handling

- Login sessions use a stable upstream user identifier.
- API Key sessions use an HMAC fingerprint; raw keys are never owner IDs.
- Sub2API identity tokens and Studio-managed provider keys are encrypted at rest with `CINLAN_SESSION_SECRET`.
- Studio creates at most one managed key per owner/group and never selects or deletes arbitrary user-managed keys.
- Every job, event, asset, and version access checks `owner_id`.
- Activity events contain bounded message keys and safe summaries, not provider payloads, image bytes, secrets, or hidden reasoning.

## Coverage matrix

| Path | API | PostgreSQL | Worker | UI | Verification status |
| --- | --- | --- | --- | --- | --- |
| Text-to-image | Implemented | Implemented | Implemented | Implemented | Mock smoke and repository coverage passed |
| Single-image edit | Implemented | Implemented | Implemented | Implemented | Multipart browser smoke and asset contract passed |
| Multi-image edit | Implemented | Implemented | Implemented | Implemented | Persistence and capability contract passed; live provider E2E not claimed |
| Mask edit | Capability-gated | Implemented | Implemented | Hidden | Contract/type coverage only |
| Async polling | Implemented | Implemented | Implemented | Implemented | Compatibility and worker paths covered |
| Refresh recovery | Implemented | Implemented | Implemented | Implemented | Lease recovery covered; live browser/provider recovery not claimed |
| Activity events | Implemented | Implemented | Implemented | Implemented | Repository and worker event coverage passed |
| Version continuation | Implemented | Implemented | Implemented | Implemented | PostgreSQL lineage/idempotency passed |
| Cancellation | Implemented | Implemented | Implemented | Implemented | State transition validated |
| Failed-job retry | Implemented | Implemented | Implemented | Implemented | API/UI path implemented; live provider completion not claimed |
| Job deletion | Implemented | Soft delete | N/A | Implemented | Route and repository path present |
| Asset deletion | Implemented | Soft delete | N/A | Indirect | Route present; dedicated automated deletion coverage pending |

## Deployment boundary

- `DATABASE_URL` enables Creative Core.
- `CREATIVE_ASSET_STORAGE_DIR` must be persistent and shared by Web and Worker.
- `CREATIVE_ASSET_STORAGE_DIR/.thumbnails` is a derived cache and must be writable by Web; it can be regenerated from original assets.
- Migrations run explicitly before public traffic is enabled.
- Production uses an independent worker with `CREATIVE_IN_PROCESS_WORKER=false`.
- Missing `DATABASE_URL` leaves the legacy generation path available but reports Creative Core as disabled.
- PostgreSQL and the asset directory are backed up as one logical dataset.

## Verification evidence

The following evidence was recorded on 2026-08-09:

- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run test:smoke`: passed for legacy generation, edit, polling, catalog, browser interaction, async-to-sync provider fallback, fallback idempotency, and reference upload forwarding.
- `npm.cmd run test:postgres`: passed in a random schema of the authorized PostgreSQL database. It covered migration, owner isolation, concurrent idempotency, `FOR UPDATE SKIP LOCKED`, 15-minute leases, recovery, cancellation precedence, asset validation/deduplication, download extension repair, and version lineage, then dropped the schema.
- A Core-enabled Web process and independent Worker reached `CREATED -> ANALYZING -> READY -> QUEUED`, persisted events, retried provider failures, reused idempotency across gateway fallback, and completed `CANCEL_REQUESTED -> CANCELLED`.
- `npm run build`: passed and produced a Next.js standalone tree with `public`, `.next/static`, and `db` copied into the runtime directory.

Live provider completion was not established during the recorded Creative Core validation because upstream image endpoints returned gateway/account-availability failures. No live completed image-edit, multi-image-edit, or refresh-result E2E is claimed by this document. Validation rows and files were removed after the isolated test. Production migration and production cutover are separate operations and are not claimed as completed.

## Release acceptance

Before production cutover, verify all of the following on the Linux host:

1. `npm ci` and `npm run build` pass on Linux.
2. `npm run db:migrate` succeeds against the intended database.
3. Web and Worker start with the same environment file.
4. `GET /api/v1/creative/config` returns `enabled: true`.
5. One low-cost image job completes, survives a browser refresh, downloads with a valid image extension, and appears once in history.
6. Cancel and retry paths reach the expected terminal states.
7. PostgreSQL and the asset directory backup/restore procedure is tested.
