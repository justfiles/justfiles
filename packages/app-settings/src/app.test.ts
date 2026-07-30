import type { AccountInfo } from '@justfiles/app/capabilities/settings'
import { expect, test } from 'vitest'
import { app, hasBothOrigins, initialState, originKind } from './app.ts'

// Reducer-level, no DOM (AGENTS.md): the reducer's own fold + the pure origin
// helpers the GUI keys off, driven directly through `app.dispatch` — the same
// seam `app-notes/src/app.test.ts` uses.

const cloudAccount: AccountInfo = {
	accountId: 'g@gmail.com',
	providerId: 'google',
	enabled: [],
	config: {},
	origin: { kind: 'cloud' }
}
const deviceAccount: AccountInfo = {
	accountId: 'chatgpt',
	providerId: 'chatgpt',
	enabled: ['ai'],
	config: {},
	origin: { kind: 'device', label: 'This Mac' }
}
// An older host that hasn't deployed `origin` yet.
const noOriginAccount: AccountInfo = {
	accountId: 'u@me.com',
	providerId: 'icloud',
	enabled: ['calendar'],
	config: {}
}

test('accountsLoaded folds a listAccounts payload into state, origin intact', async () => {
	const { state } = await app.dispatch(
		{ type: '__cmd/accountsLoaded', params: { ok: true, value: [cloudAccount, deviceAccount] } },
		{ state: initialState }
	)
	expect(state?.accounts).toEqual([cloudAccount, deviceAccount])
})

test('originKind degrades an absent origin to cloud rather than crashing', () => {
	expect(originKind(cloudAccount)).toBe('cloud')
	expect(originKind(deviceAccount)).toBe('device')
	expect(originKind(noOriginAccount)).toBe('cloud')
})

test('hasBothOrigins is true only once the list spans both lanes', () => {
	expect(hasBothOrigins([])).toBe(false)
	expect(hasBothOrigins([cloudAccount])).toBe(false)
	expect(hasBothOrigins([deviceAccount])).toBe(false)
	expect(hasBothOrigins([cloudAccount, deviceAccount])).toBe(true)
	// An account with no `origin` degrades to 'cloud', same as a real cloud account.
	expect(hasBothOrigins([noOriginAccount, deviceAccount])).toBe(true)
	expect(hasBothOrigins([noOriginAccount, cloudAccount])).toBe(false)
})
