import { EXPRESSIONS } from '@justfiles/agent/expression'
import { expect, test } from 'vitest'
import { builtinFaces } from './builtin'

// The built-in faces are generated art (`pnpm run faces`, scripts/generate-faces.ts), and
// generated art goes stale silently: adding an expression to EXPRESSIONS, or an archetype to
// the personalize flow, leaves the matrix a file short and the avatar quietly falls back to
// its resting face for that tag. This is what notices.
//
// The variants are spelled out rather than derived: they are the archetypes the summoning
// ritual offers (AgentStep.tsx) plus the unpersonalised default, and this test is the place
// that pins those two lists to the art on disk.
const VARIANTS = ['vanilla', 'teacher', 'companion', 'assistant']

test.each(VARIANTS)('%s has art for every expression', (variant) => {
	const { faces } = builtinFaces(variant)
	const missing = EXPRESSIONS.filter((expression) => !faces[expression])
	expect(missing, 'run `pnpm run faces` in apps/frieren').toEqual([])
})

test('the resting face is what an unset or unknown variant falls back to', () => {
	// An empty soul, and a soul from a build that knows a variant this one does not: both have
	// to render something rather than throw or show a hole.
	const fallback = builtinFaces(undefined)
	expect(builtinFaces('a-variant-from-the-future').url).toBe(fallback.url)
	expect(fallback.url).toBe(builtinFaces('vanilla').faces.neutral)
})
