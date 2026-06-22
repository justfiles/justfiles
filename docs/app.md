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

Build (`kernelHost`) emits `manifest.json`, `app.js`, `gui.js`, copied public
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

### State persistence & migrations

The **whole** reducer state is JSON-persisted to `/state/<id>.json` on every commit and **rehydrated
verbatim** on boot. `init` is used **only on first run** (when nothing is persisted yet) — it is *not*
merged into already-persisted state. So a field you add to `init` later will be **missing** from states
saved before the change:

```ts
// You shipped v1 with this, the user used the app (state is now persisted):
init: { notes: [{ title: 'hi' }] }
// v2 adds `path`. OLD persisted state still loads WITHOUT it — init is not re-applied:
type Note = { title: string; path?: string } // ← make new fields optional
```

Tolerate old shapes — don't assume new fields exist:

```ts
// Default at the read site:
const path = note.path ?? `/notes/${slugify(note.title)}.txt`

// Or version-tag the state and normalise once, inside the first edge that touches it:
type State = { v: 1 | 2; notes: Note[] }
```

To hard-reset during dev: clear `/state/<id>.json` (uninstalling drops it; **re-installing keeps old
state**). In an app-code draft, the ⟳ Run/Restart button wipes draft state (`devkit.run({ reset: true })`).

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

App cannot invent powers. It **declares** the host services it needs; the kernel resolves trusted scopes
— a sandboxed app cannot grant itself more. A declaration is just `{ id, scopes }` (all the kernel reads).
**Declare every capability you touch**, even under a broad host — it keeps the agent's action surface
honest.

```ts
import { volume } from '@justfiles/app/capabilities/volume'
import { ai } from '@justfiles/app/capabilities/ai'

export const app = defineApp({
	capabilities: {
		volume: volume({ scopes: [] }), // local name 'volume' → the volume capability
		ai: ai({ scopes: [] })
	}
	// ...
})
```

> **In an app-code draft** this subpath does not resolve — declare the factory inline instead (Section 12).

**Key** (`volume`, `ai`) = the app-local name you pass to `t.cmd`, `t.fromResult`, `sub.capability`,
`app.invoke`. **`scopes`** = access level (capability-specific; see volume below).

### Invoke two ways

```ts
// into state (from an edge): kernel runs it, result folds back via t.fromResult (Section 4)
t.cmd('volume', 'writeFile', path, bytes).to('saved')
// to the caller (from a procedure): app.invoke returns the value (Section 7)
const bytes = await app.invoke('volume', 'readFile', path)
```

### volume scopes — the one capability with non-trivial scoping

```ts
volume({ scopes: [] })          // per-app chroot at /data/<id> — ALWAYS available
volume({ scopes: ['app'] })     // identical to [] (any non-special scope → per-app chroot)
volume({ scopes: ['system'] })  // user's ROOT volume — host-ALLOWLISTED apps only
volume({ scopes: ['/photos'] }) // chroot at an absolute prefix (/system[/...] needs 'system')
```

- A **user/third-party app gets `CAPABILITY_UNAVAILABLE` for `['system']`** — only host built-ins (e.g.
  the Files app) are on the allowlist. **Use `scopes: []`** unless you are a built-in.
- Inside a per-app chroot the app sees `/` as its own root: `writeFile('/notes/a.txt', …)` lands at
  `/data/<id>/notes/a.txt`. Just use plain absolute paths.

### Exact volume method signatures

The surface IS the `@justfiles/fs` `Volume` interface (minus the two callback-shaped methods). Every
method is **positional** and **async**; paths are absolute. I/O is **bytes** — encode/decode text
yourself (`TextEncoder`/`TextDecoder`).

```ts
readFile(path): Promise<Uint8Array>                        // throws ENOENT / EISDIR
writeFile(path, data: Uint8Array): Promise<void>           // create+overwrite; AUTO-creates parent dirs
appendFile(path, data: Uint8Array): Promise<void>
exists(path): Promise<boolean>                             // never throws
mkdir(path, opts?: { recursive?: boolean }): Promise<void> // default NON-recursive → EEXIST if exists
readdir(path): Promise<Dirent[]>
rm(path, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
rename(oldPath, newPath): Promise<void>                    // replaces dest atomically
cp(src, dest, opts?: { recursive?: boolean }): Promise<void>
stat(path): Promise<Stat>

// scan is the ONE object-shaped method — it RETURNS a listing (no visitor):
scan(input: { path: string; recursive?: boolean }): Promise<VolumeEntry[]>
//   VolumeEntry = { path: string; type: 'file' | 'dir' }

// watch is a STREAM — declared via subscriptions(), folded with t.fromEvent (Section 6):
watch(input: { path: string }): Stream<{ source?: string }>
```

Because `writeFile` auto-creates parent dirs, you usually **don't need `mkdir`** before a write. The
file-backed Notes recipe (Section 10) shows these calls in context.

### Other capabilities

Unlike `volume`, these take a **single object** argument. The two common ones:

```ts
ai.generateText(input: { system?; prompt; temperature?; maxTokens? }): Promise<{ text: string }>
notify.notify(input: { id; kind: 'info' | 'error' | 'question'; title; body; threadId?; route? }): void
```

