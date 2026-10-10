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
- In Frieren a browser kernel and a server kernel can act on the same app, and they do not share
  a volume: the browser kernel writes a synced local replica, the server kernel writes the
  authority, and sync merges the two last-writer-wins. Serialization, `serial`, `exclusive`, and
  `ifHash` are all per kernel. None of them orders a write on one replica against a write on the
  other. The framework offers no cross-kernel lock or compare-and-swap today, and this task does
  not add one. Procedures that both kernels may run should therefore be idempotent, write
  distinct files, or accept that a true concurrent edit of one file across kernels resolves
  last-writer-wins. An authority-mediated CAS would be a sync-layer change and belongs in its own
  task if a real case appears.

Additive, volume contract (`capabilities/volume/contract.ts`): within one kernel, the conditional
overwrite that a read-modify-write needs is not reachable from an app today. The underlying
`Volume.writeFile` accepts `ifHash`, and the kernel's own state store uses it against the same
volume, but the app-facing options expose only `exclusive`, `update`, and `parents`. Expose it,
with its scope stated: it guards the row this kernel sees, which covers the GUI and agent racing
on the same kernel, and nothing across replicas.

```ts
writeFile(path, data, opts?: {
	exclusive?: boolean
	update?: boolean
	parents?: boolean
	ifHash?: string | null    // land only while the path still holds this content hash; null = must not exist
})
// `stat(path).contentHash` already returns the value to pass.
```

Host side (`capabilities/volume/host.ts`): `writeFile` creates missing parents unless `update` is
set or `parents` is `false`. A non-null `ifHash` means "the file must still exist", so it is an edit
for that purpose too: no parent creation. Otherwise a conditional write whose parent another writer
has just removed would recreate the directory and then fail with `ESTALE`, mutating the tree on a
write that did not land. The same rule applies one level up: `bind(ctx)` recreates a missing scoped
root (`/notes`, `/data/<appId>`) before every call, so a conditional write must also skip that
step. A non-null `ifHash` disables both the root and the parent creation; the write either lands
on the file as it was, or fails and leaves the tree exactly as it found it.

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
