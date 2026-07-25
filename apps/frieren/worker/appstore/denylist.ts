// The moderation lever: banned npm package names and app ids the indexer filters
// out. In-repo (so it ships with the deploy) and intentionally the ONLY
// moderation — the store promises no review, only takedown.
import type { Denylist } from './indexer.ts'

export const DENYLIST: Denylist = {
	names: ['@spud-computer/code', '@spud-computer/draw'],
	ids: []
}
