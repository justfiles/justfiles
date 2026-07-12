/**
 * Runs the backend conformance suite (`pathSyncConformanceCases`, in
 * `sync-test-harness.ts`) under vitest for the backends reachable in Node:
 *   - `memStorage`  — implements the path-sync seams.
 *   - `idbStorage`  — pending until it implements `caps.journal` / `caps.pathApply`
 *     / `caps.content` + local-mutation journaling. It CONSTRUCTS fine (via
 *     `fake-indexeddb`), so these fail for the right reason (`not implemented`) and
 *     pass when the backend lands.
 *
 * `sqlite` runs the SAME cases under vitest via `node:sqlite`; see
 * `packages/core/src/storage.sqlite.conformance.test.ts`.
 *
 * `fake-indexeddb/auto` MUST be imported before `storage.idb` (its module-load
 * `IDBKeyRange` capture reads the global), so it is the first import here.
 */

import 'fake-indexeddb/auto'
import { describe, test } from 'vitest'
import { idbStorage } from './storage.idb'
import { memStorage } from './storage.mem'
import type { BackendFactory } from './sync-test-harness'
import { pathSyncConformanceCases } from './sync-test-harness'

const backends: { label: string; make: BackendFactory }[] = [
	{ label: 'memStorage', make: (opts) => memStorage(opts) },
	{ label: 'idbStorage', make: () => idbStorage(`conf-${crypto.randomUUID()}`) }
]

for (const { label, make } of backends) {
	describe(`path-sync conformance: ${label}`, () => {
		for (const c of pathSyncConformanceCases) {
			test(c.name, () => c.run(make))
		}
	})
}
