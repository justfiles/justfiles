// Cloudflare adapter layer.
//
// The adapter exposes flat RPC methods because nested capability namespaces
// resolve unreliably across Cloudflare Workers RPC. The platform-agnostic
// interfaces in `contracts.ts` remain the internal shape; this file is the
// only place that bends to Cloudflare's transport.
//
// Wiring (future): the parent Worker exports `AppCapabilitiesEntrypoint` as a
// WorkerEntrypoint subclass (see `./entrypoint.ts`). When loading a Dynamic
// Worker, the parent should pass:
//
//   env.CAPABILITIES = ctx.exports.AppCapabilitiesEntrypoint({
//     props: { context: { userId, appId, appVersion, grants } }
//   })
//
// Each app instance receives a stub scoped to its own grants.

import type {
	CalendarEventDTO,
	Capabilities,
	CapabilityResult,
	EmailDetailDTO,
	EmailDTO,
	ListTodayInput,
	ListUnreadInput,
	MarkReadInput,
	ReadDetailInput,
	ReadFileInput,
	SandboxContext,
	WriteFileInput
} from './contracts.ts'

// Flat RPC contract that the dynamic worker consumes from `env.CAPABILITIES`.
// Mirrors the platform-agnostic `Capabilities` interface but flattens the
// namespace so Cloudflare RPC reliably resolves each method.
export interface CapabilityBindingShape {
	emailListUnread(input: ListUnreadInput): Promise<CapabilityResult<EmailDTO[]>>
	emailReadDetail(input: ReadDetailInput): Promise<CapabilityResult<EmailDetailDTO>>
	emailMarkRead(input: MarkReadInput): Promise<CapabilityResult<{ success: true }>>
	calendarListToday(input: ListTodayInput): Promise<CapabilityResult<CalendarEventDTO[]>>
	volumeReadFile(input: ReadFileInput): Promise<CapabilityResult<{ data: Uint8Array }>>
	volumeWriteFile(input: WriteFileInput): Promise<CapabilityResult<{ success: true }>>
}

// Wrap a platform-agnostic Capabilities object as a flat RPC binding. Useful
// for in-process tests and for non-Cloudflare hosts that want the same shape.
export function flattenCapabilities(caps: Capabilities): CapabilityBindingShape {
	return {
		emailListUnread: (input) => caps.email.listUnread(input),
		emailReadDetail: (input) => caps.email.readDetail(input),
		emailMarkRead: (input) => caps.email.markRead(input),
		calendarListToday: (input) => caps.calendar.listToday(input),
		volumeReadFile: (input) => caps.volume.readFile(input),
		volumeWriteFile: (input) => caps.volume.writeFile(input)
	}
}

// Shape of props passed via `ctx.exports.AppCapabilitiesEntrypoint({ props })`.
// Props are part of the cache key but do not contain credentials — credentials
// stay in the parent Worker, which constructs provider adapters on demand.
export interface AppCapabilityProps {
	context: SandboxContext
}
