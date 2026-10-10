---
project: packages/app
status: todo
---

# Shallow-merge `init` under persisted state

## TL;DR

Persisted state is loaded verbatim and `init` is used only on first run. Every field added after
an app ships is therefore `T | undefined` forever, and every app grows a normaliser or scatters
`?? 0` defaults. Make `init` the defaults layer: hydrate persisted state as `{ ...init, ...saved }`
before it reaches a transition, a procedure, or `subscriptions`.

## Proposed change

One hydrate function, owned by the bundle because only the bundle knows `init`:

```ts
// sdk.ts — inside defineApp
const hydrate = (saved: unknown): State =>
	saved === undefined ? init
	: isPlainObject(init) && isPlainObject(saved) ? { ...init, ...saved } as State
	: saved as State

dispatch(message, ctx)        → next = hydrate(machine.step(hydrate(ctx.state), message).state)
                                 subscriptions = computeSubs(next); return { state: next, ... }
runProcedure(name, params, h) → handle.state = hydrate(h.state)
subscriptions(state)          → computeSubs(hydrate(state))
```

Both ends of a transition are hydrated. Input, so the edge never sees a missing field; output, so a
transition that builds a fresh object and omits an `init` field cannot publish, persist, or feed
the subscription diff with that field absent. The persisted file therefore always carries every
`init` key after its first commit.

Breaking, bundle and sandbox contract (`app.ts`, `kernel.ts`, `sandbox.ts`): the snapshot path
must hydrate too, or a GUI mounted from `kernel.state()` sees the raw saved object until the
first commit.

```ts
// App (bundle surface)
hydrate(saved: unknown): State          // replaces `initialState`; hydrate(undefined) === init

// Sandbox
hydrate?(saved: unknown): Promise<unknown>   // replaces `initialState?()`

// kernel.state(appId)
return sandbox.hydrate(persisted.value)      // was: persisted ?? initialState()
```

`kernel.state()` already made one sandbox call when nothing was persisted; it now makes that call
on every read. `app.update` pushes carry the transition's output, which is hydrated by
construction, so the hot path is unchanged.

The merge is shallow and object-only. Nested shapes and renamed fields remain the app's migration
work. A transition that returns the merged object persists the new defaults on its next commit,
which is the desired outcome.

Docs: replace "init is only the first-run state; it is not merged into old state" with "init is
the schema default; a field present in init and absent from saved state reads as the init value".
Remove the normaliser advice from `docs/app.md` and the authoring skill.

## Why

- **One place for defaults.** A reducer's `init` already states what every field means when
  nothing has happened yet. Making it also the fallback for fields that did not exist when the state
  was saved is the natural reading of a default, and it removes a second mechanism (per-app
  normalisers) that restates the same values.
- **Robustness by construction.** Without the merge, a transition that does `state.count + 1` on a
  field added later yields `NaN` and persists it. The framework can prevent that class of bug for
  every app with one line; relying on every author to remember a guard cannot.
- **Backward compatibility becomes cheap.** Adding a field is the most common evolution of a
  persisted shape. It should cost one line in `init`, not a line in `init` plus a default at every
  read site plus a test for the missing case.
- **The limit is honest.** Shallow merge is what settings systems do and what authors expect; deep
  migrations are rare enough and specific enough to stay in app code.
- **Indicator.** Seven of nine public apps carry defaulting code for this reason, including a
  normaliser in a two-field reducer.
