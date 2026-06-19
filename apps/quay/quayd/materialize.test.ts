import { expect, test } from 'vitest'
import { projectionSignature } from './materialize.ts'

test('projection signature changes when icon bytes change', () => {
	const base = { id: 'app.x', name: 'X', version: '1', iconPath: 'icon.png' }

	expect(projectionSignature({ ...base, iconBytes: new Uint8Array([1]) }, 1)).not.toBe(
		projectionSignature({ ...base, iconBytes: new Uint8Array([2]) }, 1)
	)
})
