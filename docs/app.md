---
title: 'Building Apps'
description: App-code author guide for the @justfiles/app SDK — state machine + GUI + agent-facing actions.
---

# Building Apps

This guide is for a coding agent helping a user build an app in **app-code**. Stay on the
app-authoring API seam. Do not depend on host/runtime internals; those are not part of the app
contract.

The core rule:

> An app is one state machine, rendered by a GUI for the human and exposed as actions for the agent.

## 1. What app-code can and cannot do

An app-code project is not a Node package. It has no `package.json`, no `node_modules`, and no
arbitrary npm install step.

Typical project shape:

```txt
/projects/<slug>/
	project.json        # id, name, app, gui, icon?, version?, description?
	src/
		app.ts           # required: headless state machine
		gui.tsx          # optional but usual: React GUI
		gui.css          # optional: app-scoped CSS imported by gui.tsx
		helpers.ts       # optional: relative helper modules
	icon                # optional image data URL, referenced by project.json
```

Allowed imports in app-code:

```ts
import { defineApp } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import type { GUIProps } from '@justfiles/app/react'
import { volume } from '@justfiles/app/capabilities/volume'
import { ai } from '@justfiles/app/capabilities/ai'
import { notify } from '@justfiles/app/capabilities/notify'
import { email } from '@justfiles/app/capabilities/email'
import { calendar } from '@justfiles/app/capabilities/calendar'
import { accountsAdmin } from '@justfiles/app/capabilities/accounts'
import { devkit } from '@justfiles/app/capabilities/devkit'
import * as v from 'valibot'
import { useState } from 'react'
import './gui.css'
import './helpers.ts'
```

`react`, `react-dom/client`, and React JSX runtime imports are host-shared for GUI code. Most apps only
need `react` plus `GUIProps`. Relative TS/TSX/JS helpers and CSS files are fine. Do not import images,
fonts, WASM, or other binary assets from source files; the project icon is the special supported asset.
Use data URLs or app/private volume data when you need user-provided media.

Do **not** add third-party dependencies such as `lodash`, `zod`, charting libraries, date libraries, or
CSS frameworks. If the user asks for one:

1. implement the small needed helper directly, or
2. use an existing platform capability, or
3. explain that a full in-repo `packages/app-*` project is required for arbitrary workspace/npm deps.

Also avoid Node-only APIs (`fs`, `path`, `process`, `Buffer`) in app-code. `app.ts` is headless; `gui.tsx`
is browser code.

## 2. The mental model: one state, two interfaces

Both the GUI and the agent drive the same state machine.

```txt
		Human GUI
		renders state, calls actions
			│
			▼
	┌───────────────────────────┐
	│ src/app.ts state machine  │
	│ init + update + procs     │
	└───────────────────────────┘
			▲
			│
		Agent
		reads JSON state + action descriptions
```

The agent does not see pixels. It sees:

- reducer state as JSON;
- public `t.on(...)` actions;
- procedures whose `audience` is not `'gui'`.

So state must be semantic and legible. Action descriptions and examples are the agent's UI.

### Requirement → change

| User wants… | Change… |
| --- | --- |
| New state mutation humans and agent can do | public `t.on(...)` edge |
| Async, multi-step, or value-returning operation | `p.procedure(...)` |
| Capability call whose result updates state | `t.cmd(...).to(...)` + `t.fromResult(...)` |
| React to file/external changes over time | `subscriptions(...)` + `t.fromEvent(...)` |
| Pure visual/layout change | `gui.tsx` / CSS only |
| Human-only/destructive operation | `audience: 'gui'` procedure or internal `t.commit` |
| Persisted fact the agent should know | reducer state |
| Drag/hover/typing/scroll/palette state | GUI-local React state |

## 3. Minimal app

`src/app.ts`:

```ts
import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

type State = {
	greeting: string
}

export const app = defineApp({
	init: { greeting: 'Hello, world!' } as State,
	update: (t) => ({
		setGreeting: t.on(
			v.object({ greeting: v.string() }),
			(state, { greeting }) => ({ ...state, greeting }),
			{
				description: 'Change the greeting shown by the app.',
				examples: [{ params: { greeting: 'Hello from the agent' } }]
			}
		)
	})
})

export type HelloApp = typeof app
```

`src/gui.tsx`:

```tsx
import type { GUIProps } from '@justfiles/app/react'
import { useState } from 'react'
import type { app } from './app'
import './gui.css'

export default function Hello({ state, actions }: GUIProps<typeof app>) {
	const [draft, setDraft] = useState(state.greeting)

	return (
		<form
			className="hello"
			onSubmit={(event) => {
				event.preventDefault()
				void actions.setGreeting({ greeting: draft })
			}}
		>
			<h1>{state.greeting}</h1>
			<input value={draft} onChange={(event) => setDraft(event.target.value)} />
			<button type="submit">Save</button>
		</form>
	)
}
```

