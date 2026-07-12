# Plan: streamline `SyncLifecycle` + make reset first-class in the `/fs` API

Two intertwined goals, after the EC reset refactor (`abff341`):

1. **Shrink the public sync surface** so "take mine" is a single intent-level call (`takeMine()`),
   hiding the crash-recoverable state machine that already runs internally.
2. **Make reset a first-class `/fs` operation.** Reset is logically part of the remote `/fs`
   capability set (push / pull / sync / **reset**), like `DeleteBucket` sits beside `PutObject` in
   S3. It currently lives out-of-band only for *mechanism* reasons (it needs the host's raw
   transactional store + a DO cache-rebuild, and must skip the push fence) — none of which are
   reasons it should be absent from the *API surface*. We inject the capability instead of dodging.

No behavior change to the crash-safety machine: the `pendingReset` marker + resume classifier stay
byte-for-byte; we relocate *who drives* the happy path (into `synced()`) and *where the reset route
is homed* (into `createFsApi` via an injected capability).

Scope: `packages/fs/{synced,sync-replica}.ts`, `packages/core/src/{fs,fs.client}.ts`,
`apps/frieren/worker/frieren.ts`, `apps/frieren/src/fs.ts`, and tests.

---

## Change A — `SyncReplica`: rename `Handshaker` → `LineagePeer`, add `reset?()`

`handshake` and `reset` are the same concept — **server-lineage coordination** (read the epoch /
mutate the epoch) — both remote-only, both undefined for local/P2P. Group them.

**Before** (`sync-replica.ts:117-133`)
```ts
export interface Handshaker {
	handshake?(): Promise<{ generation?: number; resetId?: string }>
}
export type SyncReplica = ChangeSource & ChangeApplier & BlobStore & Handshaker
```

**After**
```ts
// The wire shape of a lineage-mutation request. Duplicated across the fs↔core
// boundary on purpose (packages/fs must NOT import core); core validates its own
// zod copy on the route. `wipe` stays app-level (factory reset), so it is NOT here.
export type ResetRequest =
	| { mode: 'adopt-mine'; fromGeneration: number; resetId: string }
	| { mode: 'complete'; resetId: string }

/**
 * Server-lineage coordination (`GET /fs` + `POST /fs/reset`). Optional and
 * remote-only: local/P2P replicas omit both (no server lineage to report/mutate).
 */
export interface LineagePeer {
	handshake?(): Promise<{ generation?: number; resetId?: string }>
	reset?(body: ResetRequest): Promise<{ generation?: number }>
}
export type SyncReplica = ChangeSource & ChangeApplier & BlobStore & LineagePeer
```

`reset` returns `{ generation?: number }` — `adopt-mine` returns the new epoch; `complete` returns
nothing. Do NOT rename the `SyncReplica` type or the `remoteReplica` variable — the type is
genuinely two-sided (`localReplica` is also a `SyncReplica`), and "remote" is an accurate role.

There is one clean symmetry that confirms this is the right cut — each host-injected server
capability mirrors one optional `LineagePeer` method:

| Host injects into `createFsApi` | Client sees on `LineagePeer` |
|---|---|
| `lineage?` (read epoch)         | `handshake?`                 |
| `reset?`   (mutate epoch)       | `reset?`                     |

---

## Change B — `SyncLifecycle`: collapse the take-mine cluster into one method

**Before** (`synced.ts:61-86`)
```ts
	generation(): number | undefined
	beginTakeMine(resetId: string, fromGeneration: number): Promise<void>
	adoptTakeMine(toGeneration: number): Promise<void>
	clearPendingReset(): Promise<void>
	pendingReset(): { resetId: string; fromGeneration: number; toGeneration?: number } | undefined
```
**After**
```ts
	generation(): number | undefined   // kept — factory reset's CAS body reads it
	takeMine(): Promise<void>           // one intent-level op; state machine hidden inside
```
12 → 9 members. Removed `beginTakeMine` / `adoptTakeMine` / `clearPendingReset` / `pendingReset`
(the last had zero callers); added `takeMine`.

---

## Change C — `Props`: drop `onResetComplete`

