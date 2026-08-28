// The one place that knows the daemon's dev vs. shipped layout. In DEV the daemon runs from
// the source tree (`bun --watch daemon/main.ts`); SHIPPED it's a self-contained Bun exe at
// Just Computer.app/Contents/MacOS/daemon with resources flat under ../Resources. build-exe.ts
// injects FRIEREN_SHIPPED into the standalone so paths resolve next to the exe rather than the
// bunfs root, and each use site (main.ts CLIENT_DIR, materialize.ts BUILD_DIR, toolchain.ts
// WORKER_SPEC) branches on SHIPPED for its own path.
//
// The daemon serves its browser surfaces from Vite (ui/dist/client), so it needs no
// assets/design roots here — just SHIPPED and the agent docs root.

import { dirname, join } from 'node:path'

export const SHIPPED = process.env.FRIEREN_SHIPPED === '1'

const ROOT = SHIPPED ? join(dirname(process.execPath), '..', 'Resources') : import.meta.dirname

// The agent's project docs — the @justfiles/agent DOCS catalogue points at repo-root
// docs/*.md, which the `read_doc` tool loads by id. Shipped: copied flat under
// Resources/docs (build.sh --ship-daemon). Dev: read straight from the repo root
// (daemon/ -> platform/mac -> apps -> repo root).
export const DOCS_DIR = SHIPPED
	? join(ROOT, 'docs')
	: join(import.meta.dirname, '..', '..', '..', 'docs')
