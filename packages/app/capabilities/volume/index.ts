import { defineCapability } from '../core.js'
import type { VolumeCapability } from './contract.js'

export type { VolumeCapability } from './contract.js'

export const volume = defineCapability<'volume', VolumeCapability>('volume')
