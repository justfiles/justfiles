# Apps

Small apps that run in sandboxed iframes inside the chat. The engine runs on the worker; the iframe renders and dispatches actions.

## Minimum structure

One directory per app. Launch with `/<id>` in chat.

```
hello/
├── index.ts      server-side: bundle + export
├── app.js        engine + metadata
├── index.html    iframe entry
└── hello.js      iframe UI code
```

## Hello world

**`hello/app.js`** — the app.

```js
import { defineApp } from '../iframe'

export default defineApp({
	id: 'hello',
	name: 'Hello',
	description: 'Greets you.',
	engine: {
		initial: { message: 'Hello, world.' },
		step: (state) => state
	}
})
```

**`hello/index.html`**

```html
<!doctype html>
<html>
	<head><script src="./hello.js" defer></script></head>
	<body><main id="root"></main></body>
</html>
```

**`hello/hello.js`** — UI reads state via `window.app`.

```js
window.app.subscribe((state) => {
	document.querySelector('#root').textContent = state.message
})
```

**`hello/index.ts`** — bundles HTML + JS with the definition.

```ts
import { iframeApp } from '../iframe'
import definition from './app.js'
import script from './hello.js?raw'
import html from './index.html?raw'

export const helloApp = iframeApp(definition, {
	'index.html': html,
	'hello.js': script
})
```

Register in **`apps/index.ts`**:

```ts
import { helloApp } from './hello'
export const appRegistry = { [helloApp.id]: helloApp }
```

## Actions

The engine is a reducer: `(state, action) => nextState`. Dispatch from the iframe.

```js
// app.js
engine: {
	initial: { count: 0 },
	step(state, action) {
		switch (action.type) {
			case 'increment': return { ...state, count: state.count + 1 }
			case 'decrement': return { ...state, count: state.count - 1 }
			default: return state
		}
	}
}

// hello.js
button.addEventListener('click', () => {
	window.app.dispatch({ type: 'increment', payload: {} })
})
```

Every `dispatch` runs `step` on the worker and pushes the new state to every subscribed iframe.

## `window.app`

```ts
window.app: {
	readonly state              // most recent value
	subscribe(listener): () => void
	dispatch(action): Promise<void>
}
```

`subscribe` fires with the current state immediately (if any) and again on every host push. `dispatch` resolves on ack, rejects if `allows` returns false.

## Gating actions

Optional. Reject illegal moves before they reach `step`.

```js
engine: {
	// ...
	allows(_state, _actor, action) {
		return ['increment', 'decrement'].includes(action.type)
	}
}
```

## Per-actor views

Optional. Project state differently for human vs. agent. Iframes see the user projection; agent tools see theirs.

```js
engine: {
	// ...
	view(state, actor) {
		return actor.kind === 'agent' ? { count: state.count } : state
	}
}
```

## Agent hooks

Every app automatically gets two tools — `get_current_state` and `game_act` — plus a default briefing. Override any of:

```js
agent: {
	briefing: 'Deal first by calling game_act with {type:"deal", card:n}.',
	createTools: (args) => [...],                // custom AgentTool[]
	describeUserMove: (action, view) => '...'    // narration after user acts
}
```

Engine stays pure — agent concerns never leak into game logic.

## TypeScript

For editor support on JS apps, add a sibling `app.d.ts`:

```ts
import type { App } from '../app'
import type { Action, Actor } from '../engine'

declare const definition: App<
	{ count: number },
	Action<'increment' | 'decrement', {}>,
	Actor,
	{ count: number }
>
export default definition
```
