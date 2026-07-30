import { EXPRESSIONS } from '@justfiles/agent/expression'
import { expect, test } from 'vitest'

// The built-in faces are generated art (`pnpm run faces`, scripts/generate-faces.ts), and
// generated art goes stale silently: adding an expression to EXPRESSIONS, or an archetype to
// the personalize flow, leaves the matrix a file short and the avatar quietly falls back to
// its resting face. This is what notices.
//
// Globbed rather than read off disk, because the glob is how the app resolves them too — so
// a file that exists but the bundler cannot see still fails here.
//
// The variants are spelled out rather than imported: they are the archetypes the summoning
// ritual offers (AgentStep.tsx) plus the unpersonalised default, and this test is the place
// that pins those two lists together.
const VARIANTS = ['vanilla', 'teacher', 'companion', 'assistant']

test('every variant has art for every expression', () => {
	const found = new Set(Object.keys(import.meta.glob('./faces/*/*.png')))
	const missing = VARIANTS.flatMap((variant) =>
		EXPRESSIONS.map((expression) => `./faces/${variant}/${expression}.png`).filter(
			(file) => !found.has(file)
		)
	)
	expect(missing, 'run `pnpm run faces` in apps/frieren').toEqual([])
})
