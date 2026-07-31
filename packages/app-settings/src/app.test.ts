import type { AccountInfo } from '@justfiles/app/capabilities/settings'
import { expect, test } from 'vitest'
import { app, hasBothOrigins, initialState, isBound, nameInSoul, originKind } from './app.ts'

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

// ── the agent pane ────────────────────────────────────────────────────────

const seededSoul = {
	name: 'Kodama',
	gender: null,
	archetype: 'assistant',
	avatarVariant: null,
	body: 'You are Kodama, a calm and capable companion.',
	seeded: true
}
const boundSoul = {
	name: 'Fern',
	gender: 'female' as const,
	archetype: 'companion',
	avatarVariant: 'companion',
	body: 'You are Fern, a companion who walks beside the user.',
	seeded: false
}

test('a seeded soul reads as unbound, a written one as bound', async () => {
	const { state } = await app.dispatch(
		{ type: '__cmd/soulLoaded', params: { ok: true, value: seededSoul } },
		{ state: initialState }
	)
	expect(isBound(state?.soul ?? null)).toBe(false)
	const next = await app.dispatch(
		{ type: '__cmd/soulLoaded', params: { ok: true, value: boundSoul } },
		{ state: state ?? initialState }
	)
	expect(isBound(next.state?.soul ?? null)).toBe(true)
})

test('generate → keep: the proposal is held, then the write clears it', async () => {
	const start = { ...initialState, soul: seededSoul }
	// The request marks the draft in flight BY TOKEN — the only way the GUI sees a model
	// call progress, and the only way an answer can be matched to the question.
	const asked = await app.dispatch(
		{ type: 'draftStarted', params: { token: 'draft-1' } },
		{ state: start }
	)
	expect(asked.state).toMatchObject({ draft: 'draft-1', proposal: null })
	const drafted = await app.dispatch(
		{
			type: 'draftSettled',
			params: { token: 'draft-1', soul: { body: 'You are Fern.', firstWords: 'I am here.' } }
		},
		{ state: asked.state ?? start }
	)
	expect(drafted.state).toMatchObject({
		draft: null,
		proposal: { body: 'You are Fern.', firstWords: 'I am here.' }
	})
	// Nothing was written by drafting: the volume-backed soul is still the seeded one.
	expect(drafted.state?.soul).toEqual(seededSoul)
	// Keeping it is a write, and the write is what drops the proposal.
	const kept = await app.dispatch(
		{ type: 'discardProposal', params: {} },
		{ state: drafted.state ?? start }
	)
	expect(kept.state?.proposal).toBeNull()
})

test('a failed generate leaves an error and an editable pane, not a half-written soul', async () => {
	const start = { ...initialState, soul: seededSoul, draft: 'draft-1' }
	const { state } = await app.dispatch(
		{ type: 'draftSettled', params: { token: 'draft-1', error: 'upstream 500' } },
		{ state: start }
	)
	expect(state).toMatchObject({ draft: null, proposal: null, error: 'upstream 500' })
	expect(state?.soul).toEqual(seededSoul)
	// Still offered: a transient failure is worth retrying.
	expect(state?.canGenerate).toBe(true)
})

test('a host with no generator stops offering one instead of showing a dead button', async () => {
	const { state } = await app.dispatch(
		{ type: 'draftSettled', params: { token: 'draft-1', error: 'CAPABILITY_UNAVAILABLE' } },
		{ state: { ...initialState, draft: 'draft-1' } }
	)
	expect(state?.canGenerate).toBe(false)
	expect(state?.error).toContain('write the soul yourself')
})

test('a GUI starting drops the markers a stopped host left behind', async () => {
	// The token names a request this GUI never made — left standing it shows "Writing…"
	// forever. `canGenerate: false` may be another device's answer entirely: this state
	// replicates. And a proposal has outlived the draft that asked for it. Only a GUI
	// START means all three: switching panes must not.
	const stranded = {
		...initialState,
		draft: 'draft-1',
		canGenerate: false,
		proposal: { body: 'You are Fern.', firstWords: 'I am here.' }
	}
	const { state } = await app.dispatch({ type: 'guiStarted', params: {} }, { state: stranded })
	expect(state).toMatchObject({ draft: null, canGenerate: true, proposal: null })
})

