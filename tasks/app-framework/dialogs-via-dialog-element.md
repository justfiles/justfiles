---
project: packages/app, platform/frieren, platform/mac
status: todo
---

# Replace the host dialog service with the `<dialog>` element

## TL;DR

The SDK ships a host-mediated dialog service: a contract, a DOM host, a request validator in the
iframe bridge, a Frieren dialog store, and a Mac mount. It supports three fixed shapes with at most
three buttons and no input. The web platform's `<dialog>` element already provides modality, focus
trapping, Escape, `returnValue`, forms, and accessibility inside the app's own frame. Delete the
service and style `dialog` in the platform stylesheet.

## Proposed change

Breaking, SDK:

```ts
// removed exports
'@justfiles/app/dialog'        // DialogClient, DialogRequest, DialogTransport, ...
'@justfiles/app/dialog-host'   // mountDialogHost

// defineGUI
interface GUIContext<A> { readonly client: Client<A> }          // no `dialog`
mount(el, state, ctx: { transport: Transport })                 // no `dialog?: DialogTransport`

// iframe bridge
interface FrameHost { invoke; onError?; onMessage? }            // no `dialog`
// removed wire messages: 'dialog', 'dialogResult', 'dialogError'
```

Breaking, hosts: remove only the per-app path. Frieren's dialog store also serves the shell's own
dialogs (owner `null`: `systemDialog` for install and uninstall failures, mounted in
`DesktopShell`), and those have no `<dialog>` replacement because they do not originate in an app
frame. So:

- Frieren: keep `apps/dialogs.ts` and `shell/Dialog.tsx` for the system owner; delete the per-app
  owner branch, the `DialogHost` in `AppWindow`, and the `dialog` callback passed to
  `mountAppFrame`.
- Mac: remove `mountDialogHost` from the app window; it exists there only to answer app requests.
- SDK: `@justfiles/app/dialog-host` goes with the contract. Frieren's system dialog is a
  shell-local React component and does not need it.

Additive, design:

```css
/* @justfiles/design/mac.css */
:where(dialog) { /* panel: surface, rule, radius, shadow, typography */ }
:where(dialog)::backdrop { /* dim; a pseudo-element cannot sit inside :where() */ }
:where(dialog form[method="dialog"] menu) { /* button row */ }
```

Docs: one paragraph in `docs/app.md` showing `dialog.showModal()` with
`<form method="dialog">`, and that `returnValue` carries the chosen action. Note that native
`alert`/`confirm`/`prompt` stay unavailable in the sandboxed frame.

## Why

- **Offload to the standard.** Modal dialogs are a solved problem in the platform the GUI already
  runs on. Re-implementing a subset across five modules and a wire protocol is complexity with no
  capability gain, and the subset is smaller than the standard: no text input, no custom content,
  three buttons at most.
- **The window is the trust boundary the framework already has.** The service exists so the host
  can label a dialog "Asked by X". But the app frame cannot escape its window, so a dialog drawn
  inside it is already unambiguously that app's. AppKit reaches the same conclusion: sheets are
  attached to the window that asked.
- **Fewer async round trips in the GUI path.** A dialog becomes a synchronous DOM operation in the
  frame instead of a correlated request to the host and back, and the bridge has one less message
  family to validate.
- **Testability.** A dialog built from `<dialog>` is testable in plain DOM with no host fixture.
- **Indicator.** No app in the repository or in the public app set calls the service. The newest
  app's design puts sheets in local GUI state.
