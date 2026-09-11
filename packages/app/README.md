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

A GUI entry exports `gui` from `defineGUI`. The SDK builds the typed client from the
host's transport and bridges state pushes into your `update` — you own the rendering:

```ts
import { defineGUI } from '@justfiles/app/browser'
import type { app } from './app'

export const gui = defineGUI<typeof app>({
	mount(root, state, { client }) {
		const button = document.createElement('button')
		button.type = 'button'
		button.onclick = () => void client.increment({ amount: 1 })
		root.append(button)

		const render = (next: { count: number } | null) => {
			button.textContent = `count: ${next?.count ?? 0}`
		}
		render(state)
		return { update: render, unmount: () => button.remove() }
	}
})
```

The platform ships no UI framework. To use React, add React and React DOM to your app and use the
small React adapter:

```tsx
import { defineReactGUI } from '@justfiles/app/react'
import type { app } from './app'

export const gui = defineReactGUI<typeof app>(({ state, client }) => (
	<button type="button" onClick={() => void client.increment({ amount: 1 })}>
		count: {state?.count ?? 0}
	</button>
))
```

`state` is nullable: the host may mount before the kernel has persisted state for
this app, so fall back to the reducer's `init`. Use `defineGUI` directly for plain DOM, another UI
framework, or a custom rendering lifecycle.

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

Build output contains `manifest.json`, `app.js`, `gui.js`, and copied public assets. The SDK and GUI dependencies are bundled by default. `kernelHost({ imports })` can map browser-only packages to exact-version `https://esm.sh` URLs; the build leaves those packages out of `gui.js`. Manifest fields include `id`, `name`, optional metadata, bundle entry paths, and optional `include` globs for extra installed files.

`pnpm build --watch` also serves the built app at `http://localhost:4173/store.json`. The URL uses
the same store and manifest format as JustApps, so a local Frieren host can install each rebuild.

## Capabilities

Import capability contracts from subpaths, for example:

```ts
import { ai } from '@justfiles/app/capabilities/ai'
```

## Exports

- `@justfiles/app` — platform-agnostic author SDK plus runtime types.
- `@justfiles/app/browser` — browser GUI SDK (`defineGUI`, `injectStyle`).
- `@justfiles/app/react` — React GUI adapter (`defineReactGUI`, `GUIProps`).
- `@justfiles/app/iframe` — host utilities for running a GUI in a sandboxed iframe.
- `@justfiles/app/runtime` — kernel runtime host API.
- `@justfiles/app/vite` — Vite build/dev plugin.
- `@justfiles/app/capabilities/*` — capability contracts and broker helpers.

`@justfiles/app/iframe` supplies `mountAppFrame(container, guiCode, state, host)`. It owns the
iframe document, fixed CSP, sandbox flags, design stylesheet, and message-port lifecycle. The
returned `update(state)` keeps the snapshot current; `dispose()` closes the port and removes the
frame. Reloading or reattaching boots a fresh document from the latest snapshot. Hosts provide
`invoke`, optional `dialog`, `onError`, and `onMessage` callbacks and keep their own window and
agent UI outside the frame. Title messages carry at most 200 characters; Escape messages let the
Mac host close its attached sheet. `gui.mount` and app authoring APIs are unchanged.

The lower-level `guiHost` and `guiFrameScript` remain available for hosted runners. Their `guiUrl`
boot path preserves a hosted module's URL; the three app hosts load bundle bytes with `guiCode`.

The iframe protects the host DOM, credentials, storage, and capability handles. Its CSP can block
normal fetch and subresource paths, but it does not guarantee total network egress isolation.
CSP `connect-src` does not control WebRTC. Treat all state and capability results sent to publisher
GUI code as disclosed to the publisher.

## App-authoring discipline

### GUI dependencies

`kernelHost` bundles GUI dependencies unless the app maps them with `imports`.
A mapped dependency loads from its pinned esm.sh URL at runtime and is not part
of `gui.js`. This keeps common frameworks out of each app artifact, but the app
needs network access on its first load.

Whatever the GUI uses must resolve to one React instance. For a bundled GUI,
set `resolve.dedupe` in the app's Vite config. For a mapped GUI, pin React,
its JSX runtime, and React DOM to the same version.

In standalone dev (`pnpm dev`), a watched production GUI build supplies `gui.js` to the same
opaque-origin frame used by Frieren and Mac. CSS imports and imported assets are embedded, and
mapped imports load their pinned URLs. Vite's connection stays in the outer page. Successful
builds replace the frame using current reducer state; GUI-local input, selection, and scroll may
reset. Build errors appear in the outer page while the last working GUI stays usable. The watcher
closes with Vite, and storage writes do not trigger GUI rebuilds.

Only the GUI environment is shared. The headless `app.ts` still runs through Vite's `kernel`
server environment in Node and updates without restarting the dev server. Frieren uses browser
Workers and Mac uses Bun Workers; host capabilities, native shortcuts, and downloads still need
occasional host smoke checks around releases.

For generated JavaScript, use a second `sandbox="allow-scripts"` iframe with `srcdoc` and a blob
module. Local documents inherit the GUI CSP. Keep its client-free renderer separate from the app
client and validate selected-text messages by `event.source` and shape. The shared policy allows
this fixture without `unsafe-eval`, `allow-same-origin`, or extra network permissions. Remote
frames, fetch, and native form navigation remain blocked. Import assets into the GUI or read
installed files through capabilities; relative host URLs are unavailable inside the frame.

The dev host persists its volume in `.justfiles/dev/` under the Vite project root.
App-scoped files live in `data/<appId>/` and reducer state in `state/<appId>.json`
inside that folder, so both survive a dev-server restart. Files are ordinary local
files and can be edited with external tools; leave the store's `.jfs/` metadata alone.
Add `.justfiles/dev/` to your `.gitignore` (new app templates already do this).
To reset local data, stop the dev server and delete that folder.

Keep the framework out of `app.ts`: the reducer runs headless in a Worker
with no document, so anything that touches the DOM belongs in the GUI.

### State discipline

Reducer state is semantic, persistable, agent-inspectable. Put values
the agent needs to read or that the user expects to survive a reload in
the reducer. Keep transient interaction state — drag positions, scroll
offsets, in-progress text input, undo history — in GUI-local
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
