import type { CapabilityDecl } from '@justfiles/app/runtime'
import { hashSecret } from './secret'

export type Resource = 'ai' | 'volume:app' | 'volume:system'

export interface AppAccess {
	hash: string
	resources: Resource[]
}

export async function appAccess(
	appId: string,
	capabilities: CapabilityDecl | undefined
): Promise<AppAccess> {
	const entries = [...new Set(Object.values(capabilities ?? {}).map(stableCapability))].sort()
	const resources = new Set<Resource>()

	for (const entry of entries) {
		const capability = JSON.parse(entry) as { id: string; scopes: string[] }
		if (capability.id === 'ai') {
			if (capability.scopes.length) throw new Error('Runner cannot grant this AI scope')
			resources.add('ai')
		}
		if (capability.id === 'volume') addVolume(resources, appId, capability.scopes)
	}

	return {
		hash: await hashSecret(JSON.stringify(entries)),
		resources: [...resources].sort()
	}
}

const stableCapability = ({ id, scopes }: { id: string; scopes: string[] }): string =>
	JSON.stringify({ id, scopes: [...new Set(scopes)].sort() })

function addVolume(resources: Set<Resource>, appId: string, scopes: string[]): void {
	if (scopes.length === 0 || (scopes.length === 1 && scopes[0] === 'app')) {
		if (!resources.has('volume:system')) resources.add('volume:app')
		return
	}
	if (appId === 'justfiles.files' && scopes.length === 1 && scopes[0] === 'system') {
		resources.delete('volume:app')
		resources.add('volume:system')
		return
	}
	throw new Error('Runner cannot grant this volume scope')
}