`email` (`listUnread`/`readDetail`/`markRead`), `calendar` (`listToday({ timezone })`), `accounts`, and
`devkit` — exact signatures in each `capabilities/<id>/contract.ts`. `ai`/`email`/`calendar`/`accounts`
run server-side (credentialed); `volume`/`notify`/`devkit` run locally; `notify` needs no scope.

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
   not `'gui'` (`kind: 'procedure'`). Each entry is derived from your edge:

```ts
// your edge:  rename: t.on(v.object({ from: v.string(), title: v.string() }), …,
//               { description: 'Rename the open note.', examples: [{ params: { from: '/notes/a.txt', title: 'b' } }] })
// the agent sees:
{ name: 'rename', kind: 'handler',
  description: 'Rename the open note.',
  examples: [{ params: { from: '/notes/a.txt', title: 'b' } }],
  schemaHint: { from: 'string', title: 'string' } } // ← derived from the schema
```

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

**Persist to / read from files** (a file-backed Notes app — scan, read, autosave, rename):
The full file pattern. Declare `volume`; write *into* state via `t.cmd('volume','writeFile',…).to(edge)`
+ a `t.fromResult` edge; read bytes *back to the GUI* via a procedure (`app.invoke('volume','readFile',…)`).
State stays semantic (the list + which note is open); body bytes are re-read on demand. `writeFile`
auto-creates `/notes`, so there's no separate `mkdir`.

```ts
import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume' // declare inline in an app-code draft
import * as v from 'valibot'

const enc = new TextEncoder()
const dec = new TextDecoder()
const NOTES = '/notes'
const titleToPath = (title: string) => `${NOTES}/${title.replace(/[^a-z0-9-]+/gi, '-')}.txt`

type Note = { path: string; title: string }
type State = { notes: Note[]; openPath: string | null; error: string | null }

export const app = defineApp({
	init: { notes: [], openPath: null, error: null } as State,
	capabilities: { volume: volume({ scopes: [] }) }, // per-app private storage at /data/<id>
	update: (t) => ({
		// scan the folder → fold the .txt listing into state
		refresh: t.on(v.object({}), (s) => [s, t.cmd('volume', 'scan', { path: NOTES }).to('listed')], {
			description: 'Rescan the notes folder.'
		}),
		listed: t.fromResult('volume', 'scan', (s, r) => {
			if (!r.ok) return { ...s, error: r.error.message }
			const notes = r.value
				.filter((e) => e.type === 'file' && e.path.endsWith('.txt'))
				.map((e) => ({ path: e.path, title: e.path.slice(NOTES.length + 1, -4) }))
				.sort((a, b) => a.title.localeCompare(b.title))
			return { ...s, notes, error: null }
		}),
		open: t.on(v.object({ path: v.string() }), (s, { path }) => ({ ...s, openPath: path }), {
			description: 'Open a note for editing.'
		}),
		// autosave — GUI dispatches on a debounced pause, not per keystroke; writeFile auto-creates /notes
		save: t.on(
			v.object({ path: v.string(), text: v.string() }),
			(s, { path, text }) => [s, t.cmd('volume', 'writeFile', path, enc.encode(text)).to('saved')],
			{ description: 'Write a note body.', examples: [{ params: { path: '/notes/a.txt', text: 'hi' } }] }
		),
		saved: t.fromResult('volume', 'writeFile', (s, r) =>
			r.ok ? { ...s, error: null } : { ...s, error: r.error.message }
		),
		// rename the file when the title changes (move old → new path)
		rename: t.on(
			v.object({ from: v.string(), title: v.string() }),
			(s, { from, title }) => {
				const to = titleToPath(title)
				const openPath = s.openPath === from ? to : s.openPath
				return [{ ...s, openPath }, t.cmd('volume', 'rename', from, to).to('renamed')]
			},
			{ description: 'Rename a note (the title is its filename).' }
		),
		renamed: t.fromResult('volume', 'rename', (s, r) => (r.ok ? s : { ...s, error: r.error.message }))
	}),
	// read the open note's body back to the GUI on demand — bytes never enter state
	procedures: (p) => ({
		readNote: p.procedure({
			description: 'Read a note body as text.',
			schema: v.object({ path: v.string() }),
			async run({ path }, app) {
				if (!(await app.invoke('volume', 'exists', path))) return { path, text: '' }
				return { path, text: dec.decode(await app.invoke('volume', 'readFile', path)) }
			}
		})
	})
})

export type NotesApp = typeof app
```

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
- Verify before done: when a change is complete, `typecheck` + `compile` (or `run`) the draft and clear
  every error. A final gate — not after every intermediate edit (Section 12).

---

## 12. Building inside app-code (drafts)

There are two ways to author an app, and the import rules differ:

- **In-repo package** (`packages/app-foo/`): a full vite build via `kernelHost` (Section 2). Any package
  in the workspace resolves normally — including every `@justfiles/app/capabilities/<id>` subpath.
