import { defineCapability } from '../core.ts'
import type { CalendarCapability } from './contract.ts'

export type { CalendarCapability, CalendarEvent } from './contract.ts'

export const calendar = defineCapability<'calendar', CalendarCapability>('calendar')
