---
title: 'Building Apps'
description: Author guide for the @justfiles/app framework — state machine + GUI + agent (TUI) interfaces.
---

# Building Apps

Framework guide for `@justfiles/app`. For agent editing app code. Read once -> map user requirement
to concrete change (edge, procedure, capability, GUI tweak) without reading runtime internals.

**Author-facing API only** (UIKit-style). No kernel/sandbox/RPC. You never call those.

Framework src: `packages/app`. Examples: `packages/app-counter` (minimal), `packages/app-files`,
`packages/app-paint`, `packages/app-crossword`, `packages/app-code` (most complex).

---

## 1. Core idea: one state machine, two interfaces

App = **pure state machine** with **two faces over same state**:

- **GUI** — browser/React view. Human looks, clicks. Renders `state`, dispatches actions.
- **Agent (TUI)** — no pixels. Sees `state` as JSON + list of **actions** (named, described, schema'd).
  Dispatch action = agent's only way to drive app.

Both faces -> **same** state machine via **same** action surface. No second code path. Add action ->
GUI client + agent both get it (subject to `audience`, below). Whole philosophy:

> Write logic once as pure state machine. GUI = one renderer of state; agent = another consumer.
> Neither owns logic — state machine does.

```
        ┌─────────── GUI (React) ───────────┐
        │  renders state, calls actions      │
        ▼                                    │
   ┌─────────────────────────────────────┐  │
   │   STATE MACHINE  (app.ts, pure)      │◀─┘
   │   init + edges + procedures          │
   └─────────────────────────────────────┘  ▲
        ▲                                    │
        │  inspects state, calls actions     │
        └─────────── Agent (TUI) ────────────┘
```

### Requirement -> change

| User wants…                                          | You change…                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| New thing user/agent can *do* that mutates state       | **public edge** `t.on(...)` in `update`                             |
| Multi-step / async / capability-driven op              | **procedure** `p.procedure(...)`                                     |
| React to capability result inside state                | **command** `t.cmd(...).to(edge)` + `t.fromResult` edge             |
| React to external change over time (file/stream)       | **subscription** + `t.fromEvent` edge                              |
| New visual layout / control                            | **GUI** (`gui.tsx`), no logic change                               |
| Use host service (AI, files, email, …)                 | **declare capability** + invoke (`t.cmd` or `app.invoke`)          |
| Thing agent must NOT do                                | procedure `audience: 'gui'`                                          |
| Persist value across reloads                           | **reducer state**                                                    |
| Transient UI state (drag, scroll, typing)              | **GUI-local React state** — NOT reducer                            |

---

## 2. File & bundle layout

App = small package. Only required file: `app.ts`. GUI optional but usual.

```
packages/app-foo/
  src/
    app.ts        # the state machine (REQUIRED). headless, runs sandboxed.
    gui.tsx       # the React GUI (optional). runs in the browser.
    ...helpers.ts # pure helpers, freely split out
  vite.config.ts  # kernelHost({ id, name, app, gui, ... }) — builds the bundle
  package.json
```

- `app.ts` **headless**: no DOM, no React, no `window`. Runs sandboxed. Pure except via declared
  capabilities.
- `gui.tsx` = **browser** side: React + DOM. No business logic — renders state, dispatches actions.
- **`.tsx`/`.jsx` extension = only signal** GUI is React component (default-export component). Plain
  `.ts` GUI must export `gui` via `defineGUI` (imperative DOM).

Build (`kernelHost`) emits `manifest.json`, `app.js`, `gui.js`, importable `bundle.js`, copied public
assets.

### vite.config.ts

```ts
import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	plugins: [
		react(), // only if you have a .tsx GUI
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'app.frieren.foo', // stable, unique bundle id
						name: 'Foo',
						description: 'Does foo.',
						icon: 'icon.svg', // optional, from public/
						app: 'src/app.ts',
						gui: 'src/gui.tsx' // omit for a headless app
					})
				])
	]
}))
```

---

## 3. State machine (`app.ts`)

Start with `defineApp`. Validators = [Standard Schema](https://standardschema.dev) compatible.
Examples use [`valibot`](https://valibot.dev) (`import * as v from 'valibot'`).

```ts
import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },          // the bootstrap state
	capabilities: { /* ... */ }, // host services (Section 5), optional
	update: (t) => ({ /* ... */ }),        // the edge table (Section 4)
	subscriptions: (state, sub) => [ ... ], // live streams (Section 6), optional
	procedures: (p) => ({ /* ... */ })      // imperative facade (Section 7), optional
})

// ALWAYS export the type — the GUI and clients infer everything from it.
export type FooApp = typeof app
```

### State discipline (where apps go wrong)

Reducer state = **semantic, persistable, agent-inspectable**. Decide where value lives:

- **reducer state** if agent needs to read it, or user expects it to survive reload (document,
  selection, mode, saved status).
- **GUI-local React state** if transient interaction: drag positions, scroll offset, in-progress text,
  hover, undo history, preview re-read from disk.

**Granularity: one dispatch per *semantic* event** (pointer-up, form submit, save) — never per keystroke
or pointer-move. Every dispatch round-trips to kernel.

Keep state minimal. Durable fact usually = "what is user looking at", not the bytes (re-read those on
demand via procedure). See `app-files`.

---

## 4. Edges — `update: (t) => ({ ... })`

`update` table **IS the whole state machine**. Each entry = edge keyed by action name. Transition =
**pure + synchronous**:

```ts
(state, payload) => nextState
// or, to also fire a side effect:
(state, payload) => [nextState, command]
```

No `async`, no `await`, no `ctx`, no capability calls in transition. Effects returned as **data**
(`Command`); kernel runs them. Invalid action -> `throw` (surfaces as app error).

Four edge constructors on `t`:

### `t.on(schema, transition, meta?)` — the PUBLIC action

External API. **Validated**, **on typed GUI client**, **visible to agent**. Default reach-for.

```ts
increment: t.on(
	v.object({ amount: v.number() }),
	(state, { amount }) => ({ ...state, count: state.count + amount }),
	{ description: 'Increase the counter.', examples: [{ params: { amount: 1 } }] }
)
```

- `schema` validates `params` before transition (+ types it for callers).
- `meta.description`/`meta.examples` = **agent's docs** for this action. Write well — Section 8. GUI
  ignores.

### `t.cmd(capability, method, ...args).to('edgeName')` — fire side effect

Returned as 2nd element of transition. Describes capability call as data; kernel runs it, routes result
to named `t.fromResult` edge. Use when edge needs host (write file) but transition stays pure.

```ts
save: t.on(
	v.object({ pngBase64: v.string() }),
	(state, { pngBase64 }) => [
		{ ...state, lastSavedPath: path, lastError: null }, // optimistic state
		t.cmd('volume', 'writeFile', path, bytes).to('saved') // effect → 'saved' edge
	]
),
```

### `t.fromResult(capability, method, transition)` — receive command result

Internal edge (not on client, not agent-visible). Payload = `Result<T>`:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
```

```ts
saved: t.fromResult('volume', 'writeFile', (state, r) =>
	r.ok ? state : { ...state, lastError: r.error.message }
)
```

### `t.fromEvent(capability, method, transition)` — receive stream event

Internal edge fed by **subscription** (Section 6). Payload = stream's event type.

```ts
fileChanged: t.fromEvent('volume', 'watch', (state) => ({ ...state, revision: state.revision + 1 }))
```

### `t.commit(schema, transition)` — internal commit edge

Validated like `t.on`, but **off** agent surface + typed client. Only app's own procedures dispatch by
name (`app.dispatch`). Use when procedure computes result off to side -> commit atomically in one pure
transition (built puzzle, recorded build outcome). Keeps multi-step async out of pure core, lands result
through pure edge.

```ts
opened: t.commit(openedSchema, (state, snapshot) => ({ ...state, ...snapshot }))
```

### Edge visibility cheat-sheet

| Constructor      | Validated | On typed GUI client | Agent-visible | Dispatched by                       |
| ---------------- | --------- | ------------------- | ------------- | ----------------------------------- |
| `t.on`           | ✅        | ✅                  | ✅            | GUI, agent                          |
| `t.commit`       | ✅        | ❌                  | ❌            | the app's own procedures, by name   |
| `t.fromResult`   | —         | ❌                  | ❌            | the kernel (a `t.cmd` result)       |
| `t.fromEvent`    | —         | ❌                  | ❌            | the kernel (a subscription event)   |

---

## 5. Capabilities — host services

App cannot invent powers. Declares host services it needs (like iOS frameworks). Kernel resolves
trusted scopes — sandbox cannot grant itself more.

**Declare every capability you touch.** Even if host grants broad access, declaring keeps agent action
surface honest + surfaces escapes under tighter hosts.

```ts
import { volume } from '@justfiles/app/capabilities/volume'
import { ai } from '@justfiles/app/capabilities/ai'

export const app = defineApp({
	capabilities: {
		volume: volume({ scopes: [] }), // local name 'volume' → the volume capability
		ai: ai({ scopes: [] })
	},
	// ...
})
```

**Key** (`volume`, `ai`) = app-local name passed to `t.cmd`, `t.fromResult`, `sub.capability`,
`app.invoke`. `scopes` = access level (capability-specific).

Invoke two ways:

- **Into state** — from edge via `t.cmd(...).to(resultEdge)` (result folds back through `fromResult`).
- **To caller** — from procedure via `await app.invoke(...)` (Section 7) (returns value).

### Available capabilities

Import from `@justfiles/app/capabilities/<id>`. Contract files = exact method signatures.

| Capability  | Import subpath                        | What it does                                                                 |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `volume`    | `.../capabilities/volume`             | Scoped filesystem: `readFile`, `writeFile`, `mkdir`, `rm`, `rename`, `exists`, `scan({path, recursive})`, `watch` (stream). Scopes: `'app'` (default per-app chroot), `'system'` (user root), or a path prefix. |
| `ai`        | `.../capabilities/ai`                 | `generateText({ system?, prompt, temperature?, maxTokens? }) → { text }`.    |
| `email`     | `.../capabilities/email`              | `listUnread`, `readDetail`, `markRead`.                                      |
| `calendar`  | `.../capabilities/calendar`           | `listToday({ timezone }) → CalendarEvent[]`.                                 |
| `notify`    | `.../capabilities/notify`             | `notify(input)` — emit a host notification (no scope needed).               |
| `accounts`  | `.../capabilities/accounts`           | Connected-account info (providers backing ai/email/calendar).               |
| `devkit`    | `.../capabilities/devkit`             | Build/run/install app bundles. Used by `app-code`; you rarely need it.       |

Method args carrying binary (`Uint8Array`) or `bigint` (e.g. `volume`) -> capability binds locally.
Transparent to you, just call normally.

---

## 6. Subscriptions — react to world over time

`subscriptions(state, sub)` = **pure function of state** returning live streams current state wants
open. Kernel diffs set on every commit: starts new, stops gone, routes each event to named
`t.fromEvent` edge. **Recoverable by construction** — rebuilt from persisted state on boot.

Use for: watching file user views, any long-lived host stream.

```ts
subscriptions: (state, sub) =>
	state.currentViewing
		? [sub.capability('volume', 'watch', { path: state.currentViewing }).to('fileChanged')]
		: [],
update: (t) => ({
	fileChanged: t.fromEvent('volume', 'watch', (state) => ({ ...state, revision: state.revision + 1 }))
})
```

`sub.capability(cap, method, ...args).to(edge)` mirrors `t.cmd`. Stream stays open while state keeps
declaring it; clear condition -> kernel tears down. Keep streamed *bytes* out of state — fold in small
signal (`revision` bump), re-read on demand in GUI.

---

## 7. Procedures — imperative facade

Edge = pure + synchronous. Need **async, multi-step, or capability-returning** logic (generate text then
build puzzle, read file + return contents, save draft) -> **procedure**. One definition serves **both**
GUI client + agent.

```ts
procedures: (p) => ({
	start: p.procedure({
		description: 'Generate and start a new crossword for a theme.',
		audience: 'both',            // 'gui' | 'agent' | 'both' (default 'both')
		schema: v.object({ theme: v.string() }),
		async run({ theme }, app) {
			const { text } = await app.invoke('ai', 'generateText', { prompt: `...${theme}` })
			const built = buildPuzzle(/* ... */)
			const { seq } = await app.dispatch({ type: 'play', params: built }) // a t.commit edge
			return app.settled(seq)  // wait for quiescence, return the settled state
		}
	})
})
```

`run(params, app)` gets validated `params` + **`AppHandle`**:

| `app` member                         | Use                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `app.state`                          | current state (read).                                                    |
| `app.invoke(cap, method, ...args)`   | call a capability and get the **value back** (scope-checked).           |
| `app.dispatch(message) → { seq }`    | dispatch an edge by name (usually a `t.commit` edge). Returns a seq.    |
| `app.settled(seq, opts?) → State`    | await until the app is quiescent; resolve with the settled state.       |

**Pattern:** messy async in procedure, compute final result, then `dispatch` single `t.commit` edge to
land atomically -> failure never leaves half-built state. Return `app.settled(seq)` -> caller gets
resulting state.

**`audience`** = line between two interfaces:

- `'both'` (default) — GUI + agent both get it.
- `'gui'` — hidden from agent. For destructive/context-dependent actions agent must not call blindly
  (e.g. `remove({ slug })` in `app-code` — slug param would let agent delete *any* project).
- `'agent'` — offered to agent, not GUI client.

Caller-scoped read (return bytes to GUI, never into state) = classic procedure — see `app-files`
`readFile`, `app-paint` `loadDraft`/`saveDraft`.

---

## 8. Agent (TUI) interface — design deliberately

Agent never sees GUI. Entire view of app:

1. **`state`** — reducer state as JSON. (Keep state semantic, legible.)
2. **Action surface** — every public `t.on` edge (`kind: 'handler'`) + every procedure with `audience`
   not `'gui'` (`kind: 'procedure'`). Each carries `description`, `examples`, `schemaHint` derived from
   schema.

Agent dispatches with `actor: 'agent'`. State-changing agent dispatch resolves with settled state ->
agent sees result.

**So: `description` + `examples` ARE agent's UI.** Treat like button labels + tooltips. Adding/editing
action -> write one-line imperative `description` (what it does + precondition) + realistic `examples`.
Crossword edges model this — e.g. `'Submit themed seed words. Triggers grid generation and returns slots needing answers.'`

Checklist for new public action agent should use:

- [ ] Clear `description` (what + when valid).
- [ ] At least one `examples: [{ params: { ... } }]`.
- [ ] Tight schema (agent fills from hint — make invalid input impossible).
- [ ] Human-only? -> `t.commit` edge or `audience: 'gui'` procedure instead.

---

## 9. GUI (`gui.tsx`)

GUI **renders state + dispatches actions** — nothing else. No business logic.

### React component (usual case)

Default-export component. `kernelHost` wraps it, injects typed props.

```tsx
import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'

export default function Foo({ state, actions }: GUIProps<typeof app>) {
	return (
		<button type="button" onClick={() => void actions.increment({ amount: 1 })}>
			count: {state.count}
		</button>
	)
}
```

- `state` = current app state (non-null in React component — host resolves `init` first).
- `actions` = **typed client** (`Client<typeof app>`): one async method per public `t.on` edge (resolves
  with new state) + one per procedure (resolves with return value). `t.commit`/`t.fromResult`/`t.fromEvent`
  edges **not** on it — internal.
- Fire-and-forget with `void actions.foo({...})`. State flows back via re-render; rarely read action's
  return value.

Optional menubar — named export:

```tsx
import type { GUIMenu } from '@justfiles/app/react'
export const menu: GUIMenu<typeof app> = (state, actions) => [
	{ title: 'File', items: [{ title: 'Save', onSelect: () => void actions.save({}) }] }
]
```

### App-scoped CSS

Inject layout CSS once, scoped under root class. Platform look/colors from host design tokens
(`var(--surface)`, `var(--text)`, `var(--rule)`, `var(--focus)`, …) — use those, don't hardcode.

```ts
import { injectStyle } from '@justfiles/app/browser'
injectStyle(`.foo { display: flex; height: 100%; }`, 'app-foo')
```

### Imperative / non-React GUI

Plain `gui.ts` exporting `gui` via `defineGUI`. Here `state` **nullable** (host may mount before first
state push — own bootstrap default). See `app-counter`/`app-doom`.

```ts
import { defineGUI } from '@justfiles/app/browser'
import type { FooApp } from './app'

export const gui = defineGUI<FooApp>({
	mount(el, state, ctx) {
		const render = (s: FooState | null) => { /* paint el from s ?? default */ }
		render(state)
		return { update: render, unmount: () => el.replaceChildren() }
	}
})
```

### React runtime rule

`react`, `react-dom`, JSX runtimes = **shared** by host. Emit bare `from "react"` imports; never bundle
own React or add another React-based stdlib without host coordination — duplicate React breaks
hooks/context.

---

## 10. End-to-end recipes

**Add simple state mutation** ("let users rename the document"):
Add `t.on` edge: schema, pure transition, description + example. Done — GUI + agent both have it. Add
GUI control calling `actions.rename({...})`.

**Add async / AI / multi-step action** ("generate a summary"):
Add `p.procedure`. In `run`: `app.invoke('ai', 'generateText', ...)`, compute result, then `app.dispatch`
a `t.commit` edge to land. Return `app.settled(seq)`. Declare `ai` capability.

**Persist to / read from files** ("save the drawing"):
Declare `volume`. Write *into* state flow: `t.cmd('volume','writeFile',...).to('saved')` + `t.fromResult`
edge. Read bytes *back to GUI*: procedure with `app.invoke('volume','readFile',...)`.

**React to external file changes** ("reload when file changes on disk"):
Declare `volume`. Add `subscriptions(state)` returning `sub.capability('volume','watch',{path}).to('changed')`
while path open + `t.fromEvent` edge bumping `revision`. Re-read in GUI on `revision`.

**Hide action from agent** ("delete project"):
Procedure with `audience: 'gui'` (or `t.commit` edge dispatched only by GUI's own procedure). Pass
identifying params from GUI, don't expose on agent surface.

**Pure GUI/layout change**: edit `gui.tsx` only. No `app.ts` change. Don't move transient interaction
state into reducer.

---

## 11. Quick reference

```ts
defineApp({
	init,                                  // bootstrap state
	capabilities: { name: cap({ scopes }) },
	update: (t) => ({
		name: t.on(schema, (s, p) => s | [s, cmd], { description, examples }), // public action
		name: t.commit(schema, (s, p) => s | [s, cmd]),                        // internal, app-dispatched
		name: t.fromResult(cap, method, (s, result) => s),                     // command result
		name: t.fromEvent(cap, method, (s, event) => s)                        // subscription event
		// inside a transition: t.cmd(cap, method, ...args).to('resultEdge')
	}),
	subscriptions: (state, sub) => [ sub.capability(cap, method, ...args).to('eventEdge') ],
	procedures: (p) => ({
		name: p.procedure({ audience, description, schema, run: async (params, app) => result })
		// app.state | app.invoke(cap, m, ...args) | app.dispatch(msg) → {seq} | app.settled(seq)
	})
})
export type FooApp = typeof app
```

GUI (`gui.tsx`): `export default ({ state, actions }: GUIProps<typeof app>) => ReactNode`,
optional `export const menu: GUIMenu<typeof app>`, `injectStyle(css, key)`.

### Hard rules

- `app.ts` pure & headless. No DOM/React/`window`. No `async`/capability calls **in edges** — only in
  procedures.
- Edges return `state` or `[state, command]`. Side effects = data (`t.cmd`), run by kernel.
- Declare every capability you use.
- Reducer state = semantic & persistable. Transient UI state stays in GUI.
- One dispatch per semantic event, not per keystroke.
- `description` + `examples` on every public action — they are agent's interface.
- Always `export type XxxApp = typeof app`; GUI + clients infer from it.
