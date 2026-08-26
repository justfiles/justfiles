import { expect, test } from 'vitest'
import type { AgentSessionOptions } from './session.ts'
import { createAgentSessions } from './sessions.ts'

test('builds the main session once on first use', () => {
	let builds = 0
	const sessions = createAgentSessions({
		volume: {} as AgentSessionOptions['volume'],
		get backend() {
			builds++
			return {} as AgentSessionOptions['backend']
		}
	})

	expect(builds).toBe(0)
	const main = sessions.main()
	expect(builds).toBe(1)
	expect(sessions.main()).toBe(main)
	expect(builds).toBe(1)
})
