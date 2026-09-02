import { persistedState } from './persistedState'
import type { Cursor } from './store'
import type { Volume } from './volume'

export type RelationshipState = {
	remoteId?: string
	pull?: Cursor
	push?: Cursor
	discard?: boolean
}

export type PrivateSyncState = {
	peerId(): Promise<string>
	cursor(name: 'pull' | 'push'): {
		load(): Promise<Cursor | undefined>
		save(cursor: Cursor | undefined): Promise<void>
		identify(peerId: string): Promise<void>
	}
	discard: {
		load(): Promise<boolean>
		save(unfinished: boolean): Promise<void>
	}
	remoteId: {
		load(): Promise<string | undefined>
		save(id: string | undefined): Promise<void>
	}
}

/** Host-only identity and relationship state, rooted outside the shared store. */
export function privateSyncState(
	vol: Volume,
	root = '/private/state',
	initial: { peerId?: string; relationship?: RelationshipState } = {}
): PrivateSyncState {
	const identity = persistedState<string>(
		vol,
		`${root}/clientid`,
		initial.peerId ?? (() => crypto.randomUUID())
	)
	const relationship = persistedState<RelationshipState>(
		vol,
		`${root}/sync.json`,
		initial.relationship ?? {}
	)
	let updating: Promise<unknown> = Promise.resolve()
	const update = (partial: Partial<RelationshipState>): Promise<void> => {
		const next = updating.then(() => relationship.patch(partial))
		updating = next.catch(() => undefined)
		return next
	}
	const current = async (): Promise<RelationshipState> => {
		await updating
		return relationship.get()
	}
	const field = <K extends keyof RelationshipState>(name: K) => ({
		load: async () => (await current())[name],
		save: async (value: RelationshipState[K]) => update({ [name]: value })
	})

	return {
		peerId: () => identity.get(),
		cursor: (name) => ({
			...field(name),
			identify: (remoteId) => update({ remoteId })
		}),
		discard: {
			load: async () => (await current()).discard === true,
			save: (discard) => update({ discard })
		},
		remoteId: field('remoteId')
	}
}
