import { defineCapability } from '../core.ts'
import type { EmailCapability } from './contract.ts'

export type { EmailCapability, EmailDetail, EmailSummary } from './contract.ts'

export const email = defineCapability<'email', EmailCapability>('email')