The drain signal moves inside `synced()` (`remoteReplica.reset({mode:'complete'})`), so the prop
and its comment (`synced.ts:43-46`) are removed.

---

## Change D — `synced()` internals

`beginTakeMine`, `clearPendingReset`, `applyTakeMinePrep` become **private helpers** (bodies
unchanged; `beginTakeMine` reads `knownGeneration` instead of taking a param). `adoptTakeMine` (a
pure pass-through) is deleted. New single entry point:

```ts
async function takeMine(): Promise<void> {
	if (knownGeneration === undefined) throw new Error('take mine requires a server generation')
	if (!remoteReplica.reset) throw new Error('take mine requires a client<->server peer')
	const resetId = crypto.randomUUID()
	await beginTakeMine(resetId)                       // persist marker BEFORE the CAS
	let toGeneration: number | undefined
	try {
		;({ generation: toGeneration } = await remoteReplica.reset({
			mode: 'adopt-mine', fromGeneration: knownGeneration, resetId
		}))
	} catch (e) {
		await clearPendingReset()                     // CAS failed/lost — nothing to resume
		throw e
	}
	if (toGeneration === undefined) throw new Error('reset did not return a generation')
	await applyTakeMinePrep(toGeneration)             // adopt locally (re-tag + rewind cursor)
	await flush()                                     // kick the resilient republish
}
```

Drain signal inside `sync()` (`synced.ts:404-409`):
```ts
// Before: await props.onResetComplete?.(knownPending.resetId)
// After:
await remoteReplica.reset?.({ mode: 'complete', resetId: knownPending.resetId })
```
The `lifecycle` object drops the four removed methods, adds `takeMine`. `generation()` stays.

---

## Change E — `createFsApi`: reset becomes a first-class route via an injected capability

The library already takes an injected **read** over the generation (`lineage`). Add the symmetric
injected **write** (`reset`) and expose `POST /reset` as a real, typed route. The library never
touches SQLite — it just calls the injected capability, exactly like `lineage`.

**Injected deps — before** (`fs.ts`, the `opts` param around line 148-155)
```ts
createFsApi(backend, { lineage?: () => Promise<GenerationState | undefined> })
```
**After**
```ts
// Host-owned lineage capability: read the epoch (lineage) + mutate it (reset).
type ResetResult =
	| { ok: true; generation: number }
	| { ok: false; error: 'generation_stale'; generation: number }
createFsApi(backend, {
	lineage?: () => Promise<GenerationState | undefined>
	reset?: (req: ResetRequest) => Promise<ResetResult>   // CAS + truncate + bump (+ host rebuild)
})
```

