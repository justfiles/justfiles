import { defineCapability } from '../core.ts'
import type { DevkitCapability } from './contract.ts'

export type { DevkitCapability, DevkitPreview } from './contract.ts'
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

// Grant-gated, browser-local capability (see `platform/frieren` devkit impl). It
// runs code and can write `/applications`, so the host only routes it for
// allowlisted apps.
export const devkit = defineCapability<'devkit', DevkitCapability>('devkit')

// The kernel id a live preview is served under — a pure function of the slug, so
// app-code can address `stop` without threading the run
// result back. The leading dot makes it a HIDDEN kernel id (off the launcher
// catalog; see `hidden` in kernel.ts). Both sides of the capability MUST agree on
// this exact string, so it lives here, once.
export function previewIdFor(slug: string): string {
	return `.preview.${slug}`
}
