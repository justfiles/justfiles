---
title: 'Building Apps'
description: 'Agent guide for building apps with @justfiles/app.'
---

# Building Apps

Use this guide when creating or changing an app. The framework is in `packages/app`; apps run in
Frieren and Kodama for Mac. The best examples are:

- `packages/create-app/template` — minimum React app
- `packages/app-pixel` — rich public action surface
- `packages/app-notes` — scoped files, commands, subscriptions, and procedures
- `packages/app-crossword` — AI procedure committing one atomic result
- `packages/app-dictionary` — a framework-free GUI (plain DOM, no React) over an AI procedure
- `packages/app-paint` — high-frequency GUI-local state
- `packages/app-files` — recursive file watching and command coalescing
- `packages/app-draw` — a normal package using a third-party npm library
- `packages/app-code` — the in-app authoring environment

This is the app-author API. Do not use kernel, sandbox, transport, app-store, or host internals from an
app.

## The model

An app has one durable state machine and two consumers:

- The GUI renders state and calls typed actions.
- The agent reads the same JSON state and receives the public actions as tools.
- The kernel validates actions, serializes transitions, persists state, runs capabilities, and pushes
  new state to the GUI.

Put shared semantics in `app.ts`. Put rendering and transient interaction in the GUI.

| Requirement | Implement it with |
| --- | --- |
| Synchronous state change callable by GUI and agent | `t.on` |
| Async or multi-step operation | procedure |
| Capability result that must update state | `t.cmd(...).to(...)` + `t.fromResult` |
| Ongoing external events | `subscriptions` + `t.fromEvent` |
| Internal atomic commit from a procedure | `t.commit` |
| Visual or transient interaction | GUI-local state |
| Host service such as files, AI, or notifications | declared capability |

Reducer state is the contract between user, GUI, and agent. Keep it small, semantic, JSON-safe, and
backward-compatible.

## Choose an authoring environment

### Normal `app-*` package

Create new apps from the repository template:

```sh
node packages/create-app/index.js packages/app-<name>
```

Read the generated files, then use existing `packages/app-*` apps for the nearest advanced pattern.
A normal package has no dependency allowlist: add npm or workspace dependencies with `pnpm`. Reducer
dependencies must work in a headless worker and GUI dependencies in a browser. Vite bundles them into
the app artifact; React is shared with the host by default.

```text
packages/app-foo/
	src/app.ts
	src/gui.tsx
	vite.config.ts
	package.json
	tsconfig.json
	public/icon.png
```

The standard build is configured with `kernelHost`:

```ts
import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'app.example.foo',
						name: 'Foo',
						description: 'Does one useful thing.',
						icon: 'icon.png',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))
```

`kernelHost({ id, name, app, gui, description?, version?, icon?, include? })` runs a local development
host and builds `dist/manifest.json`, `app.js`, and `gui.js`. `version` defaults to
`package.json#version`. `include` is only for extra bundle files needed by a host; prefer a
self-contained `gui.js`.

The host imports `gui.js` as one blob module. Avoid emitted chunks and URL-loaded assets in portable
apps: inline dynamic imports and import small assets so the GUI bundle is self-contained. The icon is
the supported separate launcher asset.

### App Code draft

An App Code project lives in Code's private volume:

```text
/projects/<slug>/
	project.json
	src/app.ts
	src/gui.tsx
	icon
```

`project.json` supports:

```json
{
	"id": "com.example.foo",
	"name": "Foo",
	"description": "Optional",
	"version": "0.1.0",
	"app": "src/app.ts",
	"gui": "src/gui.tsx",
	"icon": "icon"
}
```

App Code is deliberately not an npm environment. Do not add third-party packages, Node built-ins, or
other bare imports. The only supplied bare imports are:

```text
@justfiles/app
@justfiles/app/browser
@justfiles/app/react
@justfiles/app/capabilities/volume
@justfiles/app/capabilities/notify
@justfiles/app/capabilities/email
@justfiles/app/capabilities/calendar
@justfiles/app/capabilities/ai
@justfiles/app/capabilities/devkit
@justfiles/app/capabilities/accounts
valibot
react
react-dom
react-dom/client
react/jsx-runtime
react/jsx-dev-runtime
```