**Route + fence exemption.** Register `/reset` **before** the `.use('*')` fence so it is exempt —
mirroring what frieren already relies on at the mount level (`frieren.ts:94-98`: "BEFORE the /fs
mount, so it never hits the push-fence"). This is the correct exemption, NOT prefix-scoping: the
mutating routes are scattered across `/blob/*`, `/path/*`, `/inodes/*` **and** root-level POSTs, so
`.use('/path/*')`-style scoping would leak. Keep the blanket fence; put reset ahead of it.

```ts
return new Hono()
	// reset is registered first ⇒ the fence below never wraps it; it self-guards via the
	// injected capability's CAS. Always in the chain (so the RPC client type includes it);
	// returns 501 when the host provides no reset capability.
	.post('/reset', zValidator('json', ResetBody), async (c) => {
		if (!opts?.reset) return c.json({ error: 'reset not supported' }, 501)
		const result = await opts.reset(c.req.valid('json'))
		return result.ok
			? c.json({ generation: result.generation })
			: c.json({ error: result.error, generation: result.generation }, 409)
	})
	.use('*', /* existing push fence, unchanged */)
	.get('/', /* handshake */)
	// ...the rest, unchanged
```

`ResetBody` = zod for `{ mode: 'adopt-mine'|'complete'|'wipe', fromGeneration?, resetId? }`
(core owns this copy; keep `wipe` here since factory reset still uses it).

---

## Change F — `apps/frieren/worker/frieren.ts`: wire `handleReset` as the capability

Drop the bespoke sibling route; pass the capability into `createFsApi`.

**Before** (`frieren.ts:94-98`)
```ts
	.post('/fs/reset', (c) => this.handleReset(c))
	.route('/fs', createFsApi(fs, { lineage: () => readGenerationState(this.db) }))
```
**After**
```ts
	.route('/fs', createFsApi(fs, {
		lineage: () => readGenerationState(this.db),
		reset: (req) => this.handleReset(req),
	}))
```

`handleReset` keeps its guts (`resetVolume` / `clearReset` over `this.db`, plus the
`this.vol = volume(this.fs)` + `this.reset()` cache rebuild, `frieren.ts:108-135`) but changes
shape: it now takes a parsed `ResetRequest` and **returns a `ResetResult`** instead of reading
`c.req.json()` and writing `c.json(...)` — createFsApi owns the HTTP envelope now. Body validation
moves to the route's `zValidator`.

---

## Change G — `remoteSyncReplica`: implement `reset` via the typed route

Because reset is now a `createFsApi` route, the generated `FsClient` includes it — no injected
transport, no raw `fetch`.

```ts
// fs.client.ts, inside remoteSyncReplica(...), next to handshake():
async reset(body) {
	const res = await client.reset.$post({ json: body })
	if (!res.ok) throw new Error(`reset ${body.mode} failed: ${res.status}`)
	return (await res.json()) as { generation?: number }
},
```
`remoteSyncReplica` always implements `reset` (HTTP peers can always attempt it; an unsupporting
host answers 501). `localSyncReplica` leaves it undefined ⇒ `LineagePeer.reset` absent for P2P ⇒
`takeMine()` throws the clean "requires a client<->server peer".

---

## Change H — `apps/frieren/src/fs.ts`: caller collapse

**Before** (`fs.ts:381-403`) — ~20 lines of begin/POST/adopt/flush.
**After**
```ts
export async function resetTakeMine(): Promise<void> {
	const sync = active?.sync
	if (!sync) throw new Error('“take mine” requires a synced profile')
	await sync.takeMine()
}
```
- Delete `postComplete` (`fs.ts:363-366`) — the drain now calls `remoteReplica.reset({complete})`.
- Drop the `onResetComplete` wiring in `startSync` (`fs.ts:174-176`).
- Update the ResetPanel caller to drop the now-unused `getToken` arg on `resetTakeMine`.
- `factoryReset` (`fs.ts:409`) still needs `wipe`. Two options: keep its raw `postReset`, or route
  it through the typed `client.reset.$post({ mode:'wipe', ... })`. Prefer the typed route for
  consistency (removes `postReset` entirely), but it's optional and `generation()` stays either way.

---

## Why this is a no-functional-change refactor (of the sync/reset behavior)

- `pendingReset` shape in `/.state/sync` unchanged: `{ resetId, fromGeneration, toGeneration? }`.
- `reconcileLineage` / `resumeAction` / `applyTakeMinePrep` bodies unchanged.
- Timing preserved: intent persists BEFORE the CAS; `complete` fires at the same drain point.
- Server semantics preserved: the CAS + truncate + bump is the *same* `resetVolume` transaction;
  only its HTTP entry point moves from a DO sibling route into a `createFsApi` route. Fence
  behavior on the ordinary routes is unchanged (reset was already fence-exempt; it stays exempt).

What moves: the happy-path *driver* (the `POST /fs/reset` for adopt-mine/complete now happens
inside `synced()` via `remoteReplica.reset`), and the reset route's *home* (DO sibling →
`createFsApi` route). Same effects, same order, same persisted states.

---

## Verification (unit tests)

**Client / `synced()` state machine — the crash-safety guarantee:**
1. **The three crash-resume tests pass verbatim, unmodified** (`synced.test.ts:557/580/601`). They
   seed `/.state/sync` and boot — they never call the public take-mine methods, only exercise the
   internal reconcile. Green = the state machine is behaviorally identical. (Editing any of them
   means the refactor broke something.)
