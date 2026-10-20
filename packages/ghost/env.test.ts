import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { getOrThrow } from '@earendil-works/pi-durable/env'
import { registerEnvConformance } from '@earendil-works/pi-durable/testing'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, it } from 'vitest'
import { volumeEnv } from './env.ts'

/**
 * A recursive Volume watch reports structure, not content, so an edit to a file below a
 * recursive target goes unreported. Nothing in the ghost watches yet.
 */
const SKIPPED = new Set([
	'watch follows directories created together with their contents',
	'watch keeps watching a path whose parent is renamed and recreated',
	'watch follows a directory replaced at the same path'
])

registerEnvConformance(
	{
		describe,
		expect,
		it: (name, test, timeoutMs) =>
			SKIPPED.has(name) ? it.skip(name, test) : it(name, test, timeoutMs)
	},
	'volumeEnv',
	async (use) => {
		const vol = volume(memStore())
		await vol.mkdir('/work')
		const env = volumeEnv(vol)
		await use(env.at('/work'))
		await env.close()
	}
)

describe('volumeEnv exec', () => {
	it('spills output past the thresholds to a Volume file', async () => {
		const env = volumeEnv(volume(memStore()))
		const shell = env.at('/')
		const spill = { afterBytes: 1000, afterLines: 3 }

		const short = getOrThrow(await shell.exec('seq 1 3', { spill }, BACKGROUND_CONTEXT))
		const long = getOrThrow(await shell.exec('seq 1 5', { spill }, BACKGROUND_CONTEXT))

		expect(short.spillPath).toBeUndefined()
		const path = long.spillPath ?? ''
		expect(path).toMatch(/^\/tmp\/.*pi-output-.*\.log$/)
		expect(getOrThrow(await shell.readTextFile(path, BACKGROUND_CONTEXT))).toBe('1\n2\n3\n4\n5\n')
		await env.close()
	})
})
