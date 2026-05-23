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
	handlers: {
		increment: {
			description: 'Increase the counter.',
			schema: v.object({ amount: v.number() }),
			handler: ({ amount }, ctx) => ({ count: ctx.state.count + amount })
		}
	}
})

export type CounterApp = typeof app
```

Action schemas use Standard Schema-compatible validators. Handler return values become the next persisted app state.

## GUI

```ts
import { defineGUI } from '@justfiles/app/browser'
import type { CounterApp } from './app'

export const gui = defineGUI<CounterApp>({
	mount(el, state, ctx) {
		const button = document.createElement('button')
		button.textContent = `count: ${state.count}`
		button.onclick = () => void ctx.client.increment({ amount: 1 })
		el.append(button)

		return {
			update(next) {
				button.textContent = `count: ${next.count}`
			},
			unmount() {
				el.replaceChildren()
			}
		}
	}
})
```

`defineGUI` injects a typed client and subscribes to state updates through the host transport.

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
			gui: 'src/gui.ts'
		})
	]
})
```

Build output contains `manifest.json`, `app.js`, `gui.js`, and copied public assets. Manifest fields include `id`, `name`, optional metadata, and bundle entry paths.

## Capabilities

Import capability contracts from subpaths, for example:

```ts
import { ai } from '@justfiles/app/capabilities/ai'
```

## Exports

- `@justfiles/app` — platform-agnostic author SDK plus runtime types.
- `@justfiles/app/browser` — browser GUI SDK.
- `@justfiles/app/runtime` — kernel runtime host API.
- `@justfiles/app/vite` — Vite build/dev plugin.
- `@justfiles/app/capabilities/*` — capability contracts and broker helpers.
