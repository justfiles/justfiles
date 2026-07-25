import { memStorage, type Volume, volume } from '@justfiles/fs'
import { beforeEach, describe, expect, test } from 'vitest'
import { withDeclaredScopes } from './declared-scopes.ts'
import type { CapabilityCall } from './types.ts'

const enc = new TextEncoder()

async function installManifest(fs: Volume, appId: string, capabilities: unknown) {
	await fs.mkdir(`/applications/${appId}`, { recursive: true })
	await fs.writeFile(
		`/applications/${appId}/manifest.json`,
		enc.encode(JSON.stringify({ id: appId, name: appId, app: 'app.js', capabilities }))
	)
}

// A recording inner backend so a test can see the scopes the wrapper attached.
function recorder() {
	const calls: CapabilityCall[] = []
	return {
		calls,
		caps: {
			invoke: async (call: CapabilityCall) => {
				calls.push(call)
				return null
			},
			subscribe: async () => () => {}
		}
	}
}

const wireCall = (appId: string, capability: string): CapabilityCall => ({
	appId,
	capability,
	method: 'generateText',
	args: [{}],
	scopes: ['forged'] // whatever the client claimed — the wrapper must overwrite it
})

describe('withDeclaredScopes', () => {
	let fs: Volume
	beforeEach(() => {
		fs = volume(memStorage())
	})

	test('re-resolves trusted scopes from the manifest, ignoring wire-supplied ones', async () => {
		await installManifest(fs, 'app.x', { ai: { id: 'ai', scopes: ['context:learning'] } })
		const rec = recorder()
		await withDeclaredScopes(fs, rec.caps).invoke(wireCall('app.x', 'ai'))
		expect(rec.calls[0]?.scopes).toEqual(['context:learning'])
	})

	test('an app that declares the capability without the scope gets an empty scope list', async () => {
		await installManifest(fs, 'app.x', { ai: { id: 'ai', scopes: [] } })
		const rec = recorder()
		await withDeclaredScopes(fs, rec.caps).invoke(wireCall('app.x', 'ai'))
		expect(rec.calls[0]?.scopes).toEqual([])
	})

	test('matches by resolved id across local names and unions their scopes', async () => {
		await installManifest(fs, 'app.x', {
			myAi: { id: 'ai', scopes: ['context:learning'] },
			other: { id: 'volume', scopes: [] }
		})
		const rec = recorder()
		await withDeclaredScopes(fs, rec.caps).invoke(wireCall('app.x', 'ai'))
		expect(rec.calls[0]?.scopes).toEqual(['context:learning'])
	})

	test('no manifest / undeclared capability resolves to empty', async () => {
		const rec = recorder()
		await withDeclaredScopes(fs, rec.caps).invoke(wireCall('ghost', 'ai'))
		await installManifest(fs, 'app.x', { volume: { id: 'volume', scopes: [] } })
		await withDeclaredScopes(fs, rec.caps).invoke(wireCall('app.x', 'ai'))
		expect(rec.calls[0]?.scopes).toEqual([])
		expect(rec.calls[1]?.scopes).toEqual([])
	})
})
