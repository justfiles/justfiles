import type {
	AuditEvent,
	BrokerHooks,
	CalendarCapability,
	Capabilities,
	CapabilityError,
	CapabilityName,
	CapabilityResult,
	EmailCapability,
	ProviderAdapters,
	SandboxContext,
	VolumeCapability
} from './contracts.ts'

const DEFAULT_ACCOUNT = 'default'

export function createCapabilities(
	ctx: SandboxContext,
	adapters: ProviderAdapters,
	hooks: BrokerHooks = {}
): Capabilities {
	const now = hooks.now ?? (() => Date.now())

	async function emit(
		capability: CapabilityName,
		accountId: string | undefined,
		result: CapabilityResult<unknown>
	): Promise<void> {
		if (!hooks.audit) return
		const event: AuditEvent = {
			ts: now(),
			userId: ctx.userId,
			appId: ctx.appId,
			capability,
			accountId,
			ok: result.ok,
			errorCode: result.ok ? undefined : result.error.code
		}
		await hooks.audit(event)
	}

	async function guard<T>(
		capability: CapabilityName,
		accountId: string | undefined,
		run: () => Promise<CapabilityResult<T>>
	): Promise<CapabilityResult<T>> {
		const grantCheck = checkGrant(ctx, capability, accountId)
		if (!grantCheck.ok) {
			await emit(capability, accountId, grantCheck)
			return grantCheck
		}
		const result = await run()
		await emit(capability, accountId, result)
		return result
	}

	const email: EmailCapability = {
		async listUnread(input) {
			return guard('email.read.unread', input.accountId, async () => {
				const adapter = pickEmailAdapter(adapters, input.accountId)
				if (!adapter.ok) return adapter
				return wrapProvider(() =>
					adapter.value.listUnread({ since: input.since, limit: input.limit })
				)
			})
		},
		async readDetail(input) {
			return guard('email.read.detail', input.accountId, async () => {
				const adapter = pickEmailAdapter(adapters, input.accountId)
				if (!adapter.ok) return adapter
				return wrapProvider(() => adapter.value.readDetail({ id: input.id }))
			})
		},
		async markRead(input) {
			return guard('email.markRead', input.accountId, async () => {
				const adapter = pickEmailAdapter(adapters, input.accountId)
				if (!adapter.ok) return adapter
				return wrapProvider(async () => {
					await adapter.value.markRead({ id: input.id })
					return { success: true } as const
				})
			})
		}
	}

	const calendar: CalendarCapability = {
		async listToday(input) {
			return guard('calendar.read.today', input.accountId, async () => {
				const adapter = pickCalendarAdapter(adapters, input.accountId)
				if (!adapter.ok) return adapter
				return wrapProvider(() =>
					adapter.value.listToday({ timezone: input.timezone, now: input.now })
				)
			})
		}
	}

	const volume: VolumeCapability = {
		async readFile(input) {
			return guard('volume.read', undefined, async () => {
				if (!adapters.volume) return notConfigured('volume')
				return wrapProvider(async () => ({ data: await adapters.volume!.readFile(input) }))
			})
		},
		async writeFile(input) {
			return guard('volume.write', undefined, async () => {
				if (!adapters.volume) return notConfigured('volume')
				return wrapProvider(async () => {
					await adapters.volume!.writeFile(input)
					return { success: true } as const
				})
			})
		}
	}

	return { email, calendar, volume }
}

export function checkGrant(
	ctx: SandboxContext,
	name: CapabilityName,
	accountId: string | undefined
): CapabilityResult<true> {
	for (const grant of ctx.grants) {
		if (grant.name !== name) continue
		// Grants without accountId match any account; otherwise require exact match.
		if (grant.accountId !== undefined && grant.accountId !== accountId) continue
		return { ok: true, value: true }
	}
	return {
		ok: false,
		error: {
			code: 'CAPABILITY_DENIED',
			message: accountId
				? `capability ${name} is not granted for account ${accountId}`
				: `capability ${name} is not granted`
		}
	}
}

function pickEmailAdapter(
	adapters: ProviderAdapters,
	accountId: string | undefined
): CapabilityResult<
	NonNullable<ProviderAdapters['email']> extends ReadonlyMap<string, infer V> ? V : never
> {
	const map = adapters.email
	if (!map || map.size === 0) return notConfigured('email')
	const id = accountId ?? (map.size === 1 ? map.keys().next().value : DEFAULT_ACCOUNT)
	const adapter = id ? map.get(id) : undefined
	if (!adapter) {
		return {
			ok: false,
			error: { code: 'ACCOUNT_NOT_CONFIGURED', message: `email account "${id}" is not configured` }
		}
	}
	return { ok: true, value: adapter }
}

function pickCalendarAdapter(
	adapters: ProviderAdapters,
	accountId: string | undefined
): CapabilityResult<
	NonNullable<ProviderAdapters['calendar']> extends ReadonlyMap<string, infer V> ? V : never
> {
	const map = adapters.calendar
	if (!map || map.size === 0) return notConfigured('calendar')
	const id = accountId ?? (map.size === 1 ? map.keys().next().value : DEFAULT_ACCOUNT)
	const adapter = id ? map.get(id) : undefined
	if (!adapter) {
		return {
			ok: false,
			error: {
				code: 'ACCOUNT_NOT_CONFIGURED',
				message: `calendar account "${id}" is not configured`
			}
		}
	}
	return { ok: true, value: adapter }
}

function notConfigured(kind: string): CapabilityResult<never> {
	return {
		ok: false,
		error: { code: 'ACCOUNT_NOT_CONFIGURED', message: `no ${kind} provider configured` }
	}
}

async function wrapProvider<T>(run: () => Promise<T>): Promise<CapabilityResult<T>> {
	try {
		return { ok: true, value: await run() }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { ok: false, error: { code: 'PROVIDER_ERROR', message } satisfies CapabilityError }
	}
}
