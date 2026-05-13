import Type from 'typebox'
import { describe, expect, test } from 'vitest'
import { defineCommand } from '../bash/define.ts'
import { CommandRegistry } from '../bash/registry.ts'
import { integrationRoutes } from './api.ts'
import { type Integration, Integrations } from './registry.ts'
import { ConnectionStore, type KvStorage } from './storage.ts'

function memStorage(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			map.set(key, value)
		},
		async delete(key: string) {
			return map.delete(key)
		},
		async list<T>(opts?: { prefix?: string }) {
			const out = new Map<string, T>()
			for (const [key, value] of map) {
				if (!opts?.prefix || key.startsWith(opts.prefix)) {
					out.set(key, value as T)
				}
			}
			return out
		}
	}
}

function fakeFastmail(): Integration {
	return {
		id: 'fastmail',
		name: 'Fastmail',
		description: 'JMAP email',
		credentialsSchema: Type.Object({ token: Type.String() }),
		commands: (creds, { accountId }) => [
			defineCommand({
				name: accountId === 'default' ? 'email' : `email-${accountId}`,
				summary: 'email via fastmail',
				async run() {
					return {
						stdout: (creds as { token: string }).token,
						stderr: '',
						exitCode: 0
					}
				}
			})
		]
	}
}

function harness() {
	const commands = new CommandRegistry()
	const connections = new ConnectionStore(memStorage(), 'test-key')
	const integrations = new Integrations({ commands, connections })
	integrations.define(fakeFastmail())
	const app = integrationRoutes(integrations)
	return { app, integrations, commands }
}

describe('integration routes', () => {
	test('GET /api/integrations lists definitions and connection status', async () => {
		const { app } = harness()
		const res = await app.request('/api/integrations')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string; connectedAccounts: unknown[] }>
		expect(body).toHaveLength(1)
		expect(body[0]).toMatchObject({
			id: 'fastmail',
			name: 'Fastmail',
			connectedAccounts: []
		})
	})

	test('PUT registers creds, returns updated status, registers commands', async () => {
		const { app, commands } = harness()
		const res = await app.request('/api/integrations/fastmail/personal', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'static', token: 'abc' })
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { connectedAccounts: Array<{ accountId: string }> }
		expect(body.connectedAccounts).toEqual([{ accountId: 'personal' }])
		expect(commands.lookup('email-personal')).toBeDefined()
	})

	test('PUT with bad creds shape returns 400', async () => {
		const { app } = harness()
		const res = await app.request('/api/integrations/fastmail/default', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'static' })
		})
		expect(res.status).toBe(400)
	})

	test('PUT with unknown integration returns 404', async () => {
		const { app } = harness()
		const res = await app.request('/api/integrations/nope/x', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'static', token: 'abc' })
		})
		expect(res.status).toBe(404)
	})

	test('DELETE drops the connection and unregisters its commands', async () => {
		const { app, commands } = harness()
		await app.request('/api/integrations/fastmail/default', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'static', token: 'abc' })
		})
		expect(commands.lookup('email')).toBeDefined()
		const res = await app.request('/api/integrations/fastmail/default', {
			method: 'DELETE'
		})
		expect(res.status).toBe(204)
		expect(commands.lookup('email')).toBeUndefined()
	})

	test('GET reflects lastError after a failed connect', async () => {
		const commands = new CommandRegistry()
		const connections = new ConnectionStore(memStorage(), 'k')
		const integrations = new Integrations({ commands, connections })
		integrations.define({
			id: 'broken',
			name: 'Broken',
			description: 'breaks',
			credentialsSchema: Type.Object({}),
			commands() {
				throw new Error('boom')
			}
		})
		const app = integrationRoutes(integrations)
		const put = await app.request('/api/integrations/broken/default', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'static' })
		})
		expect(put.status).toBe(500)
		const get = await app.request('/api/integrations')
		const body = (await get.json()) as Array<{
			id: string
			connectedAccounts: Array<{ lastError?: string }>
		}>
		const broken = body.find((entry) => entry.id === 'broken')
		expect(broken?.connectedAccounts[0]?.lastError).toBe('boom')
	})
})
