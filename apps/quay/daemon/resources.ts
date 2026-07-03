// The one place that knows the daemon's dev vs. shipped layout. In DEV the daemon runs from
// the source tree (`bun --watch daemon/main.ts`); SHIPPED it's a self-contained Bun exe at
// Quay.app/Contents/MacOS/quay-daemon with resources flat under ../Resources. build-exe.ts
// injects QUAY_SHIPPED into the standalone so paths resolve next to the exe rather than the
// bunfs root, and each use site (main.ts CLIENT_DIR, materialize.ts BUILD_DIR, toolchain.ts
// WORKER_SPEC) branches on SHIPPED for its own path.
//
// Unlike quayd, the daemon serves its browser surfaces from Vite (ui/dist/client), so it
// needs none of quayd's assets/docs/design roots here — just SHIPPED and the builtins root.

import { dirname, join } from 'node:path'

export const SHIPPED = process.env.QUAY_SHIPPED === '1'

// Shipped: Contents/MacOS/quay-daemon -> ../Resources/builtins. Dev: the daemon source dir
// (unused — builtins.ts resolves each app's package dist dir directly in dev).
const ROOT = SHIPPED ? join(dirname(process.execPath), '..', 'Resources') : import.meta.dirname
export const BUILTINS_DIR = join(ROOT, 'builtins')
