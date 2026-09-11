import type { AgentBackend } from '@justfiles/agent'
import { type BackendDescriptor, remoteBackend } from '@justfiles/agent/remote'

export function createPlatformAi(deps: { origin: string; getToken: () => Promise<string | null> }) {
	return async (signal?: AbortSignal): Promise<AgentBackend | null> => {
		signal?.throwIfAborted()
		const token = await deps.getToken()
		signal?.throwIfAborted()
		if (!token) return null
		const response = await fetch(new URL('/api/ai/backend', deps.origin), {
			headers: { authorization: `Bearer ${token}` },
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
				: AbortSignal.timeout(15_000)
		})
		if (!response.ok)
			throw new Error(`Cloud AI is unavailable (${response.status}). Check Settings.`)
		const descriptor = (await response.json()) as BackendDescriptor
		if (descriptor.version !== 1 || !descriptor.selection || !descriptor.model?.id)
			throw new Error('Update Frieren to use cloud AI on this Mac.')
		return remoteBackend(descriptor, async (body, signal) => {
			const current = await deps.getToken()
			if (!current) throw new Error('Sign in to Just Computer in Settings.')
			return fetch(new URL('/api/ai/infer', deps.origin), {
				method: 'POST',
				headers: { authorization: `Bearer ${current}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal
			})
		})
	}
}
