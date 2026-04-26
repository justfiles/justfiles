# Apps

Small apps that run in sandboxed iframes inside the chat. State lives on the worker; the iframe renders and dispatches actions. Same reducer drives the human UI and the agent's tools.

## Structure

One directory per app. Launch with `/<id>` in chat.

```
hello/
├── index.ts      # exports the App (engine + UI + agent metadata)
├── index.html    # iframe entry
└── hello.js      # iframe UI code
```

## Hello world

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

**`hello/index.ts`** — single `app(...)` factory call.

```ts
import { app } from '../app'
import script from './hello.js?raw'
import html from './index.html?raw'

export const helloApp = app({
	id: 'hello',
	name: 'Hello',
	description: 'Greets you.',
	engine: {
		initial: { message: 'Hello, world.' },
		step: (state) => state
	},
	ui: {
		entry: 'index.html',
		assets: { 'index.html': html, 'hello.js': script }
	}
})
```

Register in **`apps/index.ts`**:

```ts
import { helloApp } from './hello'
export const appRegistry = { [helloApp.id]: helloApp }
```

## Actions

The engine is a reducer: `(state, action, actor) => nextState`. Dispatch from the iframe.

```ts
engine: {
	initial: { count: 0 },
	step(state, action) {
		switch (action.type) {
			case 'increment': return { count: state.count + 1 }
			case 'decrement': return { count: state.count - 1 }
		}
	}
}
```

```js
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

```ts
allows(_state, _actor, action) {
	return ['increment', 'decrement'].includes(action.type)
}
```

## Per-actor views

Optional. Project state differently for human vs. agent.

```ts
view(state, actor) {
	return actor.kind === 'agent' ? { count: state.count } : state
}
```

## Action schemas → typed agent tools

Declare a TypeBox schema per action type and the runtime auto-generates one tool per action plus a `<id>_state` tool. Payloads are validated at the boundary.

```ts
import { Type } from '@sinclair/typebox'

engine: {
	initial: { count: 0 },
	step(state, action) { /* ... */ },
	actionSchemas: {
		increment: Type.Object({}),
		decrement: Type.Object({}),
		set: Type.Object({ value: Type.Integer() })
	}
}
```

The agent now sees `counter_state`, `counter_increment`, `counter_decrement`, `counter_set({value})` as separate tools with proper schemas.

If you skip `actionSchemas` you get a generic `<id>_dispatch` tool instead.

## Briefing & narration

Optional agent metadata.

```ts
agent: {
	briefing: 'Card game launched. Call card_deal with { card: <1-100> } to start.',
	narrate(transition, view) {
		return `User played ${transition.action.type}. View: ${JSON.stringify(view)}`
	}
}
```

`briefing` is sent on launch. `narrate` is called after a non-agent dispatch — return a string to prompt the agent, or `null` to stay silent.

## Custom tools

If the auto-derived tools aren't enough, override:

```ts
agent: {
	createTools({ getSession, agentActor }) {
		return [/* AgentTool[] */]
	}
}
```

## Transition log

Sessions keep an append-only log of `{ at, actorId, action }` (capped at 200 by default), persisted by the worker. Read with `session.log()` for replay/debugging.
