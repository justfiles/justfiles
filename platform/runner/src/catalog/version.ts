/**
 * Turning a git tag into a version, and ordering the results.
 *
 * Pure, and deliberately separate: it is the only part of release resolution
 * that can be wrong without a network call, and the only part worth a test.
 */

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/

/**
 * `v6.9` → `6.9.0`, and null for a tag that is not a version at all.
 *
 * Normalising instead of demanding exact semver is what deletes Obsidian's
 * steady stream of failed submissions, and defaulting the missing components to
 * zero rather than skipping the tag is what stops an app silently resolving a
 * rung lower than it should.
 */
export function parseVersion(tag: string): string | null {
	const m = VERSION.exec(tag)
	return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}${m[4] ?? ''}` : null
}

/** The same, where the tag *is* the release and there is no lower rung to fall to. */
export function version(tag: string): string {
	const v = parseVersion(tag)
	// A monorepo's latest release can belong to another package — `create-vite@…`
	// on `vitejs/vite`. Naming that release is impossible, so it surfaces here.
	if (!v) throw new Error(`tag ${tag}: not a version`)
	return v
}

/**
 * Semver ordering, as much of it as tags need: the numeric triple, and a
 * prerelease below the release it precedes. Prerelease identifiers compare as
 * strings, which differs from semver on numeric ones (`rc.9` against `rc.10`) —
 * an ordering no catalog app has produced.
 */
export function compare(a: string, b: string): number {
	const [ac = '', ap = ''] = a.split('-', 2)
	const [bc = '', bp = ''] = b.split('-', 2)
	const an = ac.split('.').map(Number)
	const bn = bc.split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		const d = (an[i] ?? 0) - (bn[i] ?? 0)
		if (d) return d
	}
	if (!ap !== !bp) return ap ? -1 : 1
	return ap < bp ? -1 : ap > bp ? 1 : 0
}
