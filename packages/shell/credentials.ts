import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore
} from '@earendil-works/pi-ai'
import type { Volume } from '@justfiles/fs'

type Credentials = Record<string, Credential>

/**
 * pi-ai's credentials, one per provider, in one JSON file at `path` on `volume`. One daemon
 * per machine owns the file, so serializing writes in this process is the whole lock.
 */
export function volumeCredentials(volume: Volume, path: string): CredentialStore {
	let last: Promise<unknown> = Promise.resolve()
	const serialized = <T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> => {
		const turn = last.then(() => {
			options?.signal?.throwIfAborted()
			return fn()
		})
		last = turn.catch(() => {})
		return turn
	}

	const load = async (): Promise<Credentials> => {
		try {
			return JSON.parse(new TextDecoder().decode(await volume.readFile(path)))
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('ENOENT')) return {}
			throw error
		}
	}
	// An overwrite is not atomic on a Volume; a rename over the old file is.
	const save = async (credentials: Credentials) => {
		const temp = `${path}.tmp`
		await volume.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
		await volume.writeFile(temp, new TextEncoder().encode(`${JSON.stringify(credentials)}\n`))
		await volume.chmod(temp, 0o600)
		await volume.rename(temp, path)
	}

	return {
		async read(providerId) {
			return (await load())[providerId]
		},
		async list() {
			return Object.entries(await load()).map(
				([providerId, credential]): CredentialInfo => ({ providerId, type: credential.type })
			)
		},
		modify(providerId, fn, options) {
			return serialized(async () => {
				const credentials = await load()
				const next = await fn(credentials[providerId])
				if (next === undefined) return credentials[providerId]
				await save({ ...credentials, [providerId]: next })
				return next
			}, options)
		},
		delete(providerId, options) {
			return serialized(async () => {
				const { [providerId]: removed, ...rest } = await load()
				if (removed !== undefined) await save(rest)
			}, options)
		}
	}
}
