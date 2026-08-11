# Studio Credential Broker Delivery Gate

Last updated: 2026-08-11.

## Requirement Decisions

| ID | Requirement | Final decision | Source | Priority | Explicit non-goals | Open question |
| --- | --- | --- | --- | --- | --- | --- |
| SCB-001 | Users authenticate with their Sub2API account and do not manage provider keys in Studio | Login, 2FA and embedded SSO are the default production entry points; manual API Key login is feature-gated | Yorker | P0 | No Sub2API schema change | None |
| SCB-002 | One generated image must not create another key | Store the full key returned at first creation in Studio PostgreSQL and reuse it by owner and group | Yorker | P0 | No per-request key creation | None |
| SCB-003 | Image, text and video can use different groups | Route by model override, then capability group; reuse one credential when group IDs are equal | Yorker | P0 | No automatic group guessing | None |
| SCB-004 | Navigation follows configured capabilities | Show image/text/video only when its group route is configured and not confirmed deleted | Yorker | P0 | A temporary upstream outage does not hide last configured navigation | None |
| SCB-005 | User-created keys may coexist | Ignore user-managed keys and operate only on the credential ID stored by Studio | Yorker | P0 | No deletion or mutation of arbitrary user keys | None |
| SCB-006 | A user may delete the Studio-managed key | On confirmed credential rejection, serialize one rotation per owner/group and retry once | Yorker | P0 | `No available compatible accounts`, 429 and 5xx do not rotate keys | None |
| SCB-007 | An administrator may delete a configured group | Mark the route unavailable, never fall back to another group, and return `STUDIO_GROUP_NOT_FOUND` | Yorker | P0 | No random or price-changing fallback | None |
| SCB-008 | Async Worker must recover deleted keys | Store encrypted Sub2API identity tokens in Studio PostgreSQL so the Worker can rotate; require reauthentication when unavailable | Yorker | P0 | No plaintext token persistence | None |
| SCB-009 | Sub2API database cannot be changed | All migrations are limited to the `cinlan-studio` PostgreSQL database | Yorker | P0 | No Sub2API table or API contract migration | None |

## Coverage Matrix

| Surface | Login account | Manual API Key | Image | Text | Video | Deleted key | Deleted group | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Login / 2FA / embed | Persist encrypted identity session | Feature-gated legacy path | N/A | N/A | N/A | Reconcile on use | Capability health | API smoke |
| Model catalog | Resolve unique configured groups | Use supplied key | Filter image models | Filter text models | Filter video models | Rotate once on 401/403 | Exclude missing route | API smoke |
| Compatibility generation | Auth only | Existing behavior when enabled | Group credential | Group credential | Group credential | Rotate and retry once | Stable error | API smoke |
| Creative submission | Owner + credential binding | Legacy credential binding | Persist credential ID/group in job parameters | Not currently durable | Not currently durable | N/A | Reject before enqueue | PostgreSQL test |
| Creative Worker | Encrypted identity session available | Legacy key only | Resolve bound credential | Future-compatible | Future-compatible | Rotate/requeue once | Fail without fallback | Worker test |
| Sidebar | Session-aware capabilities | Optional connection UI | Configured route | Configured route | Configured route | Remains visible after rotation | Hidden when confirmed missing | Browser smoke |
| Settings/connect modal | Account is primary | Visible only when enabled | N/A | N/A | N/A | Reauthentication state | Admin-facing configuration error only | Browser smoke |

## Credential States

| State | Entered when | Allowed operation | Next state | Failure compensation | UI/API behavior |
| --- | --- | --- | --- | --- | --- |
| `provisioning` | No owner/group credential exists | Create exactly one Sub2API key under a DB lock | `active` | Retry with stable idempotency key | Request waits/fails normally |
| `active` | Full key is encrypted in Studio DB | Catalog and generation | `invalid`, `orphaned_group`, `revoked` | None | Normal |
| `invalid` | Upstream confirms 401/403/key rejection | Rotate once under lock | `active` | Require reauth when identity token is unavailable | One transparent retry |
| `orphaned_group` | Configured group is confirmed absent | No provider calls | `active` after explicit group reconfiguration | No fallback | `STUDIO_GROUP_NOT_FOUND` |
| `reauth_required` | Access/refresh identity can no longer authorize key creation | No rotation | `active` after login | Preserve jobs and source assets | `CREDENTIAL_REAUTH_REQUIRED` |
| `revoked` | Owner disconnects or credential is administratively retired | No new use | `active` through explicit reprovision | None | Login required |

## Field And Contract Matrix

