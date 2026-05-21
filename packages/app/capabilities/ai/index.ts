import { defineCapability } from '../core.ts'
import type { AiCapability } from './contract.ts'

export type { AiCapability } from './contract.ts'

export const ai = defineCapability<'ai', AiCapability>('ai')