test('a draft is folded only by the request that asked for it', async () => {
	// The GUI that asked is gone (`guiStarted` cleared the token), so this prose — written
	// for a name and nature that went with it — must not surface on the character sheet of
	// a still-bound agent, one click away from being saved.
	const orphaned = await app.dispatch(
		{ type: 'draftSettled', params: { token: 'draft-1', soul: { body: 'You are someone else.' } } },
		{ state: { ...initialState, soul: boundSoul, draft: null } }
	)
	expect(orphaned.state?.proposal).toBeNull()

	// And the sharper case: the GUI that replaced it has a request of its OWN in flight, so
	// a boolean "something is generating" would have accepted the old answer as the new
	// one's. The token is what tells them apart — the live request still lands.
	const superseded = await app.dispatch(
		{ type: 'draftSettled', params: { token: 'draft-1', soul: { body: 'You are someone else.' } } },
		{ state: { ...initialState, soul: boundSoul, draft: 'draft-2' } }
	)
	expect(superseded.state).toMatchObject({ proposal: null, draft: 'draft-2' })
	const landed = await app.dispatch(
		{ type: 'draftSettled', params: { token: 'draft-2', soul: { body: 'You are Fern, still.' } } },
		{ state: superseded.state ?? initialState }
	)
	expect(landed.state).toMatchObject({
		draft: null,
		proposal: { body: 'You are Fern, still.' }
	})
})

test('offline says so and keeps the generator, unlike a host that has none', async () => {
	const { state } = await app.dispatch(
		{ type: 'draftSettled', params: { token: 'draft-1', error: 'CAPABILITY_OFFLINE' } },
		{ state: { ...initialState, draft: 'draft-1' } }
	)
	// Transient: the buttons stay. The soul is a file, so writing it works offline.
	expect(state?.canGenerate).toBe(true)
	expect(state?.error).toContain('No connection')
})

test('a fresh account list re-probes generation, so turning on a provider brings it back', async () => {
	const { state } = await app.dispatch(
		{ type: '__cmd/accountsLoaded', params: { ok: true, value: [deviceAccount] } },
		{ state: { ...initialState, canGenerate: false } }
	)
	expect(state).toMatchObject({ canGenerate: true, accounts: [deviceAccount] })
})

test('an avatar write moves state, so a face that changed alone still reaches the pane', async () => {
	// The soul is untouched by writing a photo: without the revision the state after the
	// write is identical, the kernel emits no update, and the pane keeps its old face.
	const start = { ...initialState, soul: boundSoul }
	const { state } = await app.dispatch({ type: 'avatarChanged', params: {} }, { state: start })
	expect(state?.avatarRevision).toBe(1)
	expect(state?.soul).toEqual(boundSoul)
})

test('usage being unavailable hides the meters but never the pane that holds the profile', async () => {
	const { state } = await app.dispatch(
		{
			type: '__cmd/usageLoaded',
			params: { ok: false, error: { message: 'CAPABILITY_UNAVAILABLE' } }
		},
		{ state: { ...initialState, category: 'account' } }
	)
	expect(state).toMatchObject({ usageAvailable: false, category: 'account' })
})

test('nameInSoul spots the one drift a rename can cause, and nothing else', () => {
	expect(nameInSoul(boundSoul)).toBe('Fern')
	// Renamed in the frontmatter, not in the prose.
	expect(nameInSoul({ ...boundSoul, name: 'Frieren' })).toBe('Fern')
	// Hand-written prose that opens some other way is not "drifted" — it is just prose.
	expect(nameInSoul({ ...boundSoul, body: 'Speak plainly, always.' })).toBeNull()
	expect(nameInSoul(null)).toBeNull()
})
