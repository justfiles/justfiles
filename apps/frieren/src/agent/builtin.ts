import { EXPRESSIONS, type Expression } from '@justfiles/agent/expression'

// The built-in face sets: art baked by scripts/generate-faces.ts, one set per archetype the
// summoning ritual offers plus the default a user who never personalised is wearing.
//
// This is what makes `hash === null` mean "built-in art" rather than "no art". The volume
// stores the CHOICE — a word in the soul's frontmatter — and never the bytes, so picking an
// archetype costs no storage, no sync, and nothing from the image engine: worker/faces.ts is
// only ever asked about art we have never seen, which is an uploaded photo.
//
// Globbed, so a variant is a folder and there is no second list to keep in step.
const FILES = import.meta.glob<string>('./faces/*/*.png', {
	query: '?url',
	import: 'default',
	eager: true
})

// The face a variant rests on: calm is not an emotion the agent tags (see
// @justfiles/agent/expression), so it is a file of its own rather than a member of the set.
const RESTING = 'resting'
const DEFAULT = 'vanilla'

type FaceSet = { url?: string; faces: Partial<Record<Expression, string>> }
const SETS: Record<string, FaceSet> = {}
for (const [file, url] of Object.entries(FILES)) {
	const match = /^\.\/faces\/([^/]+)\/(.+)\.png$/.exec(file)
	if (!match) continue
	SETS[match[1]] ??= { faces: {} }
	const set = SETS[match[1]]
	const expression = EXPRESSIONS.find((name) => name === match[2])
	if (expression) set.faces[expression] = url
	else if (match[2] === RESTING) set.url = url
}

/**
 * The built-in art for a variant: the face it rests on, plus the set to swap through as the
 * agent tags an emotion. An unknown variant — a soul written by a newer build, or a
 * hand-edited one — falls back to the default rather than to no face at all.
 */
export function builtinFaces(variant: string | undefined): {
	url: string
	faces: Partial<Record<Expression, string>>
} {
	const set = (variant ? SETS[variant] : undefined) ?? SETS[DEFAULT]
	if (!set?.url) throw new Error('no built-in faces — run `pnpm run faces` in apps/frieren')
	return { url: set.url, faces: set.faces }
}
