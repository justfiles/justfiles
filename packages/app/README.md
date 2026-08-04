# @justfiles/app

Kernel app SDK for JustFiles apps.

Apps split headless logic from browser UI:

- `app.ts` runs in a sandboxed kernel and owns actions/state.
- `gui.ts` runs in the browser, renders state, and dispatches typed actions.
- Frieren installs built app bundles into the kernel and serves per-user assets from `/api/kernel/:appId/*`.

## App logic

```ts
import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ count: state.count + amount }),
			{ description: 'Increase the counter.' }
		)
	})
})
```

Action schemas use Standard Schema-compatible validators. Transition return values become the next persisted app state.

## GUI

For a React `gui.tsx`/`gui.jsx` entry, default-export a component. `kernelHost()` wraps it with the host lifecycle and injects typed props:

```tsx
import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'

export default function Counter({ state, actions }: GUIProps<typeof app>) {
	return (
		<button type="button" onClick={() => void actions.increment({ amount: 1 })}>
			count: {state.count}
		</button>
	)
}
```

Optional menus are a named export:

```tsx
import type { GUIMenu } from '@justfiles/app/react'
import type { app } from './app'

export const menu: GUIMenu<typeof app> = (state, actions) => [
	{
		title: 'Count',
		items: [{ title: 'Increment', onSelect: () => void actions.increment({ amount: 1 }) }]
	}
]
```

The `.tsx`/`.jsx` extension is the whole signal — any such entry is wrapped as a component. For a non-React or custom-lifecycle GUI, use a plain `gui.ts` that exports `gui` via `defineGUI` from `@justfiles/app/browser`; it's used verbatim.

## Build

```ts
import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.example.counter',
			name: 'Counter',
			description: 'A tiny counter app.',
			app: 'src/app.ts',
			gui: 'src/gui.tsx'
		})
	]
})
```

Build output contains `manifest.json`, `app.js`, `gui.js`, and copied public assets. Nothing is external — the SDK and whatever UI framework the GUI uses are both bundled into `app.js`/`gui.js`. Manifest fields include `id`, `name`, optional metadata, bundle entry paths, and optional `include` globs for extra installed files.

## Capabilities

Import capability contracts from subpaths, for example:

```ts
import { ai } from '@justfiles/app/capabilities/ai'
```

## Exports

- `@justfiles/app` — platform-agnostic author SDK plus runtime types.
- `@justfiles/app/browser` — low-level browser GUI SDK.
- `@justfiles/app/react` — React GUI adapter and prop types.
- `@justfiles/app/runtime` — kernel runtime host API.
- `@justfiles/app/vite` — Vite build/dev plugin.
- `@justfiles/app/capabilities/*` — capability contracts and broker helpers.

## App-authoring discipline

### Self-contained artifacts

`kernelHost` externalises nothing. A GUI carries its own framework — one
copy of React, or Svelte, or no framework at all — and a host serves no
framework bytes at all, only the platform stylesheet it injects into the
frame. So an app pays for exactly what it uses, and the platform is not
betting on one framework.

Whatever the GUI uses must resolve to a SINGLE copy inside `gui.js`;
two Reacts in one bundle is the classic "Invalid hook call". Vite's
`resolve.dedupe` handles the usual pnpm-nesting cause, and a React-based
dependency that pulls its own major version is the case to watch.

In standalone dev (`pnpm dev`), the GUI is served as ordinary Vite
browser modules — Vite owns the TSX transform, React Refresh, source
maps, and CSS. The headless `app.ts` runs through Vite's `kernel` server
environment, so app edits hot-reload without restarting the dev server.

Keep the framework out of `app.ts`. The reducer runs headless in a Worker
with no document, and `kernelHost` fails the build if React reaches it.

### State discipline

Reducer state is semantic, persistable, agent-inspectable. Put values
the agent needs to read or that the user expects to survive a reload in
the reducer. Keep transient interaction state — drag positions, scroll
offsets, in-progress text input, undo history — in GUI-local React
state. Don't dispatch on every keystroke or pointer-move; one dispatch
per semantic event (pointer-up, form submit, save) is the right
granularity. Each dispatch round-trips to the kernel.

### Capabilities

Declare every host service the app touches in the `capabilities` field
of `defineApp`. The kernel uses the declared set to scope grants and the
agent uses it to know what an action might trigger. Even if the host
grants you broad access today, declaring keeps `app actions` honest —
the TUI surface for the agent — and surfaces accidental escapes when a
new host enforces tighter scopes.
