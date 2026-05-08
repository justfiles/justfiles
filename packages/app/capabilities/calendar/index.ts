import { defineCapability } from '../core.js'
import type { CalendarCapability } from './contract.js'

export type { CalendarCapability, CalendarEvent } from './contract.js'

export const calendar = defineCapability<'calendar', CalendarCapability>('calendar')
