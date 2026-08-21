---
project: apps/runner, apps/frieren
status: todo
---

# runner: use a Frieren account

## Result

A Frieren user can connect Runner to the same account. Runner can then:

- use the user's Frieren AI budget;
- read and write the user's Frieren volume while online;
- keep the Frieren OAuth tokens out of app code; and
- stop access when the user disconnects Runner or one app.

Frieren stays the owner of the user, AI quota, and volume. Runner is one fixed OAuth client.
Runner must not copy the quota or become a second source of truth for the volume.

Runner has two volume modes:

- A signed-out app keeps the current local IndexedDB volume and current offline behavior.
- A connected app uses the live Frieren volume and needs a network connection.

Runner does not keep a Frieren volume replica in IndexedDB. Frieren holds one volume for each
account. App scopes are views into that one volume, not copies of it. Runner never merges the
local and Frieren volumes or falls back from one to the other without a clear user action.

This task is for the web Runner at `apps/runner`. It does not change the Mac or desktop
clients.

## Current state

Frieren already has most of the resource-server work:

- `apps/frieren/worker/auth.ts` accepts Clerk `session_token` and `oauth_token` values.
- The same file checks the OAuth `clientId` before it returns the trusted user ID.
- `apps/frieren/worker/index.ts` protects `/store/*` and `/api/*`, then routes the request to
  the user's Frieren Durable Object.
- `apps/frieren/worker/quota.ts` meters both the Frieren agent and `/api/ai`. An OAuth request
  to `/api/ai` therefore uses the same user budget.
- Frieren already exposes the Store protocol at `/store/*`. `httpStore()` can use that protocol
  as a live remote Store without `synced()` or a local Store.

Runner has no account boundary now:

- `apps/runner/src/client/main.ts` opens one local IndexedDB Store for the app.
- It gives the app only the `volume` capability.
- It registers a service worker that caches the shell and app release for offline use.
- It imports the publisher's GUI module into the Runner page. The GUI therefore has the same
  origin and JavaScript context as the trusted Runner host.
- `apps/runner/wrangler.jsonc` has R2 but has no database or auth secrets.

The same-origin GUI is the first problem to fix. If auth is added before that fix, an app can
read or alter the host's browser state and call account routes as the user. An `HttpOnly`
cookie does not fix this. Same-origin app code can still send requests that include the cookie.

## Main design

Use Clerk's OAuth Authorization Code flow. Do not add a second Clerk user store to Runner.

The roles are:

```text
Frieren Clerk instance  -> signs in the user and issues OAuth tokens
Frieren Worker          -> owns /store, /api/ai, quota, and each user Durable Object
Runner Worker           -> OAuth client and token-holding backend
Runner host page        -> trusted capability host
App iframe              -> untrusted app GUI; MessagePort is its only host API
```

Use one manually registered, confidential Clerk OAuth application for Runner in each Clerk
environment. Use a production client for `justapps.run` and a development client for local
work. Keep Dynamic Client Registration off.

Set the Clerk issuer per environment. Read the authorization, token, and JWKS endpoints from
the issuer's OAuth server metadata. Do not copy those endpoint URLs into source code.

Request only these Clerk scopes:

- `openid`, to identify the Frieren user;
- `offline_access`, so Runner can refresh an expired access token when the user returns; and
- `profile` only if the Runner account UI shows a name or avatar.

Do not request `email`, metadata, or organization scopes for this work.

Clerk does not yet support custom OAuth scopes. It cannot express `ai` or `volume` in the
Clerk consent screen. Keep Clerk's consent screen on, then show a Runner consent screen that
names the Frieren resources that Runner will use.

Use Clerk's default JWT access tokens. Frieren can verify these tokens without a Clerk network
request for each AI or Store call. Clerk access tokens last one day. Refresh tokens do not
expire, so Runner must protect them as durable credentials.

## Trust boundary

### Isolate the app GUI first

Change the Runner app page to use the same host shape as Frieren:

1. The trusted Runner page loads the release GUI text.
2. It starts that text in an iframe with an opaque origin.
3. Use `sandbox="allow-scripts allow-forms"`. Browsers do not fire submit events without
   `allow-forms`, so client-side form handlers do not run. Keep `form-action 'none'` in the guest CSP
   so the browser cannot send a native form request. Do not add `allow-same-origin`,
   `allow-downloads`, popups, or navigation permissions.
