// Public-surface guard: forces a deliberate decision (and a code-review
// conversation) before any new export sneaks into `@justfiles/app`. Update
// the allowlist intentionally when adding a contract — never to silence a
// test failure.

import { expect, test } from 'bun:test'
import * as pkg from './index.js'

const ALLOWLIST = [
	'APP_PERMISSIONS',
	'APP_RPC_ERROR',
	'APP_RPC_PERMISSION',
	'FORMAT_VERSION',
	'ManifestSchema',
	'PermissionSchema'
] as const

test('public exports stay within the curated allowlist', () => {
	expect(Object.keys(pkg).sort()).toEqual([...ALLOWLIST].sort())
})
