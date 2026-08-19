/**
 * The typed client for the server's own protocol (`fs.ts`).
 *
 * There is nothing else here, and that is the point: the storage API and the wire are
 * the same thing in this model, so a remote store is `httpStore` in `packages/fs` and
 * needs no client library at all. What is left is the two routes that are the SERVER's
 * protocol rather than the seam's — the lineage epoch and the reset.
 */

import { hc } from 'hono/client'
import type { createFsApi } from './fs'

export type FsApiType = ReturnType<typeof createFsApi>
export type FsClient = ReturnType<typeof hc<FsApiType>>
export type FsClientHeaders = Record<string, string>

export interface FsClientOptions {
	baseUrl?: string
	headers?: FsClientHeaders | (() => FsClientHeaders | Promise<FsClientHeaders>)
	fetch?: typeof fetch
}

export function createFsClient(options: FsClientOptions = {}): FsClient {
	return hc<FsApiType>(options.baseUrl ?? '', {
		headers: options.headers,
		fetch: options.fetch
	})
}
