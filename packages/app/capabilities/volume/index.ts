import { defineCapability } from '../core.ts'
import type { VolumeCapability } from './contract.ts'

export type { VolumeCapability, VolumeEntry } from './contract.ts'

// Scope strings the host honours when handing back a volume:
//   'app'      → per-app chroot at /applications/<id>/data/files (default)
//   'system'   → user's root volume
//   '/prefix'  → chroot at the given absolute prefix
export const volume = defineCapability<'volume', VolumeCapability>('volume')
