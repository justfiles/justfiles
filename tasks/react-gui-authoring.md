---
project: packages/app
status: active
---

# React GUI authoring

## Goal

Let a React app author render reducer state and call the typed app client without writing the
`createRoot`, update, subscription, and unmount bridge for every GUI.

The host contract stays unchanged. A built GUI still exports `gui`, and the host still calls
`gui.mount(element, state, { transport })`. React remains an app dependency supplied either by the
app bundle or by its declared pinned browser imports.

The component receives two props:

```ts
type GUIProps<A> = {
	state: StateOf<A> | null
	client: Client<A>
}
```

Capabilities do not cross into the GUI. The client exposes the app's public edges and procedures;
the kernel continues to run declared capabilities through commands and procedures.

## Option 1: explicit helper

Add `defineReactGUI` and `GUIProps` at `@justfiles/app/react`:

```tsx
import { defineReactGUI } from '@justfiles/app/react'
import type { app } from './app'

function Counter({ state, client }) {
	return (
		<button type="button" onClick={() => void client.increment({ amount: 1 })}>
			Count: {state?.count ?? 0}
		</button>
	)
}

export const gui = defineReactGUI<typeof app>(Counter)
```

The helper owns the React root and delegates transport, state sharing, and subscriptions to
`defineGUI`. It does not add `StrictMode`; an app can put that in its component tree when wanted.

For a normal Vite app, React and React DOM bundle unless `kernelHost({ imports })` maps them to pinned
esm.sh URLs. For an App Code draft, `@justfiles/app/react` stays in the platform SDK while its bare
React imports resolve through the project's existing import map. The sysroot contains the adapter,
not React itself.

This is the first implementation because it removes the repeated lifecycle code without changing
the compiler or guessing a framework from a file extension.

## Option 2: default component export

A later step can let `gui.tsx` default-export the whole React app:

```tsx
import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'

export default function Counter({ state, client }: GUIProps<typeof app>) {
	return <button onClick={() => void client.increment({ amount: 1 })}>{state?.count ?? 0}</button>
}
```

The Vite and Devkit build paths would generate the named `gui` export by wrapping the default export
with `defineReactGUI`. A named `gui` export remains the low-level escape hatch.

Do not add a `guiAdapter` setting while React is the only supported JSX framework. If another JSX
framework needs the same default-export convention, add an explicit adapter setting then instead of
making the file extension carry two meanings.

Option 2 is deferred. It saves one explicit line but brings generated entry code back into both
build paths.

## Non-goals

- Frieren and Runner do not serve React.
- The host does not inspect component exports or mount React itself.
- The helper does not expose raw transport or capability handles.
- This work does not make the current nullable GUI state contract non-null.