4. Give the iframe one `MessagePort` for the app SDK transport.
5. Give the iframe a guest CSP that can load the app's public, immutable `/v/` release files. Block
   other fetch, XHR, WebSocket, beacon, and subresource requests, plus form submissions, child
   frames, popups, downloads, and top-level navigation. Route approved links and downloads through
   host capabilities.
6. Keep the kernel, remote Store handle, OAuth session, request nonce, and capability handlers in
   the parent.
7. Do not pass a Frieren token, Runner session ID, user ID, request nonce, or Store handle through
   the port.

Reuse the small host pattern in `apps/frieren/src/apps/host.ts`. The reducer already runs in a
Worker and can stay there. Treat the reducer as untrusted too. Set the trusted app page CSP so
the reducer Worker can load its version-pinned code and call only the Runner origin. The Store
and AI proxies still require the secret request nonce, so a reducer cannot call them with its
same-origin cookie alone.

After this change, an app can ask only for capabilities that the trusted parent registered for
its signed release manifest. It cannot read the parent DOM, IndexedDB, or auth state.

### Limit of GUI isolation

The iframe protects host credentials, storage, DOM, kernel handles, and account APIs. It does not
stop all outbound traffic from publisher JavaScript. CSP `connect-src` does not control WebRTC.

Treat all reducer state and capability results sent to the GUI as disclosed to the publisher. Do
not include credentials, handles, unrelated account data, or more user data than the app needs. A
capability grant controls what the host gives the app. It cannot control how publisher code uses
data after it receives it. If a product must prevent disclosure of granted data, use a host-rendered
or declarative UI instead of publisher JavaScript.

Keep each submitted app on its own app subdomain. The iframe limits what app code can do in the
browser. The subdomain limits how a report or block against one app URL can affect other app URLs.
Do not serve submitted app content from a path on the `justapps.run` root host.

The host must also check scopes at each capability call. A normal app can use only the `app`
volume scope. Permit `system` only for the fixed first-party app ID `justfiles.files`, after the
user approves access to the full non-private volume. Reject every absolute volume prefix,
including `/`. Also reject the AI `context:learning` scope. Compare the scopes from the running
reducer with the approved release manifest. A publisher must not gain more access by making
those two copies different.

### Protect account routes

Use host-only cookies for Runner sessions:

- `__Host-runner-root` on `justapps.run`;
- `__Host-runner-app` on one app host, such as `<app>.justapps.run`;
- `Secure`, `HttpOnly`, `Path=/`, and `SameSite=Lax` on both; and
- no `Domain` attribute.

Each app session also gets a random request nonce. The trusted parent sends it in a custom header
on Store and AI calls. Check the nonce, `Origin`, HTTP method, content type, and app ID on the
Worker. The opaque app iframe must not get the nonce. Use the same checks and a form token on
root-host requests that change consent or disconnect an account.

The signed-out app document is public and may come from the service worker. A connected app
document carries the request nonce, so return it with `Cache-Control: no-store` and a private
response marker that the service worker refuses to cache. Put the nonce only on a top-level
document response. Require the browser's document fetch metadata so the same-origin reducer
Worker cannot fetch another copy of the document and read a nonce.

Do not run Clerk on wildcard app hosts. All sign-in and OAuth callback routes belong to the
root host.

## User flow

Use this route flow. Route names can change during the work, but their host and trust rules
must not change.

```text
<app>.justapps.run
  -> https://justapps.run/connect?app=<canonical app id>
  -> Clerk /oauth/authorize
  -> https://justapps.run/auth/callback
  -> Runner resource consent
  -> one-use ticket
  -> https://<app>.justapps.run/_runner/connect/callback?ticket=<ticket>
  -> set the host-only app cookie
  -> redirect to / with no ticket in the URL
```

Detailed flow:

1. The signed-out app starts with its current local IndexedDB volume. The shelf shows
   `Connect Frieren`, but the app remains usable.
2. The link goes to the fixed Runner root. It passes only a canonical app ID. The server finds
   the return origin from that ID. It does not accept an arbitrary return URL.
3. Runner creates an OAuth flow row with a random state, PKCE verifier, OIDC nonce, browser
   binding, app ID, and short expiry. It sets a short `__Host-runner-flow` cookie and sends the
   PKCE challenge to Clerk.
