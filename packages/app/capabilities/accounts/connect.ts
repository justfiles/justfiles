import { CapabilityError } from '../error.ts'
import type { ConnectRef, ConnectState, SignInPrompt } from './contract.ts'
import type { AcquiredAccount, Provider } from './provider.ts'

type Attempt = {
	state: ConnectState
	abort: AbortController
}

export function connections(deps: {
	providers: Map<string, Provider>
	save(providerId: string, account: AcquiredAccount, signal: AbortSignal): Promise<void>
	waitUntil?: (work: Promise<unknown>) => void
}) {
	const attempts = new Map<string, Attempt>()
	const invalid = () => new CapabilityError('CAPABILITY_INVALID_INPUT', 'accounts', 'connect')
	const get = (ref: ConnectRef): Attempt | undefined => {
		const attempt = attempts.get(ref.operationId)
		if (attempt && attempt.state.providerId !== ref.providerId) throw invalid()
		return attempt
	}
	const expired = (ref: ConnectRef): ConnectState => ({ ...ref, status: 'expired', expiresAt: 0 })

	return {
		async beginConnect(ref: ConnectRef): Promise<ConnectState> {
			if (!/^[a-zA-Z0-9-]{1,80}$/.test(ref.operationId)) throw invalid()
			for (const [id, attempt] of attempts) {
				if (attempt.state.expiresAt <= Date.now()) {
					attempt.abort.abort()
					attempts.delete(id)
				}
			}
			const existing = get(ref)
			if (existing) return existing.state
			const provider = deps.providers.get(ref.providerId)
			if (provider?.auth.ui.kind !== 'interactive') throw invalid()
			if (attempts.size >= 16) throw new Error('Too many sign-in attempts. Try again later.')
			for (const attempt of attempts.values()) {
				if (attempt.state.providerId === ref.providerId && attempt.state.status === 'pending') {
					attempt.state = { ...attempt.state, status: 'cancelled' }
					attempt.abort.abort()
				}
			}
			const abort = new AbortController()
			const expiresAt = Date.now() + 15 * 60_000
			const attempt: Attempt = { state: { ...ref, status: 'pending', expiresAt }, abort }
			attempts.set(ref.operationId, attempt)
			const timer = setTimeout(() => {
				attempt.state = { ...ref, status: 'expired', expiresAt }
				abort.abort()
			}, expiresAt - Date.now())
			abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
			const notify = (prompt: SignInPrompt) => {
				if (!abort.signal.aborted) attempt.state = { ...ref, status: 'pending', expiresAt, prompt }
			}
			const work = Promise.resolve()
				.then(() => provider.auth.acquire({ scopes: [], signal: abort.signal, notify }))
				.then(async (account) => {
					abort.signal.throwIfAborted()
					await deps.save(ref.providerId, account, abort.signal)
					attempt.state = { ...ref, status: 'connected', expiresAt, accountId: account.accountId }
				})
				.catch(() => {
					if (!abort.signal.aborted) {
						attempt.state = {
							...ref,
							status: 'failed',
							expiresAt,
							message: 'Sign-in failed. Please try again.'
						}
					}
				})
				.finally(() => clearTimeout(timer))
			deps.waitUntil?.(work)
			return attempt.state
		},
		async readConnect(ref: ConnectRef): Promise<ConnectState> {
			return get(ref)?.state ?? expired(ref)
		},
		async cancelConnect(ref: ConnectRef): Promise<void> {
			const attempt = get(ref)
			if (attempt?.state.status !== 'pending') return
			attempt.state = { ...ref, status: 'cancelled', expiresAt: attempt.state.expiresAt }
			attempt.abort.abort()
		}
	}
}
