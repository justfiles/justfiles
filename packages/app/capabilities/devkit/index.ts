import { defineCapability } from '../core.ts'
import type { DevkitCapability } from './contract.ts'

export type { DevkitCapability, MenuItemView, MenuView } from './contract.ts'

// Grant-gated, browser-local capability (see `apps/frieren` devkit impl). It
// runs code and can write `/applications`, so the host only routes it for
// allowlisted apps.
export const devkit = defineCapability<'devkit', DevkitCapability>('devkit')
