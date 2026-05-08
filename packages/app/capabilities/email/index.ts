import { defineCapability } from '../core.js'
import type { EmailCapability } from './contract.js'

export type { EmailCapability, EmailDetail, EmailSummary } from './contract.js'

export const email = defineCapability<'email', EmailCapability>('email')
