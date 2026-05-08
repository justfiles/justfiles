// Sandbox-side capability binder. Runs inside the dynamic worker bundle (a
// fourth `?raw` injected module alongside runtime.js / runner.js). Turns the
// host's generic `bridge.invoke({capability, method, input})` transport into
// the typed `ctx.capabilities.<id>.<method>(input)` shape that task handlers
// declare against.
//
// Method names are not enumerated on the capability instance — apps only
// declare ids and scopes. The host enforces method-level grants. We use a
// Proxy so any method call routes through `bridge.invoke(...)` without the
// app/sandbox needing a method registry.

import type { CapabilityInstance } from './capabilities/core.js'

export interface CapabilityBridge {
	invoke(req: { capability: string; method: string; input: unknown }): Promise<unknown>
}

function bindOne(bridge: CapabilityBridge, id: string): Record<string, unknown> {
	return new Proxy(
		{},
		{
			get(_target, method) {
				if (typeof method !== 'string') return undefined
				return (input: unknown) => bridge.invoke({ capability: id, method, input })
			}
		}
	) as Record<string, unknown>
}

/**
 * Build the `capabilities` object handed to task handlers from the engine's
 * declared capability instances and the host bridge. The runner merges the
 * result into `TaskContext` via the `host()` factory.
 */
export function bindCapabilities(
	bridge: CapabilityBridge,
	instances: ReadonlyArray<CapabilityInstance>
): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const inst of instances) {
		out[inst.id] = bindOne(bridge, inst.id)
	}
	return out
}
