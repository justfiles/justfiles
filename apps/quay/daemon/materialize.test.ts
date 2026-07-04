import { expect, test } from 'vitest'
import { type ProjectionApp, projectionSignature } from './materialize'

// projectionSignature is the reconcile's whole change-detection story: a bundle is
// rewritten (re-signed, re-registered) only when its signature differs from the marker on
// disk, so every field that must trigger a refresh has to move the signature, and nothing
// else may. These lock in exactly that — the skip-unchanged path and each rebuild trigger.

const base: ProjectionApp = { id: 'app.x', name: 'X', version: '1', iconPath: 'icon.png' }
const withIcon = (bytes: number[]): ProjectionApp => ({ ...base, iconBytes: new Uint8Array(bytes) })

test('identical inputs produce an identical signature (the skip-unchanged path)', () => {
	expect(projectionSignature(base, 100)).toBe(projectionSignature(base, 100))
	expect(projectionSignature(withIcon([1, 2, 3]), 100)).toBe(
		projectionSignature(withIcon([1, 2, 3]), 100)
	)
})

test('a rename refreshes the bundle', () => {
	expect(projectionSignature(base, 100)).not.toBe(projectionSignature({ ...base, name: 'Y' }, 100))
})

test('a version bump refreshes the bundle', () => {
	expect(projectionSignature(base, 100)).not.toBe(
		projectionSignature({ ...base, version: '2' }, 100)
	)
})

test('a different app id has a distinct signature', () => {
	expect(projectionSignature(base, 100)).not.toBe(
		projectionSignature({ ...base, id: 'app.y' }, 100)
	)
})

test('a new booter binary (mtime) refreshes every bundle', () => {
	// build.sh drops a fresh shell → every projected bundle must be rewritten.
	expect(projectionSignature(base, 100)).not.toBe(projectionSignature(base, 200))
})

test('icon bytes changing refreshes the bundle', () => {
	expect(projectionSignature(withIcon([1]), 100)).not.toBe(projectionSignature(withIcon([2]), 100))
})

test('the icon source path changing refreshes the bundle (same bytes)', () => {
	expect(projectionSignature(withIcon([1, 2, 3]), 100)).not.toBe(
		projectionSignature({ ...withIcon([1, 2, 3]), iconPath: 'other.png' }, 100)
	)
})

test('gaining an icon refreshes the bundle; a bundle with no icon ignores its path', () => {
	// No iconBytes ⟹ the icon signature is omitted, so iconPath alone never moves it.
	expect(projectionSignature(base, 100)).toBe(
		projectionSignature({ ...base, iconPath: 'whatever.png' }, 100)
	)
	// Adding bytes does move it.
	expect(projectionSignature(base, 100)).not.toBe(projectionSignature(withIcon([9]), 100))
})
