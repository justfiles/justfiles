---
project: packages/app
status: todo
---

# Make the React adapter sufficient for real apps

## TL;DR

`defineReactGUI` exists so a React GUI is one function. Most React apps bypass it and hand-roll
`createRoot` plus `<StrictMode>` because the adapter does not enable StrictMode. An adapter that
the first real app has to abandon is not an adapter. Enable StrictMode by default.

## Proposed change

Additive, SDK (`react.ts`):

```ts
export function defineReactGUI<A>(
	Component: (props: GUIProps<A>) => ReactNode,
	options?: { strict?: boolean }    // default true
)
```

The adapter wraps the component in `<StrictMode>` unless `strict: false`. Templates and docs keep
using `defineReactGUI`; the hand-rolled mount pattern leaves `docs/app.md`.

## Why

- **An adapter must cover the default case.** StrictMode is what every new React app should run
  under during development. If the adapter omits it, the first conscientious author rewrites the
  mount, and the adapter becomes dead weight the docs still advertise.
- **One mount lifecycle.** The adapter is also where a future change to the mount contract lands
  once. Every hand-rolled mount is a place that change has to be repeated.
- **Indicator.** Six of eight React apps in the public set mount React themselves for this reason.
