// Public barrel for capability primitives. Per-capability contracts live in
// `@justfiles/app/capabilities/<id>` subpaths so apps only import what they
// declare.

export {
	type CapabilityBridge,
	type CapabilityFactory,
	type CapabilityScope,
	type CapabilityTool,
	type CapabilityToolContext,
	type CapabilityToolResult,
	type CapabilityToolSet,
	defineCapability,
	implementTool,
	type MethodMeta,
	type MethodMetaMap,
	type ScopedInvoke,
	type Stream,
	type ToolOverride
} from './core.ts'
export {
	type CapabilityCode,
	CapabilityError,
	fromWire,
	toWire,
	type WireError
} from './error.ts'
export { implementCapability } from './implement.ts'
export { capabilityRegistry } from './registry.ts'
export { type CapsClient, proxyCapabilitiesRpc, serveCapabilitiesRpc } from './rpc.ts'
export type {
	Capabilities,
	Capability,
	CapabilityCall,
	Emit,
	Unsubscribe
} from './types.ts'
export { wsFeedTransport } from './wsFeedTransport.ts'
