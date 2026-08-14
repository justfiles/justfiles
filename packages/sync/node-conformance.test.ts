import { describe, test } from 'vitest'
import { nodeSyncConformanceCases } from './node-test-harness'
import { nodeMemStorage } from './storage/node-mem'

describe('node-sync conformance: memory', () => {
	for (const behavior of nodeSyncConformanceCases)
		test(behavior.name, () => behavior.run(() => nodeMemStorage()))
})