4. Clerk signs in the Frieren user and shows its OAuth consent page.
5. The root callback checks state, the flow cookie, one-use state, and expiry. It exchanges the
   code with the Runner client secret and verifies the ID token issuer, audience, nonce,
   signature, and expiry. The verified `sub` claim is the Frieren user ID.
6. Runner seals the OAuth access and refresh tokens before it writes them to D1. It also creates
   the root session.
7. Runner shows its own resource consent page. It must say that Runner will use the user's AI
   budget and read or change the user's non-private Frieren volume while online. It must also name
   the current app and its declared capabilities.
8. On approval, Runner stores an app grant and creates a random, one-use ticket. Bind the ticket
   to the user, exact app ID, exact app origin, and current capability hash. Expire it after at
   most five minutes.
9. The app-host callback consumes the ticket in one D1 transaction, sets the app cookie, and
   redirects to `/`. A replay must fail.
10. The trusted app host closes the local kernel and app iframe. It then opens the live remote
    Store, creates a new kernel, and registers only the approved capabilities. If the connected
    request is offline, it fails without falling back to the signed-out volume.

Build the capability hash from a stable, sorted form of the release manifest's capability IDs
and scopes. Do not use the whole release hash. Map `volume` to Frieren Store access and map `ai`
to Frieren AI access. A `system` volume grant must use different consent text from an app-volume
grant. Do not approve a Frieren resource that the app did not declare.

If a signed app release asks for more capabilities, its capability hash changes. Stop account
access for that app until the user approves the new set. A release with the same capability set
does not need new consent.

There is one known limit. Clerk cannot put `ai` and `volume` in the access token today. The
Runner token can reach any Frieren route that accepts an allowlisted OAuth client. Runner must
use a fixed upstream path allowlist and expose only its Store and AI proxies. The app grant is
enforced by Runner, not by a Clerk token claim. A later design needs Frieren-issued resource
tokens if this first-party trust is not acceptable.

## Runner server state

Add one D1 database to Runner. Keep the schema small:

- `oauth_flows`: hashed state, PKCE verifier, OIDC nonce, hashed browser binding, app ID, and
  expiry;
- `accounts`: Clerk user ID, sealed access token, sealed refresh token, access-token expiry,
  granted Clerk scopes, token version, and refresh lease expiry;
- `app_grants`: Clerk user ID, app ID, capability hash, approved resources, and revoke time; and
- `sessions`: hashed session or ticket ID, kind, Clerk user ID, app ID, request nonce, and expiry.

Do not store a Clerk profile unless the account UI uses it. Do not store quota or volume data in
D1.

Use 256-bit random session IDs. Store only a hash of each session ID. Seal OAuth tokens with
AES-GCM and a versioned Worker secret. Bind the user ID and token kind as additional data. Keep
the key outside D1.

Use a short D1 row lease to allow one refresh operation per user at a time. Acquire it with one
conditional update. If two requests find an expired access token, only the lease holder can
rotate it. Save a returned refresh token with a token-version check before other requests use it.
If refresh fails with a final OAuth error, delete the account grant and require a new connection.

Give OAuth flows and root sessions a ten-minute and thirty-day fixed life, in that order. Give
app sessions a thirty-day fixed life. Tickets keep the five-minute limit above. Do not add
sliding expiry in the first version.

Add expiry cleanup for OAuth flows, tickets, and sessions. It can run in the existing hourly
scheduled handler.

## Frieren changes

Keep the Frieren change small:

1. Register the Runner production and development OAuth clients in the Clerk dashboard.
2. Add both Runner client IDs to the OAuth client allowlist in
   `apps/frieren/worker/auth.ts`.
3. Rename `DESKTOP_CLIENT_IDS` to a first-party OAuth client name because it will also contain
   Runner clients.
4. Keep `/store` and `/api/ai` on the existing Clerk middleware. Do not add a second token format
   or a Runner-only resource API.
5. Add auth tests that accept a listed Runner client and reject any other OAuth client.

The Clerk client secret belongs only in Runner. Frieren needs the public client IDs for its
allowlist, not the Runner client secret.

## AI capability

Add the existing `ai` capability to the trusted Runner host.

For `generateText`:

