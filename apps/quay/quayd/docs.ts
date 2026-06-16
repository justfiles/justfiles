// The agent's project docs on quay — just the byte reader. The docs ship beside the
// daemon: the `assets` build step (build-assets.ts) copies docs/*.md into
// assets-dist/docs/, so this resolves with no repo at runtime — the same ship-at-build,
// read-at-runtime rail as the vendor bundles (assets.ts). WHICH docs the agent surfaces
// is the shared, hand-maintained DOCS catalogue in @justfiles/agent; this only supplies
// the bytes. A missing file means the `assets` task hasn't run.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// import.meta.dirname is apps/quay/quayd; docs are built into assets-dist/docs (gitignored).
const DOCS_DIR = join(import.meta.dirname, 'assets-dist', 'docs')

export function readDoc(id: string): Promise<string> {
	return readFile(join(DOCS_DIR, `${id}.md`), 'utf8')
}