2. **Happy-path test: driver changes, assertions don't** (`synced.test.ts:506`). Give `fakeServer`
   a client-facing `reset` mirroring the real CAS:
   ```ts
   reset: async (body) => {
   	if (body.mode === 'complete') { server.resetId = undefined; return {} }
   	server.generation = (server.generation ?? 0) + 1   // 1 → 2, matches the assertion
   	server.resetId = body.resetId
   	return { generation: server.generation }
   },
   ```
   Replace `beginTakeMine('reset-1',1)` + `adoptTakeMine(2)` (and the manual `server.generation`/
   `resetId` pokes) with `await vol.takeMine()`; assert drain via `server.resetId` cleared instead
   of the removed prop. Unchanged assertions: both files pushed, `/mine.txt` kept,
   `generation===2`, `pendingReset` cleared.
3. **New guards** replacing the old app-level checks: `takeMine()` rejects on a no-generation peer;
   rolls back (`pendingReset` cleared, local intact) when `reset` throws.

**Server / `createFsApi` — the route relocation:**
4. **`fs.fence.test.ts` must stay green.** It guards that mutating `/path` and `/blob` (and
   `/inodes`) writes are still fenced. Registering `/reset` ahead of the fence must not change any
   of those outcomes — this is the regression guard for the routing change.
5. **New route tests**: `POST /reset` delegates to the injected `reset` capability and returns its
   result (200 with `{generation}` on ok, 409 on `generation_stale`, 501 when no capability given).
   And a fence-exemption test: a `POST /reset` carrying a stale `x-fs-generation` header still
   reaches the capability (is NOT 409'd by the fence) — the capability's own CAS decides.

**Gates** (`CLAUDE.md`): `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`. Typecheck
proves `apps/frieren` compiles against the 9-member interface and that the typed client now carries
`reset`. Baseline: run the full suite green first (~825 tests), then confirm the only *client* test
that changes is the take-mine happy path.

---

## Checklist / order of work

1. `packages/core/src/fs.ts`: add optional `reset` to `createFsApi` opts + `ResetBody` zod +
   `ResetResult` type; register `/reset` **before** the fence.
2. `apps/frieren/worker/frieren.ts`: pass `reset: (req) => this.handleReset(req)`; reshape
   `handleReset` to take a `ResetRequest` and return a `ResetResult`; delete the sibling route.
3. `packages/fs/sync-replica.ts`: `Handshaker` → `LineagePeer` + `ResetRequest` + `reset?()`.
4. `packages/core/src/fs.client.ts`: implement `reset` on `remoteSyncReplica` via `client.reset`.
5. `packages/fs/synced.ts`: privatize helpers, delete `adoptTakeMine`, add `takeMine`, swap the
   drain signal, drop `onResetComplete` from `Props`, update the `lifecycle` object.
6. `apps/frieren/src/fs.ts`: collapse `resetTakeMine`; delete `postComplete`; drop the
   `onResetComplete` wiring; (optional) route `factoryReset`'s `wipe` through the typed client.
7. Tests: `fakeServer.reset`; rewrite the take-mine happy path; add client guards + server route
   tests; confirm `fs.fence.test.ts` unchanged-green.
8. Gates: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.

## Open decisions

- **`Handshaker` rename target**: `LineagePeer` proposed (alt: `ServerLineage` / `LineageCoordinator`).
  Single implementer + one alias, cheap either way.
- **Fold `wipe` through the typed route too?** Change H recommends yes (removes `fs.ts`'s raw
  `postReset`), but it's optional; `generation()` stays regardless (factory reset needs its CAS body).
- **`apps/worker` host**: it mounts `createFsApi` via the P2P/`apiStorage` path and provides no
  `reset` capability → `/reset` answers 501, `LineagePeer.reset` absent → `takeMine()` unavailable
  there. No regression (that path never had generation/reset). Confirm during impl.

## Resolved

- ~~Reset transport: inject client transport vs. typed route.~~ → **First-class `createFsApi` route
  via an injected `reset` capability.** Reset is logically part of `/fs`; the fence conflict and the
  raw-store/DO-rebuild needs are mechanism details handled by (a) registering ahead of the fence and
  (b) injecting the host capability — not reasons to keep it off the API surface.
