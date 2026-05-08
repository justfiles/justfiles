// Public barrel for capability primitives. Per-capability contracts live in
// `@justfiles/app/capabilities/<id>` subpaths so apps only import what they
// declare.

export {
	type CapabilityFactory,
	type CapabilityInstance,
	type CapabilityScope,
	type CapsFromInstances,
	defineCapability
} from './core.js'
