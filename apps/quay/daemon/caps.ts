import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { getVolume } from './fs'

const systemAllowlist = ['app.frieren.files']

export async function capabilities() {
	const fs = await getVolume()
	return capabilityRegistry({
		volume: volumeCapability(fs, { systemAllowlist })
	})
}