`src/gui.css`:

```css
.hello {
	display: grid;
	gap: 12px;
	align-content: center;
	height: 100%;
	padding: 24px;
	background: var(--surface);
	color: var(--text);
}
```

The input text is transient GUI state. Only submit dispatches the semantic app action.

## 4. State design and persistence

Reducer state is persisted as JSON. `init` is used for first boot only; it is not merged into older
persisted state after you add fields later.

Design state as the durable facts of the app:

- document ids/paths;
- selected item;
- mode/phase;
- saved records;
- small status/error fields;
- revision counters that tell the GUI to re-read data.

Keep these out of reducer state:

- in-progress text while typing;
- pointer positions and drag state;
- hover/focus/scroll;
- large file bytes that can be re-read on demand;
- duplicated derived values.

When changing a shipped app, tolerate old state shapes:

```ts
type State = {
	notes: Array<{ title: string; path?: string }>
}

const pathOf = (note: { title: string; path?: string }) => note.path ?? `/notes/${note.title}.txt`
```

## 5. `defineApp` API

```ts
export const app = defineApp({
	init,                                  // required bootstrap state
	capabilities: { name: cap({ scopes }) }, // optional host services
	update: (t) => ({ ...edges }),         // state machine
	subscriptions: (state, sub) => [],      // optional streams
	procedures: (p) => ({ ...procedures }) // optional async facade
})
```

Always export the app type:

```ts
export type MyApp = typeof app
```

The GUI and typed client infer state, actions, and procedure params from that type.

## 6. Edges: the state machine

Edges are pure synchronous transitions. They return either a next state or `[nextState, command]`.
Do not use `async`/`await` inside an edge.

### Public action: `t.on(schema, transition, meta?)`

```ts
increment: t.on(
	v.object({ amount: v.number() }),
	(state, { amount }) => ({ ...state, count: state.count + amount }),
	{
		description: 'Increase the counter.',
		examples: [{ params: { amount: 1 } }]
	}
)
```

Use for actions the GUI and agent should be able to call.

### Internal commit: `t.commit(schema, transition)`

```ts
loaded: t.commit(
	v.object({ greeting: v.string() }),
	(_state, snapshot) => snapshot
)
```

Use for state commits dispatched by your own procedures. It is not agent-visible and not on the GUI
`actions` object.

### Capability command: `t.cmd(...).to(edge)` + `t.fromResult(...)`

```ts
save: t.on(
	v.object({ text: v.string() }),
	(state, { text }) => [
		{ ...state, error: null },
		t.cmd('volume', 'writeFile', '/note.txt', new TextEncoder().encode(text)).to('saved')
	],
	{ description: 'Save the note text.' }
),
saved: t.fromResult('volume', 'writeFile', (state, result) =>
	result.ok ? { ...state, saved: true } : { ...state, error: result.error.message }
)
```

`fromResult` receives:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
```

### Stream event: `t.fromEvent(...)`

Used with `subscriptions`:

```ts
fileChanged: t.fromEvent('volume', 'watch', (state) => ({
	...state,
	revision: state.revision + 1
}))
```

## 7. Procedures: async and multi-step work

Use procedures for async work, multi-step workflows, and capability calls that return a value to the
caller.

```ts
procedures: (p) => ({
	generateGreeting: p.procedure({
		description: 'Generate a greeting for a topic.',
		schema: v.object({ topic: v.string() }),
		async run({ topic }, app) {
			const { text } = await app.invoke('ai', 'generateText', {
				prompt: `Write one short greeting about ${topic}.`,
				maxTokens: 80
			})
			const { seq } = await app.dispatch({
				type: 'loaded',
				params: { greeting: text.trim() }
			})
			return app.settled(seq)
		}
	})
})
```

Procedure `run(params, app)` gets:

| Member | Use |
| --- | --- |
| `app.state` | Read current state snapshot. |
| `app.invoke(capability, method, ...args)` | Call a declared capability and get the value. |
| `app.dispatch({ type, params })` | Dispatch an edge, usually an internal `t.commit`. |
| `app.settled(seq, opts?)` | Wait for resulting state to settle and return it. |

Audience:

```ts
p.procedure({ audience: 'gui', ... })   // hidden from the agent surface
p.procedure({ audience: 'agent', ... }) // intended for agent workflows
p.procedure({ ... })                    // default: both
```

Use `audience: 'gui'` for destructive or context-dependent operations the agent must not call blindly.

## 8. Capabilities

Declare every capability you use:

```ts
import { volume } from '@justfiles/app/capabilities/volume'
import { ai } from '@justfiles/app/capabilities/ai'

