import { GENERATED_IMAGES_DIR } from '@justfiles/app/capabilities/image'
import { describe, expect, test } from 'vitest'
import * as paths from './paths.ts'
import FILESYSTEM from './prompts/filesystem.md?raw'

// The anti-drift test: `prompts/filesystem.md` TELLS the agent the layout that paths.ts
// SPELLS for the code. A rename in one without the other is the bug this catches — the
// prose is not documentation, it is the agent's map.
describe('paths', () => {
	// A path is named in the map only when the agent has no other way to reach what is
	// there. Content already in the prompt (see `absent` below) is not one of those ways —
	// core.md/user.md are named as WRITE targets, which is why they appear here.
	const named: [string, string][] = [
		['NOTES_DIR', paths.NOTES_DIR],
		['PICTURES_DIR', paths.PICTURES_DIR],
		['PROFILE', paths.PROFILE],
		['MEMORY', paths.MEMORY],
		['DAILY_DIR', paths.DAILY_DIR],
		['CONTEXT_DIR', paths.CONTEXT_DIR],
		['sessionsDir()', paths.sessionsDir()],
		...paths.SECRET_PREFIXES.map((p, i): [string, string] => [`SECRET_PREFIXES[${i}]`, p])
	]

	// Deliberately UNnamed: a path the agent would only use to duplicate a mechanism it
	// already has. The soul IS the head of the system prompt, and a skill's body comes from
	// `read_skill` (which also reaches built-in skills, that have no Volume path at all).
	// Naming either would invite a `cat` that is strictly worse than what it already has.
	const absent: [string, string][] = [
		['soul()', paths.soul()],
		['SKILLS_DIR', paths.SKILLS_DIR]
	]

	test.for(named)('the prompt names %s', ([, path]) => {
		expect(FILESYSTEM).toContain(path)
	})

	test.for(absent)('the prompt does NOT name %s', ([, path]) => {
		expect(FILESYSTEM).not.toContain(path)
	})

	test('pictures is the image capability’s output dir', () => {
		expect(paths.PICTURES_DIR).toBe(GENERATED_IMAGES_DIR)
	})

	// The host's own store is joined at exactly one name, so the deny-list is one entry.
	// `/.state` was the old engine's bookkeeping lane and has no reader left: a cursor
	// lives in the host's slot now, not in the user's tree.
	test('SECRET_PREFIXES is the one mounted name', () => {
		expect([...paths.SECRET_PREFIXES]).toEqual(['/private'])
	})

	test('a session shard sorts chronologically and names its session and its device', () => {
		const at = new Date('2026-07-26T09:12:34.567Z')
		expect(paths.sessionShard('main', 'a1b2c3d4', at, 'dev01234')).toBe(
			'/system/agents/main/sessions/2026-07-26T09-12-34Z-a1b2c3d4.dev01234.jsonl'
		)
		const later = paths.sessionShard('main', 'zzzzzzzz', new Date('2026-07-26T10:00:00.000Z'), 'd')
		expect([later, paths.sessionShard('main', 'a1b2c3d4', at, 'd')].sort()[0]).toBe(
			paths.sessionShard('main', 'a1b2c3d4', at, 'd')
		)
	})

	// Every shard of one conversation must group under the SAME name, on every device, or
	// merge-on-read has nothing to merge. So the stamp has to survive a round trip: parse a
	// shard name, hand the Date back to the writer, get the identical name.
	test('a shard name round-trips through the parser', () => {
		const name = '2026-07-26T09-12-34Z-a1b2c3d4.dev01234.jsonl'
		const parsed = paths.parseSessionShard(name)
		expect(parsed).toEqual({
			startTs: new Date('2026-07-26T09:12:34Z'),
			sessionId: 'a1b2c3d4',
			deviceId: 'dev01234'
		})
		expect(paths.sessionShard('main', 'a1b2c3d4', parsed?.startTs as Date, 'dev01234')).toBe(
			`${paths.sessionsDir('main')}/${name}`
		)
	})

	// No migration (#284 §8's precedent): both older shapes are read as a device-less shard,
	// so nothing already on disk becomes invisible when `sessions.json` goes away. The
	// pre-timestamp shape has no start to report — null, not epoch, so the reader can date it
	// from the conversation instead of inventing 1970.
	test.for([
		['2026-07-26T09-12-34Z-a1b2c3d4.jsonl', new Date('2026-07-26T09:12:34Z'), 'a1b2c3d4'],
		['abcd1234.jsonl', null, 'abcd1234']
	] as const)('parses the legacy name %s', ([name, startTs, sessionId]) => {
		expect(paths.parseSessionShard(name)).toEqual({ startTs, sessionId, deviceId: null })
	})

	test.for([
		'sessions.json',
		'notes.md',
		'',
		'a.b.c.jsonl'
	])('%s is not a session shard', (name) => {
		expect(paths.parseSessionShard(name)).toBeNull()
	})
})
