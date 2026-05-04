import type { TSchema } from 'typebox'
import type { Command, CommandRegistry } from '../bash/registry.ts'
import type { AuditLog } from './audit.ts'
import type { Coalescer } from './coalescer.ts'
import type { TokenBucket } from './rate-limit.ts'
import type { ConnectionStore, CredentialRecord } from './storage.ts'

export interface IntegrationContext {
	accountId: string
}

export interface Integration {
	id: string
	name: string
	description: string
	credentialsSchema: TSchema
	commands?: (creds: unknown, ctx: IntegrationContext) => Command[]
}

export interface IntegrationStatus {
	id: string
	name: string
	description: string
	connectedAccounts: ReadonlyArray<{ accountId: string; lastError?: string }>
}

export interface ConnectInput {
	integrationId: string
	accountId: string
	creds: CredentialRecord
}

interface ActiveConnection {
	integrationId: string
	accountId: string
	registeredNames: string[]
	lastError?: string
}

function connectionKey(integrationId: string, accountId: string): string {
	return `${integrationId}/${accountId}`
}

function unwrap(creds: CredentialRecord): unknown {
	return creds.kind === 'static' ? creds.static : creds.oauth
}

export class Integrations {
	private readonly definitions = new Map<string, Integration>()
	private readonly active = new Map<string, ActiveConnection>()

	constructor(
		private readonly deps: {
			commands: CommandRegistry
			connections: ConnectionStore
			audit?: AuditLog
			rateLimit?: TokenBucket
			coalescer?: Coalescer
		}
	) {}

	private async mutateCommands(fn: () => void): Promise<void> {
		const { coalescer } = this.deps
		if (coalescer) {
			await coalescer.schedule(fn)
			return
		}
		fn()
	}

	define(integration: Integration): void {
		if (this.definitions.has(integration.id)) {
			throw new Error(`Integration ${integration.id} already defined`)
		}
		this.definitions.set(integration.id, integration)
	}

	schemaFor(integrationId: string): TSchema | undefined {
		return this.definitions.get(integrationId)?.credentialsSchema
	}

	list(): IntegrationStatus[] {
		return [...this.definitions.values()].map((def) => ({
			id: def.id,
			name: def.name,
			description: def.description,
			connectedAccounts: [...this.active.values()]
				.filter((c) => c.integrationId === def.id)
				.map((c) => ({ accountId: c.accountId, lastError: c.lastError }))
		}))
	}

	async connect(input: ConnectInput): Promise<void> {
		const def = this.definitions.get(input.integrationId)
		if (!def) throw new Error(`unknown integration: ${input.integrationId}`)
		await this.deps.connections.put({
			integrationId: input.integrationId,
			accountId: input.accountId,
			creds: input.creds
		})
		let activationError: unknown
		await this.mutateCommands(() => {
			try {
				const names = this.activate(def, input.accountId, input.creds)
				this.active.set(connectionKey(input.integrationId, input.accountId), {
					integrationId: input.integrationId,
					accountId: input.accountId,
					registeredNames: names
				})
			} catch (error) {
				activationError = error
				const message = error instanceof Error ? error.message : String(error)
				this.active.set(connectionKey(input.integrationId, input.accountId), {
					integrationId: input.integrationId,
					accountId: input.accountId,
					registeredNames: [],
					lastError: message
				})
			}
		})
		if (activationError) {
			const message =
				activationError instanceof Error ? activationError.message : String(activationError)
			await this.deps.connections.setLastError(input.integrationId, input.accountId, message)
			throw activationError
		}
		await this.deps.connections.setLastError(input.integrationId, input.accountId, undefined)
	}

	async disconnect(integrationId: string, accountId: string): Promise<void> {
		const key = connectionKey(integrationId, accountId)
		const active = this.active.get(key)
		if (active) {
			await this.mutateCommands(() => {
				for (const name of active.registeredNames) this.deps.commands.unregister(name)
				this.active.delete(key)
			})
		}
		await this.deps.connections.delete(integrationId, accountId)
	}

	async hydrate(): Promise<void> {
		const records = await this.deps.connections.list()
		for (const record of records) {
			const def = this.definitions.get(record.integrationId)
			if (!def) continue
			try {
				const names = this.activate(def, record.accountId, record.creds)
				this.active.set(connectionKey(record.integrationId, record.accountId), {
					integrationId: record.integrationId,
					accountId: record.accountId,
					registeredNames: names,
					lastError: record.lastError
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				this.active.set(connectionKey(record.integrationId, record.accountId), {
					integrationId: record.integrationId,
					accountId: record.accountId,
					registeredNames: [],
					lastError: message
				})
				await this.deps.connections.setLastError(record.integrationId, record.accountId, message)
			}
		}
	}

	private activate(def: Integration, accountId: string, creds: CredentialRecord): string[] {
		if (!def.commands) return []
		const produced = def.commands(unwrap(creds), { accountId })
		const registered: string[] = []
		for (const cmd of produced) {
			const name = this.uniqueName(cmd.name, def.id)
			const wrapped = this.wrap({ ...cmd, name }, def.id, accountId)
			this.deps.commands.register(wrapped)
			registered.push(name)
		}
		return registered
	}

	private wrap(cmd: Command, integrationId: string, accountId: string): Command {
		const { audit, rateLimit } = this.deps
		if (!audit && !rateLimit) return cmd
		const bucketKey = `${integrationId}/${accountId}`
		const inner = cmd.run
		return {
			...cmd,
			async run(argv, ctx) {
				if (rateLimit && !rateLimit.take(bucketKey)) {
					const result = { stdout: '', stderr: 'rate limit exceeded', exitCode: 429 }
					await audit?.append({
						integrationId,
						accountId,
						command: cmd.name,
						argv,
						exitCode: result.exitCode
					})
					return result
				}
				const result = await inner(argv, ctx)
				await audit?.append({
					integrationId,
					accountId,
					command: cmd.name,
					argv,
					exitCode: result.exitCode
				})
				return result
			}
		}
	}

	private uniqueName(desired: string, integrationId: string): string {
		if (!this.deps.commands.lookup(desired)) return desired
		const suffixed = `${desired}-${integrationId}`
		if (!this.deps.commands.lookup(suffixed)) return suffixed
		let n = 2
		while (this.deps.commands.lookup(`${suffixed}-${n}`)) n++
		return `${suffixed}-${n}`
	}
}
