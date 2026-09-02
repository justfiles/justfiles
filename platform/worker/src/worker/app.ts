import { fileApi, storeApi } from '@justfiles/core'
import { volume } from '@justfiles/fs'
import type { ReceiverOptions } from '@justfiles/fs/peer'
import type { Store } from '@justfiles/fs/store'
import { Hono } from 'hono'

/**
 * The seam, as routes. `/store` rather than `/fs`: the wire and the storage API are the
 * same thing here, so there is one route per seam call and nothing else.
 *
 * `fileApi` is the one route beside it, for the callers that are not replicas — a
 * browser pointing an `<img>` at one path, for which a walk is a request per segment.
 * It reads through a volume and writes nothing, so it can say nothing the seam does not.
 *
 * There is no `actor`. The old wire stamped the authenticated user onto every mutation
 * because the server decided who wrote a row; a version carries its own author now, and
 * the DO is already one user's, so a name in the row would say nothing the object does
 * not already say by existing.
 */
export function createWorkerApiApp(args: { store: Store; receiver?: ReceiverOptions }) {
	const { store } = args

	return new Hono()
		.route('/store', storeApi(store, args.receiver))
		.route('/store', fileApi(volume(store)))
}

export type WorkerApiType = ReturnType<typeof createWorkerApiApp>
