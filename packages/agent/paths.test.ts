import { GENERATED_IMAGES_DIR } from '@justfiles/app/capabilities/image'
import { describe, expect, test } from 'vitest'
import * as paths from './paths.ts'
import FILESYSTEM from './prompts/filesystem.md?raw'

// The anti-drift test: `prompts/filesystem.md` TELLS the agent the layout that paths.ts
// SPELLS for the code. A rename in one without the other is the bug this catches — the
// prose is not documentation, it is the agent's map.
describe('paths', () => {
	const named: [string, string][] = [
		['NOTES_DIR', paths.NOTES_DIR],
		['PICTURES_DIR', paths.PICTURES_DIR],
		['PROFILE', paths.PROFILE],
		['MEMORY', paths.MEMORY],
		['DAILY_DIR', paths.DAILY_DIR],
		['SKILLS_DIR', paths.SKILLS_DIR],
		['CONTEXT_DIR', paths.CONTEXT_DIR],
		['soul()', paths.soul()],
		['sessionsDir()', paths.sessionsDir()],
		...paths.SECRET_PREFIXES.map((p, i): [string, string] => [`SECRET_PREFIXES[${i}]`, p])
	]

	test.for(named)('the prompt names %s', ([, path]) => {
		expect(FILESYSTEM).toContain(path)
	})

	test('pictures is the image capability’s output dir', () => {
		expect(paths.PICTURES_DIR).toBe(GENERATED_IMAGES_DIR)
	})

	test('a session file sorts chronologically and carries its id', () => {
		const at = new Date('2026-07-26T09:12:34.567Z')
		expect(paths.sessionFile('main', 'a1b2c3d4', at)).toBe(
			'/system/agents/main/sessions/2026-07-26T09-12-34Z-a1b2c3d4.jsonl'
		)
		const later = paths.sessionFile('main', 'zzzzzzzz', new Date('2026-07-26T10:00:00.000Z'))
		expect([later, paths.sessionFile('main', 'a1b2c3d4', at)].sort()[0]).toBe(
			paths.sessionFile('main', 'a1b2c3d4', at)
		)
	})
})
