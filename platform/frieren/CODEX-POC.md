# ChatGPT subscription on Cloudflare Workers

An isolated probe using Frieren's installed `@earendil-works/pi-ai` 0.80.10.
It does not change the Frieren app, its accounts, or its production deployment.
The current deployment keeps authentication, context, and tools in the Worker,
and forwards inference through a Node.js Cloudflare Container.

**Result: passed on 2026-09-08.** A real ChatGPT sign-in completed, all three
`gpt-5.4-mini` SSE requests returned HTTP 200, a tool executed in the Worker and
its random result was reproduced exactly, and inference succeeded after refresh.
No Codex app-server or agent runtime runs in the container.

## What it checks

1. Pi's `device_code` OAuth flow runs inside a Worker, without a localhost callback.
2. Codex calls a fixed `read_probe_code` tool. The Worker returns a random UUID,
   and the next model response must reproduce it exactly.
3. Expiring the credential's in-memory timestamp triggers Pi's normal token refresh
   and credential writeback. A third model request must return `REFRESH_OK`.

The probe selects `gpt-5.4-mini` and uses HTTP/SSE. The refresh check forces local
expiry; it does not wait for the access token's natural expiry.

## Run

From `platform/frieren`, generate a private test key:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync("/tmp/codex-poc-secrets.json", JSON.stringify({ POC_KEY: randomBytes(32).toString("hex") }), { mode: 0o600 })'
```

With Docker running, deploy the container proxy and then the test Worker,
providing the same private test key to both:

```sh
pnpm exec wrangler deploy --config wrangler.codex-proxy.jsonc --secrets-file /tmp/codex-poc-secrets.json
pnpm exec wrangler deploy --config wrangler.codex-poc.jsonc --secrets-file /tmp/codex-poc-secrets.json
```

Use `DOCKER_CONTEXT=orbstack` for deployment if that is your running Docker engine.
Set `PROXY_URL` in `wrangler.codex-poc.jsonc` to the deployed proxy's origin.

Open the test Worker's URL with `/#<POC_KEY>` appended. The page removes the
fragment from browser history and sends the key as an Authorization header when
starting the test. Click **Connect ChatGPT and run test**, then open the OpenAI
verification link and enter the code. Device login must be enabled in ChatGPT's
security settings or permitted by the workspace administrator.

For local Workerd testing, add `POC_KEY` to the git-ignored `.dev.vars`, then run:

```sh
pnpm exec wrangler dev --config wrangler.codex-poc.jsonc --port 8799
```

`POST /probe` also returns newline-delimited JSON for a terminal client. Pass
`Authorization: Bearer <POC_KEY>` and keep reading the response while completing
sign-in. Only `{"type":"complete","ok":true}` means all checks passed.
The stream emits a heartbeat every 15 seconds while waiting, so idle client
timeouts do not disconnect device login. The whole probe is limited to 15 minutes.

## Boundaries

- The test uses a new sign-in, never an existing local Codex auth file.
- Tokens stay in a request-local `InMemoryCredentialStore`. They are removed when
  the test ends. Each inference sends its access token through the container's
  request memory. The container does not save tokens. Its Durable Object binding
  manages container lifecycle; no credential persistence, KV, or R2 is configured.
- Logout here removes the local copy; it does not claim to revoke the upstream grant.
- A private bearer key protects the fixed test endpoint. This is a single-tester
  probe, not a multi-user account implementation.
- Raw provider errors and token responses are not returned. Inference reports
  the upstream HTTP status, content type, and challenge indicator. Failures report
  the stage and whether the response was HTML. Worker observability is disabled.
- `registerBunOAuthFlows()` is Pi's existing static-loader hook. Despite its name,
  it only registers bundled OAuth modules; this Worker does not run Bun.
- Passing establishes observed technical compatibility, not a public API support
  contract for the ChatGPT backend or future availability.

## Verification

On 2026-09-08:

- Wrangler dry-run bundle passed (483 KiB uncompressed).
- Repository format, typecheck, and lint checks passed; lint reported two existing
  CSS warnings in `platform/mac/TUTORIAL.html`.
- Vitest: 2,165 passed, 4 skipped.
- Local Workerd returned a real OpenAI device code.
- Deployed `frieren-codex-poc` returned a real OpenAI device code from Cloudflare.
- Browser smoke check: the device code appears, the private URL fragment is
  cleared, and cancellation works.
- User sign-in completed successfully on the deployed Worker. The first inference
  failed; the initial probe did not capture its HTTP response metadata.
- A separate transport probe with a synthetic invalid token returned HTTP 403 and
  an OpenAI HTML block page, both locally and from Cloudflare. This does not alone
  establish what happened to the valid-token request.
- A second real user sign-in completed with safe HTTP diagnostics enabled. The
  first `gpt-5.4-mini` SSE inference request returned HTTP 403 with content type
  `text/html; charset=UTF-8`; Pi reported an HTML error response. There was no
  `cf-mitigated` header in the recorded response.
- Device authentication is confirmed from Cloudflare. Direct subscription
  inference did not work in this deployed POC. Tool execution and refresh remain
  unverified. The header comparison below isolates a cause of the HTML block.

## Diagnosis: Worker request identification triggers an edge block

On 2026-09-08, three sequential requests from the same local Node process posted
the same body and synthetic invalid credential to
`https://chatgpt.com/backend-api/codex/responses`. Only the presence of the
`CF-Worker` header changed:

