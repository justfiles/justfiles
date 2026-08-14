import { ROOT_NODE_ID } from '@justfiles/sync/node'
import { nodeMemStorage } from '@justfiles/sync/storage/node-mem'
import { expect, test } from 'vitest'
import { createWorkerApiApp } from './app'

test('the filesystem host stamps the authenticated user as operation origin', async () => {
	const app = createWorkerApiApp({ fs: nodeMemStorage() })
	const response = await app.request('/fs/node/operations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-user-id': 'verified-user' },
		body: JSON.stringify({
			operations: [
				{
					operationId: 'create-docs',
					mutations: [
						{
							kind: 'create',
							nodeId: 'docs-id',
							parentId: ROOT_NODE_ID,
							name: 'docs',
							baseRevision: 0,
							revision: 1,
							meta: { type: 1, mode: 0o755, mtimeNs: '0', size: '0' }
						}
					]
				}
			]
		})
	})

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		results: [{ status: 'accepted', operation: { origin: 'verified-user' } }]
	})
})
