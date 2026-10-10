---
project: packages/app
status: todo
---

# Make GUI state non-nullable

## TL;DR

`defineGUI` and `defineReactGUI` type state as `State | null`, so every GUI writes
`state?.count ?? 0` and some import the reducer's `initialState` into the GUI bundle to default
it. The kernel already defines current state as persisted-or-init and every host seeds the frame
from `kernel.state()`. The null never happens in practice. Tighten the type and remove the
fallbacks.

## Proposed change

Breaking at the type level only:

```ts
// browser.ts
interface GUISpec<A> {
	mount(el: HTMLElement, state: GUIState<A>, ctx: GUIContext<A>): GUIInstance<GUIState<A>>
}
interface GUIInstance<State> { update(state: State): void | Promise<void>; unmount(): ... }

// react.ts
interface GUIProps<A> extends GUIContext<A> { readonly state: GUIState<A> }

// kernel.ts — document the existing guarantee
state(appId): Promise<unknown>   // persisted state, or the bundle's init; never undefined

// app-controller.ts
AppInspection.state: unknown      // no `?? null`
// inspect() stops catching kernel.state() rejections into `undefined`. A reducer
// that cannot load is an error the caller must see, not an inspection with a hole
// where the state should be; the agent's `app inspect` prints the failure.
```

Host contract, written down in `docs/app.md`: a host mounts a GUI only with a value obtained from
`kernel.state()` or a state push, never with `undefined` and never with a sentinel of its own. The
guarantee is "never missing", not "never null": `State` is unconstrained, so an app whose own state
type includes `null` can legitimately persist and receive `null`, and `GUIState<A>` then includes
it because the app said so. What this task removes is the framework's extra `| null`, which the
app did not declare and which no host ever produces.

Docs: drop the "state is nullable" paragraphs from the README, `docs/app.md`, and the authoring
skill. Templates lose `state?.count ?? 0` in favour of `state.count`.

## Why

- **A type should admit only states the system produces.** The kernel is the single owner of
  "current state" and it already answers with init when nothing is persisted. A nullable type at
  the GUI boundary describes a situation the kernel never creates, and every consumer pays for it.
- **Defaults belong in one place.** With a nullable state, each GUI invents its own default, and it
  drifts from `init`. Some GUIs fix this by importing `initialState` from `app.ts`, which pulls the
  reducer and its validator into `gui.js`. The framework's own type is what pushed them there.
- **Smaller templates and docs.** The first thing an author sees in the counter template is a
  nullable guard it will never need. Removing it shortens every example and removes a paragraph of
  explanation from three documents.
- **Robustness.** A GUI that renders a default on `null` hides a host bug where the snapshot was
  never delivered. Failing loudly on an impossible value is better than quietly rendering an
  empty app.
