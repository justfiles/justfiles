// Public barrel for capability primitives. Per-capability contracts live in
// `@justfiles/app/capabilities/<id>` subpaths so apps only import what they
// declare.

export {
	type CapabilityBridge,
	type CapabilityFactory,
	type CapabilityScope,
	defineCapability
} from './core.ts'
