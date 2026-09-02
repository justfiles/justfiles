/**
 * HTTP client for the leased peer protocol above the raw store wire.
 */

import { decodeNode, encodeNode, type HttpStoreOptions } from './http'
import { BootstrapRequiredError, type LeasedPeer, type WriteLease } from './lease'
import { ForeignCursorError, type Guard, GuardError, type Node, type Page } from './store'

export type LeasedRemote = LeasedPeer

export function leasedHttpStore(baseUrl: string, opts: HttpStoreOptions = {}): LeasedRemote {
	const base = baseUrl.replace(/\/+$/, '')
	const send = opts.fetch ?? ((url, init) => fetch(url, init))

	const call = async (path: string, init?: Init): Promise<Response> => {
		const headers: Record<string, string> = { ...opts.headers }
		if (init?.type !== undefined) headers['content-type'] = init.type
		if (init?.lease !== undefined) headers['x-write-lease'] = init.lease
		const res = await send(base + path, {
			method: init?.method,
			body: init?.body,
			headers,
			cache: 'no-store'
		})
		if (res.status === 428) throw new BootstrapRequiredError()
		if (res.status === 409) throw new GuardError(await refusal(res))
		if (res.status === 410) throw new ForeignCursorError()
		return res
	}

	const answer = async (path: string, init?: Init): Promise<unknown> => {
		const res = await call(path, init)
		if (!res.ok) throw await failed(res, init?.method, path)
		return res.status === 204 ? null : res.json()
	}

	return {
		get: async (id) => nodeOrNull(await answer(`/node/${encodeURIComponent(id)}`)),
		child: async (parent, name) => nodeOrNull(await answer(`/child?${query({ parent, name })}`)),
		children: async (parent, cursor) =>
			page(await answer(`/children?${query({ parent, cursor })}`)),
		since: async (cursor) => page(await answer(`/since?${query({ cursor })}`)),
		blobs: {
			async has(hash) {
				const path = `/blob/${encodeURIComponent(hash)}`
				const res = await call(path, { method: 'HEAD' })
				if (res.status === 404) return false
				if (!res.ok) throw await failed(res, 'HEAD', path)
				return true
			},
			get: async (hash) => {
				const res = await call(`/blob/${encodeURIComponent(hash)}`)
				if (res.status === 404) return null
				if (!res.ok) throw await failed(res, 'GET', `/blob/${hash}`)
				return new Uint8Array(await res.arrayBuffer())
			}
		},
		async open(saved) {
			const body = await answer('/open', {
				method: 'POST',
				body: JSON.stringify({ cursor: saved }),
				type: 'application/json'
			})
			return (body as { lease: WriteLease }).lease
		},
		async put(lease, hash, data) {
			await answer(`/blob/${encodeURIComponent(hash)}`, {
				method: 'PUT',
				body: new Uint8Array(data).buffer,
				type: 'application/octet-stream',
				lease
			})
		},
		async commit(lease, writes, guards) {
			const body = JSON.stringify({ writes: writes.map(encodeNode), guards })
			await answer('/commit', { method: 'POST', body, type: 'application/json', lease })
		}
	}
}

type Init = { method?: string; body?: string | ArrayBuffer; type?: string; lease?: WriteLease }

const query = (params: Record<string, string | undefined>): string =>
	Object.entries(params)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
		.join('&')

const nodeOrNull = (value: unknown): Node | null => (value === null ? null : decodeNode(value))

const page = (value: unknown): Page => {
	const got = value as { nodes: unknown[]; next?: string }
	const nodes = got.nodes.map(decodeNode)
	return got.next === undefined ? { nodes } : { nodes, next: got.next }
}

const refusal = async (res: Response): Promise<Guard | string> => {
	const body = (await res.json().catch(() => null)) as { reason?: Guard | string } | null
	return body?.reason ?? 'the peer refused the commit without naming a guard'
}

const failed = async (res: Response, method: string | undefined, path: string): Promise<Error> =>
	new Error(
		`store: ${method ?? 'GET'} ${path} answered ${res.status} ${(await res.text()).slice(0, 200)}`
	)
