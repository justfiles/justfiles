import { describe, expect, test } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage as memFsStorage } from '@justfiles/fs/storage/mem'
import Type from 'typebox'
import { defineCommand } from '../bash/define.ts'
import type { Command } from '../bash/registry.ts'
import { CommandRegistry } from '../bash/registry.ts'
import { AuditLog } from './audit.ts'
import { Coalescer } from './coalescer.ts'
import { TokenBucket } from './rate-limit.ts'
import { type Integration, Integrations } from './registry.ts'
import { ConnectionStore, type CredentialRecord, type KvStorage } from './storage.ts'

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

function fastmail(): Integration {
	return {
		id: 'fastmail',
		name: 'Fastmail',
		description: 'Email via JMAP',
		credentialsSchema: Type.Object({ token: Type.String() }),
		commands: (creds, { accountId }) =>
			[
				defineCommand({
					name: accountId === 'default' ? 'email' : `email-${accountId}`,
					summary: 'Email via Fastmail',
					async run() {
						return {
							stdout: `email:${(creds as { token: string }).token}:${accountId}`,
							stderr: '',
							exitCode: 0
						}
					}
				})
			] as Command[]
	}
}

function gmail(): Integration {
	return {
		id: 'gmail',
		name: 'Gmail',
		description: 'Email via Google',
		credentialsSchema: Type.Object({ accessToken: Type.String() }),
		commands: (creds, { accountId }) =>
			[
				defineCommand({
					name: accountId === 'default' ? 'email' : `email-${accountId}`,
					summary: 'Email via Gmail',
					async run() {
						return {
							stdout: `gmail:${(creds as { accessToken: string }).accessToken}`,
							stderr: '',
							exitCode: 0
						}
					}
				})
			] as Command[]
	}
}

function makeIntegrations() {
	const commands = new CommandRegistry()
	const connections = new ConnectionStore(memStorage(), 'test-key')
	const integrations = new Integrations({ commands, connections })
	return { integrations, commands, connections }
}

const staticCreds = (token: string): CredentialRecord => ({
	kind: 'static',
	static: { token }
})

