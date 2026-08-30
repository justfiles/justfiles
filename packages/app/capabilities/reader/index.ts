import { defineCapability } from '../core.ts'
import type { ReaderCapability } from './contract.ts'

export type { ReaderCapability } from './contract.ts'

export const reader = defineCapability<'reader', ReaderCapability>('reader')
