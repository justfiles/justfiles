import { EXPRESSIONS } from '@justfiles/agent/expression'
import { expect, test } from 'vitest'
import { builtinFaces } from './builtin'

// The built-in faces are generated art (`pnpm run faces`, scripts/generate-faces.ts), and
// generated art goes stale silently: adding an emotion to EXPRESSIONS, or an archetype to the
// personalize flow, leaves the matrix a file short and the avatar quietly keeps its resting
// face for that tag. This is what notices.
//
// The variants are spelled out rather than derived: they are the archetypes the summoning
// ritual offers (AgentStep.tsx) plus the unpersonalised default, and this test is the place
// that pins those two lists to the art on disk.
const VARIANTS = ['vanilla', 'teacher', 'companion', 'assistant']

test.each(VARIANTS)('%s has art for every emotion, and a face to rest on', (variant) => {
	const { url, faces } = builtinFaces(variant)
	const missing = EXPRESSIONS.filter((expression) => !faces[expression])
	expect(missing, 'run `pnpm run faces` in apps/frieren').toEqual([])
	expect(url, 'run `pnpm run faces` in apps/frieren').toBeTruthy()
})

test('an unset or unknown variant falls back to the default', () => {
	// An empty soul, and a soul from a build that knows a variant this one does not: both have
	// to render something rather than throw or show a hole.
	const fallback = builtinFaces(undefined)
	expect(builtinFaces('a-variant-from-the-future').url).toBe(fallback.url)
	expect(fallback.url).toBe(builtinFaces('vanilla').url)
})

test('calm is not one of the faces to swap to', () => {
	// Every variant rests on its own `resting.png`, and "neutral" is not a tag the agent can
	// send any more (see @justfiles/agent/expression), so there is no art for it to ask for.
	expect(EXPRESSIONS).not.toContain('neutral')
	expect(Object.keys(builtinFaces('vanilla').faces).sort()).toEqual([...EXPRESSIONS].sort())
})