- **In an app-code draft** (built through the `app.code` authoring app): the draft compiler (esbuild)
  bundles **only your own sources** — there is no `node_modules`, and arbitrary npm packages are **not
  supported**. The platform SDK (`@justfiles/app` + its capability subpaths, `valibot`) and React are
  **provided by the host at runtime** (externalized, not bundled): an installed app links the host's
  *current* SDK at launch, not a copy frozen at build. This is the environment most agents are editing
  in, and it is **stricter about imports**. Need an arbitrary package? Author an in-repo package with
  `packages/create-app/` instead.

### Project layout (app-code draft)

A draft is a directory in the caller's data volume:

```
/projects/<slug>/
  project.json        # { id, name, app: 'src/app.ts', gui: 'src/gui.tsx', icon?, version?, description? }
  src/
    app.ts            # state machine
    gui.tsx           # React GUI
  icon                # optional image data URL
```

`id` is a reverse-DNS bundle id (e.g. `com.example.notes`). You never declare or import `devkit`
yourself — `app.code` owns it and surfaces it as the **dev tools** below, which you drive while a
project is open.

### Dev tools (the `devkit` surface)

While a draft is open you have these tools. They all act on the **currently open project** and read the
freshest source **off disk**, so `write` your edits first, then call them.

| Tool        | Params                | Returns                      | Use it to…                                                               |
| ----------- | --------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `typecheck` | —                     | `{ diagnostics }`            | **Full TypeScript type-check** — the ONLY tool that catches type errors. |
| `compile`   | —                     | `{ outputs, diagnostics }`   | esbuild bundle — catches syntax errors + unresolved/bad imports.         |
| `run`       | `{ reset?: boolean }` | `{ previewId, diagnostics }` | Compile + mount the live App preview. `reset: true` wipes draft state.   |
| `install`   | —                     | `{ id }`                     | Promote the draft to a real app under `/applications` (rejects a clash). |
| `pack`      | —                     | `{ zip }`                    | Compile fresh + return a downloadable `.zip` of the bundle.              |
| `stop`      | —                     | —                            | Tear down the running preview.                                           |

`typecheck` and `compile` return **structured diagnostics** — each one is LSP-shaped: `{ file, range: {
start, end }, severity: 'error' | 'warning' | 'info', source: 'ts' | 'esbuild' | …, code?, message }`
(`range` line/character are 0-based). "Clean" = no diagnostic with `severity: 'error'`. (`run`'s
`diagnostics` are plain message strings for the build banner.)

> `typecheck` may return `CAPABILITY_UNAVAILABLE` on a host with no type checker (desktop, offline
> browser). When it does, skip it and rely on `compile` + `run` — those always run.

### Verify before you call a change done

**After you finish editing — and only once you believe the change is complete and correct — `typecheck`
then `compile` (or `run`) the draft, fix every error, and re-run until clean.** That clean pass IS the
bar for "done"; never report a change finished without it.

- **Why both:** the draft compiler (esbuild) **strips types without checking them**, so a type error
  builds and runs fine until it explodes at runtime — `typecheck` is the only tool that catches it.
  `compile`/`run` then catch syntax errors and bad imports that types alone won't surface.
- **Not every edit:** these are a **final gate, not a per-keystroke check**. Make the whole change across
  as many `write`s as it takes, *then* verify once. Running them after every intermediate edit is wasted
  work — a half-written change is expected to fail.

### What you can import in a draft

Only these bare specifiers resolve (everything else fails the build):

```ts
import { defineApp } from '@justfiles/app'
import { injectStyle, defineGUI } from '@justfiles/app/browser'
import type { GUIProps, GUIMenu } from '@justfiles/app/react'
import * as v from 'valibot'
import './helpers.ts' // ✅ relative imports within src/ work
// import { volume } from '@justfiles/app/capabilities/volume' // ❌ does NOT resolve in a draft
```

The SDK (`@justfiles/app` + subpaths, `valibot`) and `react` / `react-dom` are **provided by the host**,
not bundled — emit bare specifiers (`from '@justfiles/app'`, `from 'react'`); the host resolves them to
its current shared instance at runtime. Any **other** bare import is an unsupported npm package and fails
the build with a clear message — author an in-repo package with `packages/create-app/` if you need one.

### Declaring capabilities in a draft

Because the capability subpath does not resolve, **declare the factory inline**. The kernel reads only
`{ id, scopes }`, so this is exactly equivalent to the imported factory:

```ts
const volume = (opts: { scopes: string[] }) => ({ id: 'volume' as const, scopes: opts.scopes })
const ai = (opts: { scopes: string[] }) => ({ id: 'ai' as const, scopes: opts.scopes })
// usage is unchanged: capabilities: { volume: volume({ scopes: [] }) }
```

The draft build does not type-check (esbuild strips types), so a loose inline factory still builds and
runs; `t.cmd('volume', 'writeFile', …)` just isn't method-checked. For full typing, author in-repo.

### Capability limits for user apps

A draft installs under the author's own id, **not** the built-in allowlist — so `volume({ scopes:
['system'] })` returns `CAPABILITY_UNAVAILABLE`. Use `scopes: []` (per-app chroot at `/data/<id>`) for
private storage. See Section 5 for the full scope rules.