1. Check the app session, request nonce, app grant, and current capability hash.
2. Get or refresh the user's sealed OAuth access token on the Runner Worker.
3. Send a server-to-server request to Frieren `/api/ai/v1/chat/completions` with the OAuth token.
4. Map the capability request to the existing OpenAI-shaped request and map the response back to
   the capability result.

The request reaches the same per-user Frieren Durable Object as a Frieren request. The existing
quota meter therefore charges the same AI budget. Runner must not calculate or cache a second
budget.

For the first version, reject `context: learning`. That option reads the user's learning data in
Frieren and needs its own purpose-bound resource path. Do not send a broad volume handle to the
AI gateway to support it.

## Volume modes

### Signed-out local volume

Keep the current Runner storage path for signed-out users:

1. Open `justapps-store:<app-id>` with `idbStore()`.
2. Keep the current one-time migration from `justapps:<app-id>`.
3. Create the kernel and `volumeCapability` host over that local Store.
4. Keep the storage persistence request and service worker so the signed-out app works offline as
   it does today.
5. Do not expose Frieren AI or any Frieren resource in this mode.

The service worker may cache only the public Runner shell and version-pinned app release. It must
never cache `/_runner/*`, auth routes, consent routes, callbacks, a connected app document, or any
response marked private.

### Connected Frieren volume

Use Frieren's existing Store protocol as the live Store after the user connects. Do not call
`synced()` and do not open an account-specific IndexedDB Store.

The trusted Runner parent creates this shape:

```text
volume(httpStore('/_runner/store', { headers: { 'x-runner-request': nonce } }))
```

The exact header name can change. The design must keep these rules:

1. Add a protected Runner proxy at `/_runner/store/*`.
2. The proxy checks the app session, exact `Origin`, request nonce, app ID, app grant, current
   capability hash, HTTP method, and content type.
3. The proxy permits only the routes and methods in the current Store protocol. It rejects any
   other Frieren path.
4. The proxy gets or refreshes the user's sealed OAuth token. It forwards the request to the same
   path under Frieren `/store/*` and adds the OAuth token on the server.
5. The proxy removes Runner cookies and internal headers before the upstream call. It streams
   request and response bodies and sets private responses to `Cache-Control: no-store`.
6. The trusted parent wraps the remote Store with `volume()` and gives it to the existing
   `volumeCapability` host.
7. The default app scope maps to `/data/<app-id>`. The allowlisted Files app can map to the full
   non-private Store only after the user grants `system` access.
8. Keep `/private` out of the remote Store. Frieren's current `/store` route already uses the
   unbound Store and does not expose that mount.

The Store protocol uses guarded commits. Keep that conflict handling. Do not add ETags, a second
revision field, or a new path-based file API for this work.

The low-level Store proxy can reach the full non-private Store. This handle is acceptable only in
the trusted Runner parent. The app iframe must not receive the request nonce, Store calls, node
IDs, blob hashes, or the remote `Volume`. It receives only the chrooted methods from
`volumeCapability`. The strict iframe and guest CSP above are required parts of this design.

Do not use `Volume.watch` over `httpStore()` in the first version. `httpStore()` has no push feed,
so `Volume.watch` would poll `/since` every 50 milliseconds for each active watch. Add a small
Runner host rule that returns `CAPABILITY_UNAVAILABLE` for `volume.watch`. Apps must refresh a
listing when they open it and after their own writes. A reload or an explicit refresh picks up
changes made in Frieren or another Runner session. A later task can add one shared server push
channel if users need live external changes.

In connected mode, every kernel state read and write goes to Frieren through the remote volume.
On the mode change, close the old app iframe and kernel before the new volume opens. Do not keep
one kernel alive while its storage changes under it.

### Existing local data

Do not upload the signed-out IndexedDB volume when the user connects. Close it and leave it
untouched. The connected app can then show different data because it uses the Frieren account
volume.

When the user disconnects, close the remote kernel and Store handle. Reopen the same signed-out
database, create a fresh local kernel, and restart the app iframe. This restores the local data
exactly as the user left it.

A future import feature can copy selected local data into Frieren after clear consent. It is not
part of this task. Never merge the two Stores automatically.

## Disconnect rules

Support two actions:

- `Disconnect this app`: revoke its Runner app grant and app sessions. Close its iframe, kernel,
  and remote Store handle. Reopen its signed-out local volume. Keep the root Runner account and
  other app grants.
