// Public barrel for capability primitives. Per-capability contracts live in
// `@justfiles/app/capabilities/<id>` subpaths so apps only import what they
// declare.

export {
	type CapabilityBridge,
	type CapabilityFactory,
	type CapabilityScope,
	defineCapability,
	type Stream
} from './core.ts'
export {
	type CapabilityCode,
	CapabilityError,
	fromWire,
	toWire,
	type WireError
} from './error.ts'
export { implementCapability } from './implement.ts'
export { type Channel, proxyCapabilities, serveCapabilities } from './proxy.ts'
export { capabilityRegistry } from './registry.ts'
export type {
	Capabilities,
	Capability,
	CapabilityCall,
	Emit,
	Unsubscribe
} from './types.ts'
