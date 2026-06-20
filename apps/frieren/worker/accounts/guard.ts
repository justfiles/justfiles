// Audit + rate-limit, re-homed from the retired per-account CLI commands onto the
// capability boundary. `guardCapability` wraps a use-facet capability so every call
// — from the agent's tools or an app, sharing one bucket — is rate-limited (per
// capability + target account) and recorded in the audit log. The write-capable
// commands these guards used to wrap are gone; only the read-only use facets remain.

import { type Capability, type CapabilityCall, CapabilityError } from '@justfiles/app/capabilities'
import type { AuditLog } from '../integrations/audit.ts'
import type { TokenBucket } from '../integrations/rate-limit.ts'

// The targeted account when a call names one (readDetail/markRead); '' for the
// fan-out calls (listUnread/listToday) that span every enabled account.
function accountIdOf(call: CapabilityCall): string {
	const arg = call.args[0] as { accountId?: unknown } | undefined
	return typeof arg?.accountId === 'string' ? arg.accountId : ''
}

export function guardCapability(
	inner: Capability,
	deps: { capability: string; audit: AuditLog; rateLimit: TokenBucket }
): Capability {
	const run = async <T>(call: CapabilityCall, exec: () => Promise<T>): Promise<T> => {
		const accountId = accountIdOf(call)
		const entry = { integrationId: deps.capability, accountId, command: call.method, argv: [] }
		if (!deps.rateLimit.take(`${deps.capability}/${accountId}`)) {
			await deps.audit.append({ ...entry, exitCode: 429 })
			throw new CapabilityError('CAPABILITY_FAILED', call.capability, call.method)
		}
		try {
			const result = await exec()
			await deps.audit.append({ ...entry, exitCode: 0 })
			return result
		} catch (error) {
			await deps.audit.append({ ...entry, exitCode: 1 })
			throw error
		}
	}
	return {
		invoke: (call) => run(call, () => inner.invoke(call)),
		subscribe: (call, emit) => run(call, () => inner.subscribe(call, emit))
	}
}
