import { expect, test } from 'vitest'
import { decodeLabel, encodeLabel } from './id.ts'

const ids = [
	'justfiles.draw',
	'com.alice.draw',
	'nib-health.draw',
	'com.my-startup.spaced-repetition',
	// IDN domains arrive already punycoded, so they carry `--` of their own
	'de.xn--mnchen-3ya.notes',
	// the app is always the last segment: this is `tools.alice.com` + `notes`
	'com.alice.tools.notes',
	'a.b'
]

test.each(ids)('%s round-trips', (id) => {
	expect(decodeLabel(encodeLabel(id))).toBe(id)
})

test('encodes the way DNSLink does', () => {
	// the subdomain-gateway spec's own example
	expect(encodeLabel('en.wikipedia-on-ipfs.org')).toBe('en-wikipedia--on--ipfs-org')
	expect(encodeLabel('justfiles.draw')).toBe('justfiles-draw')
	expect(encodeLabel('com.alice.draw')).toBe('com-alice-draw')
	expect(encodeLabel('nib-health.draw')).toBe('nib--health-draw')
})

test('distinct ids never share a label', () => {
	const segments = ['a', 'ab', 'a-b', 'a--b']
	const all = [
		...segments.flatMap((p) => segments.map((a) => `${p}.${a}`)),
		...segments.flatMap((p) => segments.flatMap((q) => segments.map((a) => `${p}.${q}.${a}`)))
	]
	expect(new Set(all.map(encodeLabel)).size).toBe(all.length)
})

test('rejects labels that are not the canonical encoding', () => {
	// `a-.b` and `a.-b` would both want `a---b`; neither is a legal id, so the
	// label is refused rather than resolved to one of them
	expect(decodeLabel('a---b')).toBeNull()
	expect(decodeLabel('-draw')).toBeNull()
	expect(decodeLabel('draw-')).toBeNull()
	// callers lowercase the host first; an unnormalized label is not canonical
	expect(decodeLabel('Justfiles-draw')).toBeNull()
})

test('a label with no hyphen belongs to the platform', () => {
	// every id has at least two segments, so every app label has at least one
	// hyphen — `www`, `api` and `store` can never be claimed by an app
	for (const label of ['www', 'api', 'store', 'abuse']) expect(decodeLabel(label)).toBeNull()
	// and a label that decodes to a single segment is not an id either
	expect(decodeLabel('a--b')).toBeNull()
})

test('the label limit bounds the id, so the catalog must check the encoding', () => {
	const id = `com.${'a'.repeat(30)}.${'b'.repeat(30)}`
	expect(encodeLabel(id).length).toBeGreaterThan(63)
	expect(decodeLabel(encodeLabel(id))).toBeNull()
})
