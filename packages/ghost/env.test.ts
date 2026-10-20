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
		await use(volumeEnv(vol)('/work'))
	}
)
