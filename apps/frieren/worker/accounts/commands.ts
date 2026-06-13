// Keeps the agent's per-account CLI commands in sync with the accounts store.
// When an account enables a capability, the provider's command factory registers
// its commands (rate-limited + audited, lifted from the old integrations
// registry); disabling or disconnecting unregisters them. `activatingStore` wraps
// the base store so connect/setEnabled/disconnect drive this with no extra wiring
// in the admin facet; `hydrate` re-activates enabled accounts on boot.

import type { Command, CommandRegistry } from '@justfiles/agent'
import type { CapabilityId } from '@justfiles/app/capabilities/accounts'
import type { Account, AccountsStore } from '@justfiles/app/capabilities/accounts/host'
import type { AuditLog } from '../integrations/audit.ts'
import type { Coalescer } from '../integrations/coalescer.ts'
import type { TokenBucket } from '../integrations/rate-limit.ts'
import type { CommandFactories } from './providers.ts'

function activeKey(accountId: string, capability: CapabilityId): string {
	return `${accountId}/${capability}`
}

export class CommandActivator {
	// `${accountId}/${capability}` → registered command names.
	private readonly active = new Map<string, string[]>()

	constructor(
		private readonly deps: {
			commands: CommandRegistry
			factories: CommandFactories
			audit?: AuditLog
			rateLimit?: TokenBucket
			coalescer?: Coalescer
		}
	) {}

	// Re-activate every enabled capability of every stored account (boot/hydrate).
	async hydrate(accounts: AccountsStore): Promise<void> {
		const all = await accounts.list()
		await this.mutate(() => {
			for (const account of all)
				for (const cap of Object.keys(account.enabled) as CapabilityId[])
					this.activate(account, cap)
		})
	}

	// Diff a store mutation: activate newly-enabled capabilities, deactivate
	// newly-disabled ones. `next === undefined` means the account was deleted.
	async reconcile(prev: Account | undefined, next: Account | undefined): Promise<void> {
		const prevCaps = new Set(Object.keys(prev?.enabled ?? {}) as CapabilityId[])
		const nextCaps = new Set(Object.keys(next?.enabled ?? {}) as CapabilityId[])
		await this.mutate(() => {
			if (prev)
				for (const cap of prevCaps) if (!nextCaps.has(cap)) this.deactivate(prev.accountId, cap)
			if (next) for (const cap of nextCaps) if (!prevCaps.has(cap)) this.activate(next, cap)
		})
	}

	private mutate(fn: () => void): Promise<void> {
		return this.deps.coalescer ? this.deps.coalescer.schedule(fn) : Promise.resolve(fn())
	}

	private activate(account: Account, capability: CapabilityId): void {
		const factory = this.deps.factories.get(account.providerId)?.[capability]
		if (!factory) return
		const names: string[] = []
		for (const cmd of factory(account.creds, account.accountId)) {
			const name = this.uniqueName(cmd.name, account.providerId)
			this.deps.commands.register(
				this.wrap({ ...cmd, name }, account.providerId, account.accountId)
			)
			names.push(name)
		}
		this.active.set(activeKey(account.accountId, capability), names)
	}

	private deactivate(accountId: string, capability: CapabilityId): void {
		const key = activeKey(accountId, capability)
		for (const name of this.active.get(key) ?? []) this.deps.commands.unregister(name)
		this.active.delete(key)
	}

	// Rate-limit + audit around a command's run, lifted from the old registry.
	private wrap(cmd: Command, providerId: string, accountId: string): Command {
		const { audit, rateLimit } = this.deps
		if (!audit && !rateLimit) return cmd
		const bucketKey = `${providerId}/${accountId}`
		const inner = cmd.run
		return {
			...cmd,
			async run(argv, ctx) {
				if (rateLimit && !rateLimit.take(bucketKey)) {
					const result = { stdout: '', stderr: 'rate limit exceeded', exitCode: 429 }
					await audit?.append({
						integrationId: providerId,
						accountId,
						command: cmd.name,
						argv,
						exitCode: result.exitCode
					})
					return result
				}
				const result = await inner(argv, ctx)
				await audit?.append({
					integrationId: providerId,
					accountId,
					command: cmd.name,
					argv,
					exitCode: result.exitCode
				})
				return result
			}
		}
	}

	private uniqueName(desired: string, providerId: string): string {
		if (!this.deps.commands.lookup(desired)) return desired
		const suffixed = `${desired}-${providerId}`
		if (!this.deps.commands.lookup(suffixed)) return suffixed
		let n = 2
		while (this.deps.commands.lookup(`${suffixed}-${n}`)) n++
		return `${suffixed}-${n}`
	}
}

// Wrap a base store so persistence + command activation co-locate, exactly as the
// old integrations registry's connect/disconnect did both.
export function activatingStore(base: AccountsStore, activator: CommandActivator): AccountsStore {
	return {
		list: base.list,
		get: base.get,
		put: async (account) => {
			const prev = await base.get(account.accountId)
			await base.put(account)
			await activator.reconcile(prev, account)
		},
		delete: async (accountId) => {
			const prev = await base.get(accountId)
			await base.delete(accountId)
			if (prev) await activator.reconcile(prev, undefined)
		}
	}
}
