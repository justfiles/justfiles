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

// The face a variant rests on, and the one shown when the agent has tagged nothing yet.
const RESTING: Expression = 'neutral'
const DEFAULT = 'vanilla'

const SETS: Record<string, Partial<Record<Expression, string>>> = {}
for (const [file, url] of Object.entries(FILES)) {
	const match = /^\.\/faces\/([^/]+)\/(.+)\.png$/.exec(file)
	const expression = EXPRESSIONS.find((name) => name === match?.[2])
	if (!match || !expression) continue
	const variant = match[1]
	SETS[variant] = { ...SETS[variant], [expression]: url }
}

/**
 * The built-in art for a variant: the resting face to show, plus the set to swap through as
 * the agent tags an expression. An unknown variant — a soul written by a newer build, or a
 * hand-edited one — falls back to the default rather than to no face at all.
 */
export function builtinFaces(variant: string | undefined): {
	url: string
	faces: Partial<Record<Expression, string>>
} {
	const faces = (variant ? SETS[variant] : undefined) ?? SETS[DEFAULT] ?? {}
	const url = faces[RESTING]
	if (!url) throw new Error('no built-in faces — run `pnpm run faces` in apps/frieren')
	return { url, faces }
}
