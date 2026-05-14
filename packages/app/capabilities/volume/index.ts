import { defineCapability } from '../core.ts'
import type { VolumeCapability } from './contract.ts'

export type { VolumeCapability } from './contract.ts'

export const volume = defineCapability<'volume', VolumeCapability>('volume')