- `Disconnect Runner`: delete all Runner sessions, app grants, and sealed OAuth tokens for the
  user. Each open app closes its account kernel and returns to its signed-out local volume when
  its next account-status check confirms the disconnection.

Do not switch to local data for a temporary network error or an expired access token. Show an
offline or reconnect state. Switch modes only after an explicit connect or disconnect action, or
after Runner confirms that the account grant no longer exists.

Deleting the refresh token means Runner cannot get future access tokens. A JWT access token
cannot be revoked through Clerk and can live for up to one day. Runner keeps it only on the
server and deletes its stored copy on disconnect. If instant token revocation becomes a product
need, reassess Clerk opaque tokens and their network cost.

## Work order

Use separate review steps. Do not start OAuth until the GUI isolation test passes.

1. [x] **Isolate the app GUI.** Replace the same-page GUI import with an opaque iframe and
   `MessagePort`. Keep current signed-out volume behavior unchanged.
2. [x] **Add Runner account storage.** Add D1 migrations, token sealing, flow/session helpers, expiry
   cleanup, and Worker secrets.
3. **Add Clerk OAuth.** Add root connect, callback, consent, ticket, app callback, account status,
   and disconnect routes.
4. **Allow Runner in Frieren.** Register the two Clerk OAuth apps and extend the Frieren client ID
   allowlist.
5. **Add the online volume.** Add the Store proxy, create `volume(httpStore(...))` in the trusted
   parent, apply the approved chroot, and reject `volume.watch` in connected mode.
6. **Add AI.** Add the trusted Runner AI proxy and host capability. Confirm that Frieren charges
   the current user quota.
7. **Add volume mode switching.** Keep the current signed-out IndexedDB and service worker path.
   On connect or disconnect, close the old iframe and kernel before the other volume opens. Make
   the service worker bypass every private route.
8. **Add UI and operations.** Add shelf account state, consent text, mode state, offline and
   reconnect errors, secret setup notes, and a rollout switch.

## Main files

Expected Runner work:

- `apps/runner/src/app.tsx`: trusted shell, iframe mount, shelf account controls, and request
  nonce. Keep the current service worker route for signed-out use;
- `apps/runner/src/client/main.ts`: iframe host transport, local and remote volume selection,
  kernel lifecycle, and scoped capabilities. Keep the current IndexedDB migration, persistence,
  and service worker setup for signed-out use;
- new small auth modules under `apps/runner/src/auth/`: OAuth flow, sessions, token seal, and D1
  reads;
- new protected routes under `apps/runner/src/`: root auth routes and the app-host Store and AI
  proxy routes;
- `apps/runner/wrangler.jsonc`: D1 binding, auth vars, secrets, and environment values;
- `apps/runner/package.json`: only the OAuth/JWT dependency that the final design needs; and
- `apps/runner/src/index.test.ts` plus focused auth, proxy, iframe, AI, and remote-volume tests;
- `apps/runner/src/client/sw.js` and `apps/runner/src/client/sw.test.ts`: keep public offline
  caching and prove that private Runner routes are never cached.

Expected Frieren work:

- `apps/frieren/worker/auth.ts`: first-party OAuth client allowlist; and
- `apps/frieren/worker/auth.test.ts`: Runner OAuth allowlist cases.

Keep OAuth code out of the app SDK and `packages/fs`. The Runner host owns auth. Reuse
`httpStore()`, `volume()`, and `volumeCapability()`. Do not add a new filesystem interface.

## Tests

Add focused tests for these cases:

- App GUI runs with an opaque origin and cannot access the parent DOM or storage.
- The only app-to-host API is the expected `MessagePort` protocol.
- OAuth state, PKCE, OIDC nonce, issuer, audience, signature, expiry, and exact callback host are
  checked.
- An OAuth flow, ticket, or session cannot be replayed after use or expiry.
- A ticket for app A cannot create a session on app B.
- Session cookies are host-only and use the required flags.
- Cross-origin, wrong-origin, missing-nonce, and wrong-app proxy calls fail.
- OAuth tokens never appear in HTML, JavaScript state, logs, URLs, IndexedDB, or capability
  messages.
- Token refresh is single-flight and saves a rotated refresh token.
- Frieren accepts only listed Runner client IDs.
- A signed-out app has no AI capability and cannot reach a Frieren proxy.
- AI calls use the Frieren user ID and reduce the existing user quota.
- Store proxy requests fail without the exact app session, origin, nonce, grant, and capability
  hash.