| Concept | Environment | PostgreSQL | Job parameters | Server API | Client |
| --- | --- | --- | --- | --- | --- |
| Capability group | `SUB2API_STUDIO_{IMAGE,TEXT,VIDEO}_GROUP_ID` | `studio_provider_credentials.group_id` | `provider_group_id` | `features.<mode>` | Sidebar visibility |
| Model override | `SUB2API_STUDIO_MODEL_GROUP_MAP` | Resolved group only | `provider_group_id` | Catalog union | Model selection |
| Credential identity | N/A | `studio_provider_credentials.id` | `provider_credential_id` | Never exposes key | Not exposed |
| Remote key identity | N/A | `remote_key_id` | Not required | Not exposed | Not exposed |
| Encrypted key | N/A | `encrypted_api_key` | Never | Never | Never |
| Identity refresh | Login response | `studio_identity_sessions` encrypted columns | Never | Reauth error only | Login prompt |
| Feature health | Configured group + `/groups/available` | Credential status | Submission snapshot | `features`, `feature_status` | Hide only confirmed missing routes |

## Error Contract

| Code | HTTP | Meaning | Retry |
| --- | --- | --- | --- |
| `STUDIO_FEATURE_NOT_CONFIGURED` | 409 | No group is configured for the requested capability | No |
| `STUDIO_GROUP_NOT_FOUND` | 409 | The configured group was confirmed deleted/unavailable to the user | No, until configuration changes |
| `CREDENTIAL_REAUTH_REQUIRED` | 401 | Studio cannot rotate without a valid Sub2API identity session | After login |
| `STUDIO_CREDENTIAL_UNAVAILABLE` | 503 | Credential storage/provisioning failed | Controlled retry |
| Upstream 401/403 | upstream | Stored key is rejected | Rotate once, then surface |
| `NO_COMPATIBLE_ACCOUNTS` | upstream | Group lacks a compatible provider account | Never rotate |

## Same-Effect Path Enumeration

- Account login: password, 2FA, embedded SSO, token refresh.
- Credential consumers: model catalog, legacy image generation/edit, text generation, video generation, task polling, Creative planner, Creative provider submit/poll.
- Owner creation without provider use: upload, asset import, background-removal quota and background-removal submission.
- Navigation entry paths: desktop sidebar, mobile sidebar, restored tab state, reconnect actions, model error recovery.
- Credential invalidation: user deletes key, disables key, group deletion, access token expiry, refresh token expiry, Studio logout, concurrent requests.

## Implementation Order

1. Add Studio-only PostgreSQL migration and repository functions.
2. Separate account identity sessions from provider credentials.
3. Add deterministic group routing and capability health.
4. Replace direct `session.apiKey` consumers with the broker.
5. Bind durable jobs to a credential/group and add Worker rotation.
6. Gate navigation and manual Key login.
7. Add regression tests, deployment configuration and operational documentation.

## Baseline Evidence

Before this module change, version `0.2.5` passed `npm ci --dry-run`, `npx tsc --noEmit`, background-removal, transparency, asset-thumbnail, browser smoke, production build and standalone smoke. PostgreSQL integration was skipped because `CINLAN_TEST_DATABASE_URL` was not configured. The real Alibaba and Sub2API provider paths were not called during that baseline.

## Delivery Boundary

- Allowed: Cinlan Studio source, Studio PostgreSQL migrations, Studio API/client contracts, tests and deployment docs.
- Forbidden: Sub2API database migrations, arbitrary user-key mutation, secret logging, production deployment, Git push/release.
- Existing uncommitted background-removal and `0.2.5` work must be preserved.

## Production Configuration

```dotenv
SUB2API_STUDIO_IMAGE_GROUP_ID=7
SUB2API_STUDIO_TEXT_GROUP_ID=
SUB2API_STUDIO_VIDEO_GROUP_ID=
SUB2API_STUDIO_MODEL_GROUP_MAP={}
CINLAN_ALLOW_API_KEY_LOGIN=false
CINLAN_STUDIO_INSTALLATION_ID=cinlan-studio-production
```

- Each configured capability group is authoritative. Studio never falls back to another group.
- `SUB2API_STUDIO_GROUP_ID` remains an image-only compatibility alias.
- All Web and Worker instances must share `DATABASE_URL`, `CINLAN_SESSION_SECRET`, and `CINLAN_STUDIO_INSTALLATION_ID`.
- Run `npm run db:migrate` before starting the version containing migration `003_studio_credential_broker.sql`.
- A confirmed deleted group hides only its matching capability. A temporary group-catalog failure returns `degraded: true` and preserves the configured navigation state.
- Managed credentials are encrypted in PostgreSQL and never returned by Studio APIs or rendered in the browser.
