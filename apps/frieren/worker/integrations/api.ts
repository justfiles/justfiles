import { Hono } from 'hono'
import type { TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { Integrations } from './registry.ts'
import type { CredentialRecord } from './storage.ts'

interface PutBody {
	kind: 'static' | 'oauth'
	[k: string]: unknown
}

function toCredentialRecord(body: PutBody): CredentialRecord | { error: string } {
	if (body.kind === 'static') {
		const { kind: _kind, ...rest } = body
		return { kind: 'static', static: rest as Record<string, string> }
	}
	if (body.kind === 'oauth') {
		const { kind: _kind, ...rest } = body
		const oauth = rest as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown }
		if (typeof oauth.accessToken !== 'string') {
			return { error: 'oauth.accessToken is required' }
		}
		return {
			kind: 'oauth',
			oauth: {
				accessToken: oauth.accessToken,
				refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
				expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined
			}
		}
	}
	return { error: 'kind must be "static" or "oauth"' }
}

function validateStatic(schema: TSchema, body: PutBody): string | null {
	const { kind: _kind, ...rest } = body
	if (Check(schema, rest)) return null
	return 'creds do not match the integration schema'
}

type Source = Integrations | (() => Integrations)

function resolve(source: Source): Integrations {
	return typeof source === 'function' ? source() : source
}

export function integrationRoutes(source: Source): Hono {
	return new Hono()
		.get('/api/integrations', (c) => c.json(resolve(source).list()))
		.put('/api/integrations/:id/:accountId', async (c) => {
			const integrations = resolve(source)
			const id = c.req.param('id')
			const accountId = c.req.param('accountId')
			const def = integrations.list().find((i) => i.id === id)
			if (!def) return c.json({ error: `unknown integration: ${id}` }, 404)

			let body: PutBody
			try {
				body = (await c.req.json()) as PutBody
			} catch {
				return c.json({ error: 'invalid JSON body' }, 400)
			}

			const record = toCredentialRecord(body)
			if ('error' in record) return c.json(record, 400)

			if (record.kind === 'static') {
				const schema = integrations.schemaFor(id)
				const violation = schema && validateStatic(schema, body)
				if (violation) return c.json({ error: violation }, 400)
			}

			try {
				await integrations.connect({ integrationId: id, accountId, creds: record })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const status = integrations.list().find((i) => i.id === id)
				return c.json({ error: message, status }, 500)
			}

			const updated = integrations.list().find((i) => i.id === id)
			return c.json(updated)
		})
		.delete('/api/integrations/:id/:accountId', async (c) => {
			await resolve(source).disconnect(c.req.param('id'), c.req.param('accountId'))
			return c.body(null, 204)
		})
}
