---
project: packages/app
status: todo
---

# Retire reducer-emitted commands

## TL;DR

The SDK offers two ways to do async work: a transition may return `[state, t.cmd(...).to(edge)]`
and have the kernel run the effect and route a `Result` back through a `t.fromResult` edge, or a
procedure may `await` the capability and dispatch a `t.commit` edge. Keep procedures, drop
commands. The reducer becomes a total pure function from `(state, message)` to `state`, the
kernel loses its command runtime, coalescing, batch commands, the `__cmd/` message namespace,
and the in-flight accounting that `settled` has to wait on.

## Proposed change

Breaking, SDK (`app.ts`, `sdk.ts`, `machine.ts`):

```ts
// removed
Edges.cmd(capability, method, ...args): CommandBuilder
Edges.fromResult(capability, method, transition): Edge
type Command, CommandBuilder, Result<T>
const CMD_RESULT_PREFIX
DispatchResult.command

// transitions return state only
type Transition<State, Payload> = (state: State, payload: Payload) => State
// machine loses its Effect generic
interface Edge<State, S> { readonly schema?: S; transition: Transition<State, any> }
```

Breaking, kernel (`kernel.ts`, `kernel.command.ts`):

```ts
// removed
kernel.command.ts (commandRuntime, coalescing, batch)
Sandbox.run(...) → { state?, subscriptions?, result }   // no `command`
// settled() waits only for the per-app queue to drain at a seq >= the requested one
```

Migration for every current use (autosave, load-into-state):

```ts
// before
save: t.on(schema, (s, { path, json }) => [
	{ ...s, path },
	t.cmd('volume', 'writeFile', path, enc.encode(json)).to('saved')
]),
saved: t.fromResult('volume', 'writeFile', (s, r) =>
	r.ok ? s : { ...s, error: r.error.message }
)

// after
save: p.procedure({
	schema,
	async run({ path, json }, app) {
		await app.cap.volume.writeFile(path, enc.encode(json))   // throws to the caller on failure
		await app.dispatch({ type: 'saved', params: { path } })
	}
}),
saved: t.commit(v.object({ path: v.string() }), (s, { path }) => ({ ...s, path }))
```

Docs: remove the "Capability result that must update state" row from the model table in
`docs/app.md` and the matching row in the authoring skill. Async work has one home.

## Why

- **One effect model.** A framework that offers two ways to perform the same side effect has to
  explain when to use which, and every author has to make the choice. Procedures already cover the
  whole space: they can call any capability, run any number of steps, commit any number of times,
  and return a value. Commands cover a strict subset.
- **Commands are not durable, so they buy no robustness.** The Elm `Cmd` shape earns its keep when
  effects are replayable or persisted. Here the command runtime is in memory only and a restart
  drops it (the kernel comments say so). An author reading `t.cmd` reasonably assumes the declared
  effect is as durable as the state it rides with. It is not. A procedure makes the same promise
  honestly: it is a call, and if the process dies the call died.
- **Errors reach someone who can act.** A `fromResult` edge can only file an error into state for
  someone to notice later. A procedure throws to the caller that holds the context, which is where
  a retry or a message belongs. This is the shape the notes design arrived at independently.
- **The agent gets return values.** A "load X into state" action is a public tool that returns
  nothing useful and forces the agent to re-read state. The same operation as a procedure returns
  the value directly, which is what a tool should do.
- **The reducer becomes trivially testable.** A transition that returns state, and only state, needs
  no effect interpreter in tests and no `Result` fixtures. Pure functions are the whole point of
  putting the reducer in a worker.
- **Kernel simplicity.** `settled` no longer has to reason about an emit, run, re-enter cascade; the
  hidden `__cmd/` message type disappears from the dispatch path; coalescing, a scheduling policy,
  stops being app vocabulary.
- **Indicator, not proof.** Four of nine public apps use commands, all for autosave or
  load-into-state. The one sophisticated use, a coalesced recursive scan in Files, was replaced by
  its maintainers with a procedure. The newest app's design plans no commands at all.

## History

Both mechanisms arrived in one planned sequence on 2026-06-04 and 2026-06-05, replacing an
earlier surface in which `b.handler` was an async function with `ctx.capabilities` and `b.query`
was an async read that returned a value.

| Date | Commit | What landed |
| --- | --- | --- |
| 2026-06-04 | `34f7dd84` thinking about elm | Design note `docs/app-system-elm-improvements.html` (deleted 2026-06-07). Ordered plan: 1 serialize dispatch, 2 non-null initial model, 3 private messages, 4 model-derived subscriptions, 5 adapter seam, 6 "add managed commands only after the loop is solid", 7 fix `query` semantics. |
| 2026-06-04 | `203998ad` | Step 1: per-app queue, `seq`, `settled`. |
| 2026-06-04 | `a922aee9` Part A | Pure `update` table with `t.on`, `t.fromResult`, `t.cmd`. Commands are born here, as the pure replacement for async handlers. |
| 2026-06-04 | `29a8eebe` Part B | Kernel executes commands off-queue; `settled` grows the in-flight cascade wait. |
| 2026-06-04 | `bf7658c0` Part C | Procedures, "the imperative facade". Descends from `b.query`: `app-finder.readFile` is the proof migration. |
| 2026-06-05 | `a09c0afa` | Legacy surface deleted. Async handlers become `t.on` + `t.cmd` (paint `save`); queries become procedures (paint `loadDraft`, `saveDraft`). |
| 2026-06-05 | `92498349` | `t.commit` added because procedures needed an internal edge to land results. |
| 2026-07-16 | `d0275550` | `.coalesce()` added to commands to fix Files' permanent "Loading…": an in-flight flag in persisted state lied after restart. |
| 2026-07-29 | `9b3f7cb4` | Notes moves `save` from `t.cmd` to a procedure: the failure "arrived somewhere other than the caller that needed it". |
| 2026-08-31 | app-files `0c6dff1` | Files drops its coalesced scan command for a procedure. |

What the record says about motivation:

- **Commands were the Elm move, and the plan deferred them.** The note's step 6 says async handlers
  "can keep working" and commands "become useful once the queue, init, private messages, and
  subscriptions exist". The implementation inverted that order: commands shipped first (Part A/B),
  before subscriptions (Part D) and before the non-null initial model (step 2, never done). The
  original motivation was purity of the reducer so edges are "deterministic and testable with no
  kernel or sandbox", not a need any app had expressed.
- **Procedures were the answer to `query`, not a rival to commands.** Step 7 observed that `query`
  was documented as a pure read but used for writes (paint `saveDraft`, code `install`) and asked
  for a rename to something that "may touch capabilities but does not persist app model". Part C is
  that rename, with `dispatch` and `settled` added to the handle so a procedure can also commit.
  The moment it could commit, it covered everything commands could do.
- **The split was by return value, not by kind of work.** The migration commit sorts operations as
  "returns a value → procedure; mutates state → edge + command". That rule produced paint's
  `save` as a command and `saveDraft` as a procedure, two writes to the same volume through two
  mechanisms, distinguished only by whether the caller wanted a boolean back.
- **Every later change moved work from commands to procedures, never the reverse.** Coalescing was
  added to patch a failure mode commands create (ephemeral truth leaking into durable state), and
  the two apps that hit real failures each concluded the error had to reach the caller.

The two solutions therefore exist because the same day produced a pure replacement for async
handlers and a renamed replacement for queries, and the second turned out to subsume the first.
Retiring commands completes the migration the record was already making.