describe('Integrations', () => {
	test('list reports defined integrations with disconnected status', () => {
		const { integrations } = makeIntegrations()
		integrations.define(fastmail())
		expect(integrations.list()).toEqual([
			{
				id: 'fastmail',
				name: 'Fastmail',
				description: 'Email via JMAP',
				connectedAccounts: []
			}
		])
	})

	test('connect persists creds, registers commands', async () => {
		const { integrations, commands, connections } = makeIntegrations()
		integrations.define(fastmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'default',
			creds: staticCreds('t1')
		})
		expect(commands.lookup('email')).toBeDefined()
		expect(await connections.get('fastmail', 'default')).toBeDefined()
		expect(integrations.list()[0].connectedAccounts).toEqual([{ accountId: 'default' }])
	})

	test('disconnect unregisters commands and drops the connection', async () => {
		const { integrations, commands, connections } = makeIntegrations()
		integrations.define(fastmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'default',
			creds: staticCreds('t1')
		})
		await integrations.disconnect('fastmail', 'default')
		expect(commands.lookup('email')).toBeUndefined()
		expect(await connections.get('fastmail', 'default')).toBeUndefined()
		expect(integrations.list()[0].connectedAccounts).toEqual([])
	})

	test('connecting same integration twice with different accounts registers per-account names', async () => {
		const { integrations, commands } = makeIntegrations()
		integrations.define(fastmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'personal',
			creds: staticCreds('p')
		})
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'work',
			creds: staticCreds('w')
		})
		expect(commands.lookup('email-personal')).toBeDefined()
		expect(commands.lookup('email-work')).toBeDefined()
	})

	test('two integrations with the same command name auto-disambiguate', async () => {
		const { integrations, commands } = makeIntegrations()
		integrations.define(fastmail())
		integrations.define(gmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'default',
			creds: staticCreds('a')
		})
		await integrations.connect({
			integrationId: 'gmail',
			accountId: 'default',
			creds: staticCreds('b')
		})
		expect(commands.lookup('email')).toBeDefined()
		expect(commands.lookup('email-gmail')).toBeDefined()
	})

	test('hydrate restores commands from persisted connections', async () => {
		const { integrations, connections } = makeIntegrations()
		integrations.define(fastmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'default',
			creds: staticCreds('t1')
		})

		const freshCommands = new CommandRegistry()
		const fresh = new Integrations({ commands: freshCommands, connections })
		fresh.define(fastmail())
		await fresh.hydrate()
		expect(freshCommands.lookup('email')).toBeDefined()
		expect(fresh.list()[0].connectedAccounts).toEqual([{ accountId: 'default' }])
	})

	test('factory throwing during connect stores lastError, no commands registered', async () => {
		const { integrations, commands, connections } = makeIntegrations()
		integrations.define({
			id: 'broken',
			name: 'Broken',
			description: 'Throws',
			credentialsSchema: Type.Object({}),
			commands() {
				throw new Error('boom')
			}
		})
		await expect(
			integrations.connect({
				integrationId: 'broken',
				accountId: 'default',
				creds: { kind: 'static', static: {} }
			})
		).rejects.toThrow('boom')
		expect(commands.list()).toEqual([])
		const stored = await connections.get('broken', 'default')
		expect(stored?.lastError).toBe('boom')
	})

	test('connect on undefined integration throws', async () => {
		const { integrations } = makeIntegrations()
		await expect(
			integrations.connect({
				integrationId: 'nope',
				accountId: 'default',
				creds: staticCreds('x')
			})
		).rejects.toThrow(/unknown integration/)
	})

	test('audit log records each invocation through wrapped commands', async () => {
		const kv = memStorage()
		const audit = new AuditLog(kv)
		const commands = new CommandRegistry()
		const connections = new ConnectionStore(memStorage(), 'k')
		const integrations = new Integrations({ commands, connections, audit })
		integrations.define(fastmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'default',
			creds: staticCreds('t1')
		})
		const cmd = commands.lookup('email')
		expect(cmd).toBeDefined()
		await cmd?.run([], { vol: volume(memFsStorage()) })
		const entries = await audit.list()
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			integrationId: 'fastmail',
			accountId: 'default',
			command: 'email',
			argv: [],
			exitCode: 0
		})
	})

	test('rate limit returns exit 429 once the bucket is exhausted', async () => {
		const commands = new CommandRegistry()
		const connections = new ConnectionStore(memStorage(), 'k')
		const rateLimit = new TokenBucket({ capacity: 2, windowMs: 60_000 })
		const integrations = new Integrations({ commands, connections, rateLimit })
		integrations.define(fastmail())
		await integrations.connect({
			integrationId: 'fastmail',
			accountId: 'default',
			creds: staticCreds('t1')
		})
		const cmd = commands.lookup('email')
		if (!cmd) throw new Error('email command not registered')
		const ctx = { vol: volume(memFsStorage()) }
		expect((await cmd.run([], ctx)).exitCode).toBe(0)
		expect((await cmd.run([], ctx)).exitCode).toBe(0)
		const blocked = await cmd.run([], ctx)
		expect(blocked.exitCode).toBe(429)
		expect(blocked.stderr).toContain('rate limit exceeded')
	})

	test('connect defers command-registry mutation while coalescer is busy', async () => {
		const commands = new CommandRegistry()
		const connections = new ConnectionStore(memStorage(), 'k')
		const coalescer = new Coalescer()
		const integrations = new Integrations({ commands, connections, coalescer })
		integrations.define(fastmail())

		let release: () => void = () => {}
		const work = new Promise<void>((resolve) => {
			release = resolve
		})

		const tracked = coalescer.during(async () => {
			await integrations.connect({
				integrationId: 'fastmail',
				accountId: 'default',
				creds: staticCreds('t1')
			})
			expect(commands.lookup('email')).toBeUndefined()
			await work
		})

		release()
		await tracked
		expect(commands.lookup('email')).toBeDefined()
	})

	test('list reports lastError after a failed connect', async () => {
		const { integrations } = makeIntegrations()
		integrations.define({
			id: 'broken',
			name: 'Broken',
			description: 'Throws',
			credentialsSchema: Type.Object({}),
			commands() {
				throw new Error('boom')
			}
		})
		await expect(
			integrations.connect({
				integrationId: 'broken',
				accountId: 'default',
				creds: { kind: 'static', static: {} }
			})
		).rejects.toThrow()
		const status = integrations.list().find((entry) => entry.id === 'broken')
		expect(status?.connectedAccounts[0]?.lastError).toBe('boom')
	})
})
