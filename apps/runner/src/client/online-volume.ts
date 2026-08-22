import { type Capability, type CapabilityCall, CapabilityError } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import type { Volume } from '@justfiles/fs'

export function onlineVolumeCapability(
	fs: Volume,
	appId: string,
	approvedScopes: readonly (readonly string[])[]
): Capability {
	const host = volumeCapability(fs, { systemAllowlist: ['justfiles.files'] })
	const approved = new Set(approvedScopes.map(stableScopes))
	const check = (call: CapabilityCall): void => {
		if (
			call.appId !== appId ||
			call.capability !== 'volume' ||
			call.scopes.some((scope) => scope.startsWith('/')) ||
			!approved.has(stableScopes(call.scopes))
		)
			throw unavailable(call.method)
	}

	return {
		invoke: async (call) => {
			check(call)
			return host.invoke(call)
		},
		subscribe: async (call, emit) => {
			check(call)
			if (call.method === 'watch') throw unavailable(call.method)
			return host.subscribe(call, emit)
		}
	}
}

const stableScopes = (scopes: readonly string[]): string =>
	JSON.stringify([...new Set(scopes)].sort())

const unavailable = (method: string): CapabilityError =>
	new CapabilityError('CAPABILITY_UNAVAILABLE', 'volume', method)
