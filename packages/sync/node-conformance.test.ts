import 'fake-indexeddb/auto'
import { describe, test } from 'vitest'
import { nodeSyncConformanceCases } from './node-test-harness'
import { idbStorage } from './storage/idb'
import { nodeMemStorage } from './storage/node-mem'

for (const { label, make } of [
	{ label: 'memory', make: () => nodeMemStorage() },
	{ label: 'IndexedDB', make: () => idbStorage(`node-conf-${crypto.randomUUID()}`) }
])
	describe(`node-sync conformance: ${label}`, () => {
		for (const behavior of nodeSyncConformanceCases) test(behavior.name, () => behavior.run(make))
	})
