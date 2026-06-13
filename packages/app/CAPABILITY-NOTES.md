# Capability system — state, findings, plan

Branch `app-code`. Working notes on the `packages/app` capability seam.

## DONE (shipped, all green: format/typecheck/lint/test, 661 tests)

### 1. Capabilities accept any function shape (was: 1 input / 1 Promise return)

The seam carries `args: readonly unknown[]` instead of `input: unknown`. Methods can be
any `(...args) => R` — any arity, sync or async. Inferred end-to-end.

- Wire/seam: `CapabilityCall.args`, `CapabilityBridge.args` (`capabilities/types.ts`, `core.ts`).
- Impl types: `MethodArgs = Parameters<F>`, `MethodOutput = Awaited<ReturnType<F>>`,
  `StreamArgs = Parameters<F>` (`app.ts`).
- `ctx` injected FIRST: handlers are `(ctx, ...args)` / streams `(ctx, emit, ...args)`
  (`capabilities/implement.ts`). Was last; moved to first so optional/rest contract
  params (e.g. `mkdir(path, opts?)`) don't collide with the injected `ctx` (a required
  arg can't follow an optional one in a tuple, and at runtime ctx slid into the omitted
  slot). Verified break+fix with the compiler.
- App-side builder uses `.to()` so variadic args stay last:
  `t.cmd('cap','m', a, b).to('edge')`, `sub.capability('cap','m', a).to('edge')`,
  `app.invoke('cap','m', a, b)` (no `.to`). `CommandBuilder`/`SubscriptionBuilder` in `app.ts`.
- Routing: `Command.args`/`Subscription.args`; `kernel.command.ts`, `kernel.subscription.ts`
  (structural sub key includes args), `kernel.ts` invokeCapability + RawAppHandle bridge,
  `sandbox.worker.ts` invoke message → `args`.

Residual structural limit: **args/results must be serializable** (the proxy is a JSON wire).
No functions/callbacks across the seam; that's why streams (`Stream<Event>`) stay separate.

### 2. Volume capability now REUSES the `Volume` interface

`packages/app/capabilities/volume/contract.ts`:
```ts
export type VolumeCapability = Omit<Volume, 'watch' | 'scan'> & {
  scan(input: { path: string; recursive?: boolean }): Promise<VolumeEntry[]>
}
```
- `scan` + `watch` excluded: both are CALLBACK-shaped in `Volume` (`scan(path,visitor)`,
  `watch(path,listener)`) — can't cross the seam. `watch` is the Stream; `scan` re-expressed
  as a one-shot returning the listing.
- Host impls became thin passthroughs `(ctx, ...args) => bind(ctx)[m](...args)`:
  `packages/app/capabilities/volume/host.ts`, `packages/app/dev-server.ts`.
- Behaviour changes: `mkdir` now uses Volume default (`recursive:false`, was `true`) — pass
  `{recursive:true}` explicitly. Surface widened 7→~18 methods (adds stat/xattr/symlink/
  chmod/cp/...) — a real sandbox-scope widening to review later.
- Caveat: `stat`/`lstat`/`utimes` carry `bigint`, reads carry `Uint8Array` — neither survives
  JSON, so volume is a LOCAL-only capability (documented in contract).
- Consumers updated to positional: `app-code` (`volumeApi` narrowed to `VolumeApi` Pick),
  `app-paint`, `app-files`, test-bundle apps, `kernel.test.ts` hostInvoke,
  `capabilities/volume/host.test.ts` (positional `call(method, args[], over?)` helper).

## FINDINGS — can the serializable constraint go away? (research, no code yet)

### Architecture reality
TWO kernels. Browser kernel (`kernel.client.ts`) serves `volume`+`devkit` LOCALLY; proxies
`ai`/`integrations` to the SERVER kernel (`frieren.app.ts`, a Cloudflare DO) over the `_caps`
WebSocket (`proxyCapabilities` ↔ `serveCapabilities`). Server-side caps exist because they
need CREDENTIALS (OAuth/API keys) + provider SDKs (jmap/caldav) that must not be in the browser.

→ **The wire is load-bearing (credential isolation + server-side agent). Cannot delete it.**
But the constraint only bites on PROXIED caps. Local caps already pass callbacks in-process
(volume.watch IS a local callback today). So the unification prize is smaller than it looks.

### Prior art for callbacks-by-reference (CapTP / object-capability RPC)
Mechanism: export/import tables — pass a fn → ship `{stub,id}`; peer's stub call routes back
to the origin's fn. A subscription = "callback called N times", so **invoke+subscribe collapse
into one invoke**. BUT this only unifies the TRANSPORT; the kernel still needs subscription
LIFECYCLE (reconcile/teardown), so the subscription concept doesn't disappear.

- **Cap'n Web** (Cloudflare, MIT, <10kB, browser↔Worker↔Node): fns/objects by reference,
  promise pipelining, WS sessions; serializes bigint/Uint8Array/Date/Error/Blob/streams.
  Most relevant — could REPLACE hand-rolled `proxy.ts`/`serveCapabilities` and also fixes the
  volume bigint/Uint8Array wire caveat. Disposal via `Symbol.dispose`/`using`; **no auto-GC**
  ("exceedingly difficult; we make no attempt"). Forget to dispose → leak.
- **Comlink** (Google, postMessage): `Comlink.proxy(cb)` tunnels callbacks via MessageChannel;
  structured clone (native Uint8Array/bigint). Right tool for sandbox.worker↔main hop.
- **@endo/captp** (Agoric): rigorous CapTP w/ distributed GC. Heavy.
- **tRPC**: COUNTER-school — deliberately does NOT pass fns; subscriptions = async iterators.
  Rationale = exactly the lifetime problem.

### The catch
Hiding plumbing converts the constraint into a **distributed-GC / lifetime obligation**.
Current explicit `subscribe`/`Unsubscribe` is actually a STRENGTH: the subscription reconciler
rebuilds the whole set from persisted state on boot ("recoverable by construction"). A
by-reference callback is an opaque live object — NOT rebuildable after DO hibernate. Also flips
trust direction (server could call back into sandboxed app).

## PLAN / RECOMMENDATION (hybrid, not wholesale)

1. KEEP explicit invoke/subscribe as the kernel contract — reconciler recoverability is worth it.
2. LOCAL hops (sandbox.worker ↔ main): switch transport to Comlink-style structured clone →
   callbacks + Uint8Array/bigint flow free, no JSON framing. Constraint doesn't even apply here.
   Lowest-risk spike; makes volume.watch + Uint8Array ergonomic.
3. CREDENTIALED wire (`_caps`): when server→browser streaming is needed, adopt **Cap'n Web** for
   that socket instead of extending `proxy.ts` by hand. Gets fns-by-ref, pipelining, special-type
   serialization (also unblocks proxying volume). Scope callback-passing; use `using`/`Symbol.dispose`.

Bottom line: constraint CAN vanish at the API surface (Cap'n Web/Comlink prove it) but becomes a
lifetime/GC obligation in reality. Trade = explicit+recoverable vs implicit+leak-prone. Local: yes.
Wire: adopt Cap'n Web but keep callbacks deliberate.

### Suggested next step
Spike #2 (Comlink on the worker transport) — smallest, self-contained, demonstrates callback +
Uint8Array ergonomics without touching the trust boundary.

Sources: blog.cloudflare.com/capnweb-javascript-rpc-library · github.com/cloudflare/capnweb ·
github.com/GoogleChromeLabs/comlink · trpc.io/docs/server/subscriptions
