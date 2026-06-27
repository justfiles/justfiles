import { defineCapability } from '../core.ts'
import type { DevkitCapability } from './contract.ts'

export type { DevkitCapability, DevkitPreview, MenuItemView, MenuView } from './contract.ts'
// The app-facing toolchain data types — what `compile`/`typecheck` return and
// what app-code renders (the Problems panel). Re-exported here so a capability
// consumer needs only the devkit surface, never a separate engine import.
export type {
	CheckResult,
	CompileResult,
	Diagnostic,
	OutputFile,
	Position,
	Range
} from './toolchain.ts'

// Grant-gated, browser-local capability (see `apps/frieren` devkit impl). It
// runs code and can write `/applications`, so the host only routes it for
// allowlisted apps.
export const devkit = defineCapability<'devkit', DevkitCapability>('devkit')
