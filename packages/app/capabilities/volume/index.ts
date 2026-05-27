import { defineCapability } from '../core.ts'
import type { VolumeCapability } from './contract.ts'

export type { VolumeCapability, VolumeEntry } from './contract.ts'

// Scope strings the host honours when handing back a volume:
//   'app' / (none) → per-app chroot at /data/<id> (default)
//   'system'       → user's root volume (host-allowlisted)
//   '/prefix'      → chroot at the given absolute prefix
export const volume = defineCapability<'volume', VolumeCapability>('volume')
