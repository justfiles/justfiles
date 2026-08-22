import type { Volume } from '@justfiles/fs'
import { sha256Hex } from '@justfiles/fs/store'

type AppId = string

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function text(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

type StateSnapshot = {
	value: unknown
	hash: string | null
}

type StateCommit = {
	seq: number
	changed: boolean
}

// App state has one source of truth: `/state/<id>.json` in the volume. A
// transaction reads a snapshot and commits only if that snapshot is still
// current. The kernel retries a stale transaction with the new state.
interface StateStore {
	read(appId: AppId): Promise<StateSnapshot>
	commit(appId: AppId, expectedHash: string | null, next: unknown): Promise<StateCommit | null>
	seq(appId: AppId): number
	drop(appId: AppId): Promise<void>
}

export function stateStore(fs: Volume): StateStore {
	const seqs = new Map<AppId, number>()
	return { read, commit, seq, drop }

	async function read(appId: AppId): Promise<StateSnapshot> {
		const statePath = `/state/${appId}.json`
		try {
			const data = await fs.readFile(statePath)
			return { value: JSON.parse(text(data)), hash: await sha256Hex(data) }
		} catch (error) {
			if (error instanceof Error && error.message === `ENOENT: ${statePath}`)
				return { value: undefined, hash: null }
			throw error
		}
	}

	async function commit(
		appId: AppId,
		expectedHash: string | null,
		next: unknown
	): Promise<StateCommit | null> {
		const data = bytes(JSON.stringify(next))
		if ((await sha256Hex(data)) === expectedHash) return { seq: seq(appId), changed: false }

		const statePath = `/state/${appId}.json`
		await fs.mkdir('/state', { recursive: true })
		try {
			await fs.writeFile(statePath, data, { ifHash: expectedHash })
		} catch (error) {
			if (error instanceof Error && error.message === `ESTALE: ${statePath}`) return null
			throw error
		}

		const nextSeq = seq(appId) + 1
		seqs.set(appId, nextSeq)
		return { seq: nextSeq, changed: true }
	}

	function seq(appId: AppId): number {
		return seqs.get(appId) ?? 0
	}

	async function drop(appId: AppId): Promise<void> {
		await fs.rm(`/state/${appId}.json`, { force: true })
	}
}
