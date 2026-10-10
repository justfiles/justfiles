---
project: packages/app
status: todo
---

# Opt-in serial procedures and documented concurrency

## TL;DR

Reducer messages are serialized per app and committed with a hash check, so the framework owns
their ordering. Procedures run off that queue with a state snapshot, and the framework hands their
ordering to the author, who can only express it with module-level state inside the worker. Add an
opt-in `serial` flag on procedures, and write down that two kernels can drive one app at once.

## Proposed change

Additive, SDK (`app.ts`, `sdk.ts`):

```ts
p.procedure({
	schema,
	run,
	description?,
	audience?,
	serial?: boolean   // default false
})

// ActionMeta — the kernel learns about procedures only through Sandbox.actions(),
// so the flag has to ride here to cross the sandbox boundary.
interface ActionMeta {
	kind: 'handler' | 'procedure'
	audience?: ProcedureAudience
	serial?: true        // procedures only; the agent command ignores it
	...
}
```

Kernel (`kernel.ts`): `proceduresOf(appId)` already reads the action meta once per app; it
records the serial set alongside the procedure set, and `dispatch` routes a serial procedure onto
a second per-app lane. A serial procedure waits for
the previous serial procedure of the same app to settle, never for reducer dispatches or for
non-serial procedures, so it cannot deadlock against its own `app.dispatch` or `app.settled`.

Docs (`docs/app.md`), new short section "Concurrency":

- Reducer messages are serialized per app; a commit that loses a race is reduced again on the new
  state.
- Procedures run concurrently with each other and with dispatches, and `app.state` is a snapshot.
  Mark read-modify-write procedures `serial`, or make them idempotent and use exclusive writes.
- In Frieren a browser kernel and a server kernel can act on the same app. Serialization is per
  kernel. Cross-kernel safety comes from the volume: `exclusive: true` for a create that must not
  replace, and a conditional overwrite for a read-modify-write.

Additive, volume contract (`capabilities/volume/contract.ts`): the conditional overwrite is not
reachable from an app today. The underlying `Volume.writeFile` accepts `ifHash`, and the kernel's
own state store uses it, but the app-facing options expose only `exclusive`, `update`, and
`parents`. Expose it, otherwise the guidance above asks for something authors cannot do:

```ts
writeFile(path, data, opts?: {
	exclusive?: boolean
	update?: boolean
	parents?: boolean
	ifHash?: string | null    // land only while the path still holds this content hash; null = must not exist
})
// `stat(path).contentHash` already returns the value to pass.
```

## Why

- **Ordering belongs next to the operation it protects.** A procedure that appends to a file or
  renames into a free slot is only correct if it is not interleaved with its siblings. The author
  knows that at the definition site; a flag there is the smallest way to say it.
- **The alternative the framework currently leaves open is worse.** Module-level promise chains in
  `app.ts` are invisible to the kernel, cannot be reasoned about from outside, do not survive the
  worker being replaced, and are per-kernel without saying so. A framework that owns the reducer
  queue but not this is only half-owning consistency.
- **Default stays concurrent on purpose.** Making every procedure serial would let one long AI call
  block a cheap read. Opt-in keeps the common case fast and makes the dangerous case explicit.
- **The topology must be stated.** The framework's trust model is that the kernel owns ordering and
  trust. If there are two kernels, authors need to know that before they design a write path.
- **Indicator.** Three apps have independently built their own serialization or request-id
  bookkeeping, and the newest design document states in plain words that the reducer queue does not
  serialize procedures.