| Request | Response |
| --- | --- |
| No `CF-Worker` | 401, `application/json` |
| `CF-Worker: frieren-codex-poc.xiaoxing-hu9889.workers.dev` | 403, `text/html; charset=UTF-8` |
| No `CF-Worker`, repeated | 401, `application/json` |

All three responses came through AKL and lacked `cf-mitigated`. No real user
credential was used. The 401 responses are expected for the deliberately invalid
token; they demonstrate reaching authentication rather than successful inference.
Adding the Worker marker alone caused the HTML block, independently of token
validity, request body, Node runtime, or source network.

[Cloudflare documents](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-worker)
that it adds `CF-Worker` to all Worker `fetch()` subrequests. It also exposes
Worker identity to WAF rules through `cf.worker.upstream_zone`; this experiment
does not identify OpenAI's private rule or which field real Worker traffic hits.
Nevertheless, this is a strong explanation for the deployed POC's matching 403.

A [maintainer investigation](https://github.com/ColeMurray/background-agents/issues/1374)
reported the same comparison with a valid credential (200 without the header,
403 with it), plus unsuccessful attempts to remove the runtime-added header.
The affected feature was [reverted](https://github.com/ColeMurray/background-agents/pull/1375).

For Frieren, direct subscription inference using ordinary Worker `fetch()` is
currently blocked in this POC. Another login or changing the model does not
address the identified cause. The container proxy below keeps Frieren as the
agent harness and changes only the inference transport.

## Cloudflare Container proxy

`scripts/codex-proxy/server.ts` runs on Node 24 in a Linux container. It accepts
only `POST /codex/responses` and a small `/health` endpoint. Native Node HTTPS
forwards the request body and selected provider headers to the fixed OpenAI
endpoint, then streams the upstream status, headers, and body back. It has no
Pi dependency, Codex installation, agent loop, or conversation storage.

`worker/codex-proxy.ts` checks the existing private test key and routes requests
to one container instance. `wrangler.codex-proxy.jsonc` caps the deployment at
one `lite` instance, which sleeps after two minutes of inactivity. The image
build context contains only the server and Dockerfile, with no local env files.

The test Worker overrides Pi's model base URL and adds the private proxy key.
OAuth and refresh still contact OpenAI from the Worker. Tool calls and results
are processed in the Worker, with all inference requests going through the
container. This tests HTTP/SSE only, not WebSockets.

The test Worker's `global_fetch_strictly_public` compatibility flag enables
public URL routing to the proxy Worker on the same `workers.dev` zone. Without
it, the deployed Worker-to-Worker call returned 404 even though requests from
local Node reached the proxy. Enabling only this flag changed the same deployed
transport check to the expected JSON 401. Cloudflare documents this requirement
for [Worker-to-Worker fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/).

Before starting device login, the POC sends an intentionally invalid bearer
token through the proxy and requires a JSON 401 from OpenAI. This distinguishes
working transport from an edge block or a routing failure without asking the
user to sign in. It does not treat the invalid-token response as inference success.

[Cloudflare's networking documentation](https://developers.cloudflare.com/containers/guides/outbound-traffic/)
states that container HTTPS traffic is not intercepted by outbound handlers by
default. This deployment uses that default, with no outbound Worker handler.

Deployed on 2026-09-08:

- Proxy: https://frieren-codex-proxy-poc.xiaoxing-hu9889.workers.dev/
- Container health: HTTP 200, Node `v24.20.0`, platform `linux`.
- A synthetic invalid bearer token sent through the deployed Worker and container
  reached OpenAI and returned HTTP 401, `application/json`, with no HTML block.
- The same transport check passed from the deployed test Worker after enabling
  public Worker-to-Worker routing.
- This confirms the container path reaches authentication. It does not by itself
  prove successful subscription inference; the completed test below does.
- Format and all 17 typecheck tasks passed. Lint has the same two pre-existing
  CSS warnings. Final Vitest run: 2,167 passed, 4 skipped. Two intermediate runs
  encountered different filesystem test failures; those tests passed on the
  unchanged main checkout, and the final full worktree run passed without changes
  to filesystem code or test timeouts.
- The deployed browser page shows the container architecture and requires the
  private test key. Browser smoke check reported no console errors or warnings.

Completed authenticated test on 2026-09-08:

| Check | Result |
| --- | --- |
| Device login in the Worker | Passed |
| Model requests `read_probe_code` through the container | HTTP 200, passed |
| Worker returns a new random UUID; model echoes it exactly | HTTP 200, passed |
| Force local credential expiry and run Pi's normal refresh | Passed |
| Model answers `REFRESH_OK` after refresh | HTTP 200, passed |
| Overall event | `{"type":"complete","ok":true}` |

Streaming text deltas were observed for both text responses. Pi reported 106,
168, and 38 tokens respectively (312 total). The forced local expiry verifies
the refresh path without waiting for natural token expiry. Credentials were
discarded when the test finished.

An earlier terminal reader disconnected after five minutes of inactivity during
device login. The Worker now sends 15-second heartbeats, covered by a test that
also checks timer cleanup. The successful run used this keepalive deployment.

This proves the chosen Cloudflare Container transport works for the tested
account and model. It does not establish a public support contract for the
ChatGPT backend or a production multi-user credential design.

Deployed page: https://frieren-codex-poc.xiaoxing-hu9889.workers.dev/
The private test link needs the access-key fragment described above. The key is
not a ChatGPT credential. Results are streamed to the browser or terminal that
started each run; the page does not retain results from earlier terminal runs.

Official references:

- [Codex authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
- [Codex app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
