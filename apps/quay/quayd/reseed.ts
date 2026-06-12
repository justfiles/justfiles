// Reseed the built-in apps into the Volume without restarting a running quayd.
//
// quayd is sticky: a client only *ensure-runs* it, so it survives native/app
// restarts and never re-seeds — `reconcileBuiltins` runs once, at boot. That means
// rebuilding an app's bundle has no effect until the daemon is killed, which is the
// wrong dev loop. This script runs the same reconcile from a throwaway process: it
// imports the freshly built bundles (a new process ⟹ no stale module cache), so
// `createHost` reinstalls every app whose bytes changed straight into the Volume.
// The live daemon serves `gui.js` fresh from the Volume on each request, so the
// change shows up the next time the window is opened — no restart, no lost windows.

import { createHost } from './host.ts'

await createHost()
console.log('quayd: reseeded built-in apps')
// createHost spins up a sandbox; force a clean exit rather than wait for handles.
process.exit(0)