export const app = defineApp({
	init,
	capabilities: {
		volume: volume({ scopes: [] }),
		ai: ai({ scopes: [] })
	}
})
```

The object key (`volume`, `ai`) is the app-local name you pass to `t.cmd`, `t.fromResult`,
`sub.capability`, and `app.invoke`.

### Volume

Use `volume({ scopes: [] })` for private app storage. Inside that private chroot, paths are absolute:
`/notes/a.txt`, `/settings.json`, etc.

Scopes:

| Scope | Meaning |
| --- | --- |
| `[]` or `['app']` | private per-app storage; default choice |
| `['/prefix']` | a chroot at a host prefix, when granted |
| `['system']` | whole user volume; first-party/allowlisted apps only |

Common methods:

```ts
readFile(path): Promise<Uint8Array>
writeFile(path, data: Uint8Array): Promise<void> // auto-creates parent dirs
appendFile(path, data: Uint8Array): Promise<void>
exists(path): Promise<boolean>
mkdir(path, opts?: { recursive?: boolean; mode?: number }): Promise<void>
readdir(path): Promise<Dirent[]>
rm(path, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
rename(oldPath, newPath): Promise<void>
cp(src, dest, opts?: { recursive?: boolean }): Promise<void>
stat(path): Promise<Stat>
lstat(path): Promise<Stat>
scan({ path, recursive? }): Promise<Array<{ path: string; type: 'file' | 'dir' }>>
```

Advanced methods also exist for xattrs, symlinks, chmod, and mtimes:
`getXattr`, `setXattr`, `listXattr`, `removeXattr`, `symlink`, `readlink`, `chmod`, `utimes`.
Use them only when the app genuinely needs filesystem metadata.

I/O is bytes. Encode/decode text yourself:

```ts
const enc = new TextEncoder()
const dec = new TextDecoder()
```

### AI

```ts
ai.generateText({
	system?: string,
	prompt: string,
	temperature?: number,
	maxTokens?: number
}): Promise<{ text: string }>
```

### Notify

```ts
notify.notify({
	id: string,
	kind: 'info' | 'error' | 'question',
	title: string,
	body: string,
	threadId?: string,
	route?: { kind: 'chat' } | { kind: 'app'; id: string } | { kind: 'settings'; pane?: string }
}): void
```

### Email and calendar

These depend on connected user accounts and can be unavailable.

```ts
email.listUnread({ since?: number, limit?: number, accountId?: string })
email.readDetail({ id: string, accountId?: string, purpose: 'briefing-detail' | 'summarization' })
email.markRead({ id: string, accountId?: string })
calendar.listToday({ timezone: string, accountId?: string, now?: number })
```

### First-party capabilities

`accountsAdmin` and `devkit` are for first-party apps such as Settings and Code. Do not use them in an
ordinary user app unless the user is explicitly working on such an app and the host grants it.

## 9. Subscriptions

`subscriptions(state, sub)` declares the streams the current state wants open. Keep it pure.

Example: watch the open file and bump a revision when it changes.

```ts
export const app = defineApp({
	init: { openPath: null, revision: 0 } as { openPath: string | null; revision: number },
	capabilities: { volume: volume({ scopes: [] }) },
	subscriptions: (state, sub) =>
		state.openPath ? [sub.capability('volume', 'watch', { path: state.openPath }).to('changed')] : [],
	update: (t) => ({
		open: t.on(
			v.object({ path: v.string() }),
			(state, { path }) => ({ ...state, openPath: path }),
			{ description: 'Open a file.' }
		),
		changed: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			revision: state.revision + 1
		}))
	})
})
```

Do not stream large bytes into state. Store a signal, then re-read on demand.

## 10. GUI

### React GUI

Default-export a component from `.tsx`/`.jsx`:

```tsx
import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'

export default function MyGui({ state, actions }: GUIProps<typeof app>) {
	return <button onClick={() => void actions.increment({ amount: 1 })}>{state.count}</button>
}
```

`actions` contains public `t.on` actions and procedures. It does not contain `t.commit`, `t.fromResult`,
or `t.fromEvent` edges.

Use `void actions.foo(...)` for fire-and-forget UI handlers. Let state updates flow back through props.

### CSS

Import CSS from the GUI:

```tsx
import './gui.css'
```

CSS is folded into the GUI bundle. Scope selectors under an app root class:

```css
.notes {
	height: 100%;
	background: var(--surface);
	color: var(--text);
}
```

Prefer host tokens (`--surface`, `--text`, `--rule`, `--focus`) over hard-coded platform colors.

Inline style injection is also available:

```ts
import { injectStyle } from '@justfiles/app/browser'

injectStyle(`.my-app { height: 100%; }`, 'my-app')
```

### Imperative GUI

Use a plain `.ts` GUI with `defineGUI` when you need custom lifecycle control:

```ts
import { defineGUI } from '@justfiles/app/browser'
import type { HelloApp } from './app'