Relative imports within the project work, including explicit CSS imports. The compiler folds CSS into
`gui.js`. `image`, `user`, and `usage` are platform capabilities but are not currently in the App Code
draft sysroot.

When driving Code as an agent:

1. Open or create the project.
2. Read and write its source files. Make the complete change before compiling.
3. Run `typecheck`; fix every error. Frieren's browser host may report
   `CAPABILITY_UNAVAILABLE` because it has no type checker.
4. Run `compile` or `run`; fix every build diagnostic. Use `run({ reset: true })` only when a clean
   reducer state is required.
5. Install or pack only after the final checks pass.

`compile` strips TypeScript types and therefore does not replace `typecheck`.

## State machine API

Schemas use the [Standard Schema](https://standardschema.dev/) interface. Apps normally use Valibot.
`app.ts` is a headless worker module: do not import React, access the DOM or `window`, perform top-level
I/O, or depend on Node APIs.

```ts
import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	capabilities: {},
	update: (t) => ({
		increment: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ ...state, count: state.count + amount }),
			{
				description: 'Increase the counter.',
				examples: [{ params: { amount: 1 } }]
			}
		)
	}),
	subscriptions: (_state, _sub) => [],
	procedures: (_p) => ({})
})

export type CounterApp = typeof app
```

`update`, `subscriptions`, `capabilities`, and `procedures` are optional. Always export the app type for
the GUI and other typed clients.

### Edge builders

Every transition is synchronous and pure:

```ts
(state, params) => nextState
(state, params) => [nextState, command]
```

It may throw to reject an invalid state-dependent operation. It must not call capabilities, access the
DOM, or be `async`.

| API | Input | Visibility | Purpose |
| --- | --- | --- | --- |
| `t.on(schema, transition, meta?)` | schema output | GUI client and agent | Public state transition |
| `t.commit(schema, transition)` | schema output | Internal | Procedure commits computed data |
| `t.fromResult(cap, method, transition)` | `Result<T>` | Internal | Fold a command result into state |
| `t.fromEvent(cap, method, transition)` | stream event | Internal | Fold a subscription event into state |
| `t.cmd(cap, method, ...args).to(edge)` | capability args | Returned by a transition | Request one capability call |

`meta` is `{ description?, examples? }`. Public actions are the agent's UI, so give every agent-useful
`t.on` a precise imperative description, a tight schema, and realistic examples.

Capability results are:

```ts
type Result<T> =
	| { ok: true; value: T }
	| { ok: false; error: { message: string } }
```

Use `.coalesce()` before `.to(...)` for an idempotent query that may be requested in bursts:

```ts
t.cmd('volume', 'scan', { path: '/', recursive: true })
	.coalesce()
	.to('filesLoaded')
```

While an identical command is running, the kernel collapses further requests into at most one trailing
rerun. Never coalesce writes or other accumulating operations.

### Procedures

A procedure is the async imperative facade shared by GUI and agent:

```ts
procedures: (p) => ({
	generate: p.procedure({
		description: 'Generate and commit a document.',
		audience: 'both',
		schema: v.object({ prompt: v.string() }),
		async run({ prompt }, app) {
			const { text } = await app.invoke('ai', 'generateText', { prompt })
			const { seq } = await app.dispatch({
				type: 'generated',
				params: { text }
			})
			return app.settled(seq)
		}
	})
})
```

`p.procedure({ schema, run, description?, audience? })` validates params before `run`.
`audience` is `'both'` by default, `'gui'`, or `'agent'`. A `'gui'` procedure is omitted from the
agent's discovered action list. Audience is interface metadata, not an authorization boundary; enforce
real privileges in capabilities and schemas.

The `app` handle provides every procedure-side API:

| API | Meaning |
| --- | --- |
| `app.state` | State snapshot supplied when the procedure starts |
| `app.invoke(capability, method, ...args)` | Call a declared capability and return its value |
| `app.dispatch({ type, params })` | Dispatch an edge; returns `{ seq }` |
| `app.settled(seq, { timeout? })` | Wait for that commit, queued work, and commands to become idle |

Prefer: perform async work, compute a complete result, dispatch one `t.commit`, then return
`app.settled(seq)`. This avoids partially committed workflows.

### Subscriptions

Subscriptions are a pure function of state. The kernel diffs the returned descriptors after every
commit, starts new streams, stops removed streams, and recreates them after restart.

```ts
subscriptions: (state, sub) =>
	state.openPath
		? [sub.capability('volume', 'watch', { path: state.openPath }).to('fileChanged')]
		: [],
update: (t) => ({
	fileChanged: t.fromEvent('volume', 'watch', (state) => ({
		...state,
		revision: state.revision + 1
	}))
})
```

Store a small semantic signal such as `revision`; re-read large external data through a procedure.

### Persistence and compatibility

The entire reducer state is JSON-written to `/state/<app-id>.json` after every commit. On later boots,
persisted state is loaded verbatim. `init` is only the first-run state; it is not merged into old state.

Therefore:

- Use JSON values only. Keep bytes, blobs, DOM objects, class instances, and `bigint` out of state.
- Treat newly added fields as optional or normalize old shapes at every entry point.
- Put documents and large payloads in `volume`; keep paths, selection, status, and revision in state.
- Keep pointer movement, drag state, scroll, hover, draft keystrokes, and render caches in the GUI.
- Dispatch one semantic event, not every pointer move or keystroke.

Uninstalling an app removes its reducer state and private `/data/<app-id>` volume. Reinstalling over an
existing app preserves state.

## GUI API

### React GUI

A `.tsx` or `.jsx` GUI normally default-exports a component:

```tsx
import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'
import './gui.css'

export default function Foo({ state, actions }: GUIProps<typeof app>) {
	return (
		<button type="button" onClick={() => void actions.increment({ amount: 1 })}>
			{state.count}
		</button>
	)
}
```

`GUIProps<A>` contains:

- `state` — the current non-null reducer state
- `actions` — `Client<A>`, with one async method per public `t.on` and procedure

State returns through host pushes and causes a rerender. Usually fire an action with `void` and render
the pushed state rather than depending on its immediate return.

React, React DOM, and JSX runtimes are externalized so a GUI shares the host's React instance. A normal
package may use third-party React libraries, but keep the final GUI graph compatible with the shared
React. If a CommonJS dependency forces bundled React or emits chunks, follow `packages/app-draw` and
keep the resulting `gui.js` single-file.

### Imperative GUI

Use `defineGUI` for Canvas, WebAssembly, a custom React root, or another imperative renderer:

```ts
import { defineGUI } from '@justfiles/app/browser'
import type { FooApp } from './app'

export const gui = defineGUI<FooApp>({
	mount(element, state, { client }) {
		const render = (next: typeof state) => {
			element.textContent = String(next?.count ?? 0)
		}
		render(state)
		return {
			update: render,
			unmount: () => element.replaceChildren()
		}
	}
})
```

Here the initial `state` is nullable. `mount` returns `{ update(state), unmount() }`; both methods may
be async. The context supplies the typed `client`.

`injectStyle(css, key?)` from `@justfiles/app/browser` injects CSS once. A normal CSS side-effect import
is preferred; both package and draft builds fold it into `gui.js`.

`Client<A>`, `createClient<A>(transport)`, and `Transport` are exported from `@justfiles/app` for
low-level adapters. Regular GUIs should use `GUIProps` or the client supplied by `defineGUI`.

Both hosts sandbox reducers. Frieren also runs every GUI in an opaque-origin, network-denied iframe.
For portable apps, do not use `fetch`, cookies, host DOM access, or ambient credentials. Use declared
capabilities; use `data:` or `blob:` URLs for generated media.

## Capabilities

Declare every capability before using it:

```ts
import { ai } from '@justfiles/app/capabilities/ai'
import { volume } from '@justfiles/app/capabilities/volume'

capabilities: {
	volume: volume({ scopes: [] }),
	ai: ai({ scopes: [] })
}
```

The object key is the app-local name passed to `t.cmd`, `t.fromResult`,
`sub.capability`, and `app.invoke`. The factory records the platform capability id and requested
scopes; the host decides whether the app is allowed to use it.

Use `t.cmd` when the result belongs in state. Use `app.invoke` in a procedure when the result belongs
to that caller or is one step in a workflow.

Capability failures use:

```text
CAPABILITY_UNAVAILABLE
CAPABILITY_INVALID_INPUT
CAPABILITY_DENIED
CAPABILITY_FAILED
CAPABILITY_OFFLINE
```

Availability differs by host and user configuration:

| Capability | Import/factory | Frieren | Kodama for Mac | App Code import |
| --- | --- | --- | --- | --- |
| Files | `capabilities/volume`: `volume` | Yes | Yes | Yes |
| Text AI | `capabilities/ai`: `ai` | Yes | Account-dependent | Yes |
| Image generation | `capabilities/image`: `image` | Provider-dependent | No | No |
| Email | `capabilities/email`: `email` | Account-dependent | Account-dependent | Yes |
| Calendar | `capabilities/calendar`: `calendar` | Account-dependent | Account-dependent | Yes |
| Notifications | `capabilities/notify`: `notify` | Yes | Yes | Yes |
| Current user | `capabilities/user`: `user` | Yes | Returns `null` | No |
| Plan usage | `capabilities/usage`: `usage` | Yes | No | No |
| Account administration | `capabilities/accounts`: `accountsAdmin` | First-party Settings only | First-party Settings only | Importable, but not granted to drafts |
| App compiler/installer | `capabilities/devkit`: `devkit` | First-party Code only | Yes | Yes; Frieren denies authored apps at runtime |

The standalone Vite development host implements only `volume`. Test other capabilities inside Frieren
or Kodama for Mac, or unit-test the pure logic behind them.

### `volume`

All paths are absolute inside the granted view. Scopes:

- `[]`, `['app']`, or other non-path scopes: private `/data/<app-id>`, exposed to the app as `/`
- `['/prefix']`: shared user volume chrooted at that absolute prefix; `/system` is forbidden
- `['system']`: entire user volume; host-allowlisted first-party Files app only

Data methods:

```ts
stat(path): Promise<Stat>
lstat(path): Promise<Stat>
exists(path): Promise<boolean>

getXattr(path, name): Promise<Uint8Array | null>
setXattr(path, name, value: Uint8Array): Promise<void>
listXattr(path): Promise<string[]>
removeXattr(path, name): Promise<void>

readFile(path): Promise<Uint8Array>
writeFile(path, data: Uint8Array): Promise<void>
appendFile(path, data: Uint8Array): Promise<void>

mkdir(path, opts?: { recursive?: boolean; mode?: number }): Promise<void>
readdir(path): Promise<Dirent[]>
rm(path, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
rename(oldPath, newPath): Promise<void>
cp(src, dest, opts?: { recursive?: boolean }): Promise<void>

symlink(target, path): Promise<void>
readlink(path): Promise<string>
chmod(path, mode): Promise<void>
utimes(path, mtimeNs: bigint): Promise<void>

scan(input: { path: string; recursive?: boolean }): Promise<VolumeEntry[]>
```

`writeFile` creates missing parent directories. Other operations retain normal POSIX-like behavior.
Encode text with `TextEncoder` and decode with `TextDecoder`.

```ts
type Stat = {
	ino: string
	type: 0 | 1 | 2
	size: bigint
	mode: number
	mtimeNs: bigint
	ctimeNs: bigint
	contentHash?: string
}

type Dirent = { ino: string; name: string; type: 0 | 1 | 2 }
// 0 = regular file, 1 = directory, 2 = symlink

type VolumeEntry = { path: string; type: 'file' | 'dir' }
```

`scan({ recursive: false })` lists direct children; `recursive: true` walks the subtree. It skips
symlinks and returns `[]` when the root does not exist.

The one stream is:

```ts
watch(input: { path: string; recursive?: boolean }): Stream<{ source?: string }>
```

Without `recursive`, it watches one concrete path for content, metadata, create, remove, or replace
changes. With `recursive: true`, it is a coalesced structural-change signal for the subtree at
`path`; pair it with a recursive scan of the same path. It is scoped to the volume your `scopes`
bound, so writes outside your prefix never wake you. Recursive watch does not report content edits
to existing children.

### Other capability method signatures

```ts
// ai
generateText(input: {
	system?: string
	prompt: string
	temperature?: number
	maxTokens?: number
}): Promise<{ text: string }>

// image
generateImage(input: { prompt: string }): Promise<{
	images: { data: string; mimeType: string }[]
}>

// email
listUnread(input: {
	since?: number
	limit?: number
	accountId?: string
}): Promise<EmailSummary[]>
readDetail(input: {
	id: string
	accountId?: string
	purpose: 'briefing-detail' | 'summarization'
}): Promise<EmailDetail>
markRead(input: {
	id: string
	accountId?: string
}): Promise<{ success: true }>

type EmailSummary = {
	id: string
	from: string
	subject: string
	receivedAt: number
	unread: boolean
	accountId?: string
}
type EmailDetail = EmailSummary & { bodyText: string }

// calendar
listToday(input: {
	timezone: string
	accountId?: string
	now?: number
}): Promise<CalendarEvent[]>
type CalendarEvent = {
	id: string
	title: string
	startsAt: number
	endsAt: number
	location?: string
	accountId?: string
}

// notify
notify(input: {
	id: string
	kind: 'info' | 'error' | 'question'
	title: string
	body: string
	threadId?: string
	route?:
		| { kind: 'chat' }
		| { kind: 'app'; id: string }
		| { kind: 'settings'; pane?: string }
}): void

// user
current(input: {}): Promise<{
	id: string
	name?: string
	avatarUrl?: string
} | null>

// usage
current(input: {}): Promise<{
	tier: string
	aiBurst: UsageWindow
	aiWeekly: UsageWindow
	storage: UsageResource
	aiTokens: number
	aiRequests: number
}>
type UsageResource = {
	used: number
	limit: number | null
	remaining: number | null
	exceeded: boolean
	fraction: number
}
type UsageWindow = UsageResource & { resetsAt: number | null }
```

Privileged capability signatures:

```ts
// accountsAdmin
listProviders(input: {}): Promise<ProviderInfo[]>
listAccounts(input: {}): Promise<AccountInfo[]>
connect(input: {
	providerId: string
	credentials?: Record<string, string>
}): Promise<{ accountId: string }>
setEnabled(input: {
	accountId: string
	capability: 'email' | 'calendar' | 'ai'
	enabled: boolean
	config?: unknown
}): Promise<void>
disconnect(input: { accountId: string }): Promise<void>

type ProviderInfo = {
	id: string
	name: string
	authKind: 'form' | 'interactive' | 'none'
	builtin?: boolean
	capabilities: ('email' | 'calendar' | 'ai')[]
	credentialsSchema?: {
		type: 'object'
		properties: Record<string, {
			type: 'string'
			minLength?: number
			description?: string
		}>
		required?: string[]
	}
}
type AccountInfo = {
	accountId: string
	providerId: string
	enabled: ('email' | 'calendar' | 'ai')[]
	config: Partial<Record<'email' | 'calendar' | 'ai', unknown>>
	lastError?: string
}

// devkit — used by the Code app, not by an app being authored
compile(input: { slug: string }): Promise<{
	outputs: { path: string; text: string }[]
	diagnostics: Diagnostic[]
}>
typecheck(input: { slug: string }): Promise<{ diagnostics: Diagnostic[] }>
run(input: { slug: string; reset?: boolean }): Promise<{
	previewId: string
	diagnostics: string[]
	preview?: { kind: 'url'; src: string } | { kind: 'window' }
}>
stop(input: { previewId: string }): Promise<void>
install(input: { slug: string }): Promise<{ id: string }>
pack(input: { slug: string }): Promise<{ zip: Uint8Array }>
previewIdFor(slug: string): string

type Diagnostic = {
	file: string
	range: {
		start: { line: number; character: number }
		end: { line: number; character: number }
	}
	severity: 'error' | 'warning' | 'info'
	source: string
	code?: string
	message: string
	related?: { file: string; range: Diagnostic['range']; message: string }[]
}
```

## Final checklist

- Reducer transitions are pure, synchronous, and immutable.
- Reducer state is minimal, JSON-safe, and tolerant of old persisted shapes.
- Public actions have tight schemas, descriptions, and examples.
- Async work lives in procedures; capability effects from edges use commands.
- Every used capability is declared and its host availability is handled.
- High-frequency interaction and large payloads stay out of reducer state.
- GUI code is self-contained and does not depend on direct network or host access.
- App Code drafts use only the fixed imports; normal packages may use pnpm dependencies.
- Package changes pass `pnpm format`, `pnpm typecheck`, `pnpm lint:fix`, and `pnpm test`.
- App Code changes pass `typecheck` (when available) and `compile` or `run`.