- The app gets only its `/data/<app-id>` volume even though the trusted parent has the remote
  account Store.
- Only `justfiles.files` can use the system volume, and it needs the full-volume grant.
- Remote create, read, change, move, and delete operations are visible in Frieren without a sync
  wait.
- Connected `volume.watch` fails with `CAPABILITY_UNAVAILABLE` and does not start `/since`
  polling. Signed-out local watches keep working.
- A signed-out app keeps using `justapps-store:<app-id>` and works offline with its prior local
  data.
- Connecting closes the local kernel before the remote Store opens. It does not upload, clear, or
  change the local Store.
- Connected mode does not open an account-specific IndexedDB Store.
- Disconnecting closes the remote kernel and returns to the same signed-out local Store.
- The service worker never caches `/_runner/*`, auth, consent, callback, connected app documents,
  or private responses.
- Private Store responses use `Cache-Control: no-store`.
- An offline connected resource call fails and does not fall back to signed-out local data.
- A user switch closes the old iframe and kernel before the new account opens.
- A temporary network or token error does not change the selected volume mode.
- A capability increase requires new consent.

Run the repository checks from the worktree root:

```sh
pnpm run format
pnpm run typecheck
pnpm run lint:fix
pnpm run test
```

Also run a browser smoke test for signed-out local use, signed-out offline use, connect, consent,
AI use, remote volume reads and writes, connected offline failure, disconnect, reconnect, and two
different users.

## Rollout

1. Create separate Clerk OAuth applications for development and production.
2. Set the exact root callback URI for each environment. Do not use wildcard callback URIs.
3. Store the OAuth client secret and token-seal key as Runner Worker secrets.
4. Deploy Frieren's client allowlist before Runner starts an OAuth flow.
5. Deploy Runner auth behind an environment flag. Test with one internal Frieren user.
6. Confirm that connecting leaves existing Runner IndexedDB data unchanged and disconnecting
   restores it.
7. Check token refresh failures, Store and AI proxy failures, file-operation latency, AI quota
   results, and D1 growth.
8. Enable the connect control for all users after the internal flow passes.

The two systems can still deploy on their own. Their stable contract is Clerk OAuth plus the
public Frieren `/store` and `/api/ai` routes. Do not add a Cloudflare service binding between the
deployments.

## Done when

- A signed-out Runner app works as it does today with its local IndexedDB volume and service
  worker.
- A Frieren user can connect at the Runner root with the Clerk consent flow.
- An app needs a separate, clear Runner resource grant.
- The app GUI cannot read account state or call a resource that its capability set does not grant.
- The AI capability spends the same Frieren AI budget as Frieren.
- Runner file operations read and change the one Frieren account volume without a local replica.
- Connecting and disconnecting switch between the separate remote and local volumes without
  merging them.
- Tokens stay on the Runner server and at rest only in sealed form.
- Disconnect stops future Runner access and does not delete Frieren data.
- Signed-out apps work offline. Connected apps report offline resource calls as unavailable and
  never return cached Frieren data.
- Runner and Frieren can deploy independently.

## Not in this task

- Clerk satellite domains or a shared Clerk browser session across all wildcard hosts;
- Dynamic Client Registration or Client ID Metadata Documents;
- custom Clerk scopes before Clerk ships them;
- direct Frieren OAuth tokens in the browser or app iframe;
- access to Frieren `/private` data;
- `context: learning` for Runner AI;
- an IndexedDB replica of a Frieren account volume, a root-domain storage iframe, or any other
  account replica;
- offline access to a connected Frieren volume;
- live `volume.watch` events for changes made in Frieren or another session;
- migration of existing signed-out Runner data into Frieren;
- a new app-scoped Store protocol; or
- changes to Mac or desktop auth.

## Clerk references

- [How Clerk implements OAuth](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth)
- [Use OAuth for scoped access](https://clerk.com/docs/guides/configure/auth-strategies/oauth/scoped-access)
- [Verify OAuth tokens](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens)
- [OAuth token formats](https://clerk.com/docs/guides/configure/auth-strategies/oauth/token-formats)
- [Revoke an OAuth application token](https://clerk.com/docs/reference/backend/oauth-applications/revoke-token)