export const gui = defineGUI<HelloApp>({
	mount(el, state, ctx) {
		const button = document.createElement('button')
		const render = (next: typeof state) => {
			button.textContent = next?.greeting ?? 'Hello'
		}
		button.onclick = () => void ctx.client.setGreeting({ greeting: 'Clicked' })
		el.replaceChildren(button)
		render(state)
		return { update: render, unmount: () => el.replaceChildren() }
	}
})
```

## 11. File-backed app recipe

Pattern: keep file metadata/current path in reducer state; keep file body bytes out of reducer state.
Read body through a procedure, write body through an action+command.

```ts
import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

const enc = new TextEncoder()
const dec = new TextDecoder()

type State = {
	openPath: string | null
	revision: number
	error: string | null
}

export const app = defineApp({
	init: { openPath: null, revision: 0, error: null } as State,
	capabilities: { volume: volume({ scopes: [] }) },
	subscriptions: (state, sub) =>
		state.openPath ? [sub.capability('volume', 'watch', { path: state.openPath }).to('changed')] : [],
	update: (t) => ({
		open: t.on(
			v.object({ path: v.string() }),
			(state, { path }) => ({ ...state, openPath: path, error: null }),
			{ description: 'Open a document.', examples: [{ params: { path: '/notes/a.txt' } }] }
		),
		save: t.on(
			v.object({ path: v.string(), text: v.string() }),
			(state, { path, text }) => [
				{ ...state, error: null },
				t.cmd('volume', 'writeFile', path, enc.encode(text)).to('saved')
			],
			{ description: 'Save a document body.' }
		),
		saved: t.fromResult('volume', 'writeFile', (state, result) =>
			result.ok ? state : { ...state, error: result.error.message }
		),
		changed: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			revision: state.revision + 1
		}))
	}),
	procedures: (p) => ({
		readDocument: p.procedure({
			description: 'Read a document body as text.',
			schema: v.object({ path: v.string() }),
			async run({ path }, app) {
				if (!(await app.invoke('volume', 'exists', path))) return { path, text: '' }
				return { path, text: dec.decode(await app.invoke('volume', 'readFile', path)) }
			}
		})
	})
})
```

GUI reads `readDocument({ path })` when `openPath` or `revision` changes, and stores the editor buffer
in React state.

## 12. Agent-facing action design

Every public action is part of the agent interface. For actions the agent should use:

- write a one-line imperative `description`;
- include realistic `examples`;
- use tight schemas;
- encode preconditions in the description;
- keep state readable as JSON.

Bad:

```ts
foo: t.on(v.object({ x: v.any() }), transition, { description: 'Do stuff.' })
```

Good:

```ts
renameNote: t.on(
	v.object({ path: v.string(), title: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
	transition,
	{
		description: 'Rename an existing note. Use the current note path as `path`.',
		examples: [{ params: { path: '/notes/today.txt', title: 'Today' } }]
	}
)
```

If the agent should not call an operation, do not expose it as `t.on`; use a GUI-only procedure or an
internal commit edge.

## 13. App-code verification loop

After editing a draft, verify once the change is complete:

1. `typecheck` — catches TypeScript/API errors.
2. `compile` — catches syntax, unsupported imports, and bundling errors.
3. `run` — when you need to smoke-test the live GUI.

If `typecheck` is unavailable on a host, skip it and rely on `compile`/`run`.

Clean means no diagnostics with `severity: 'error'`. Fix errors and re-run until clean. Do not report the
change complete before this final gate.

Common app-code failures:

| Error | Fix |
| --- | --- |
| External npm package is not supported | Remove the dependency; implement locally or use an in-repo app package. |
| Cannot find module | Check allowed imports and relative paths. |
| Unknown capability/method type error | Import and declare the capability factory, then call a real method. |
| Missing entry | Ensure `project.json` points to existing `src/app.ts` / `src/gui.tsx`. |
| State field is `undefined` after update | Handle older persisted state; `init` is not merged into old state. |

## 14. Full package apps

If the user explicitly needs arbitrary dependencies, custom Vite config, or workspace libraries, app-code
is the wrong target. Create an in-repo package instead:

```sh
node packages/create-app/index.js packages/app-name
```

That path uses `packages/app-<name>` and `kernelHost(...)`. Keep this as an escape hatch; most app-code
requests should be solved inside the draft constraints above.

## Hard rules

- Keep the core state machine small.
- No third-party npm packages in app-code.
- `app.ts` is headless: no DOM, React, `window`, direct FS/network, or async transitions.
- Transitions are pure and synchronous.
- Side effects go through declared capabilities.
- Reducer state is semantic and persistable; transient UI state stays in the GUI.
- One dispatch per semantic event, not per keystroke/pointer move.
- Public action metadata is the agent's UI.
- Hide human-only/destructive operations from the agent.
- Always verify with typecheck + compile/run before done.
