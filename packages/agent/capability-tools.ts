// The ONE pi ↔ capability seam (interface-refactor plan, Step 3.5): turn a
// capability's runtime-neutral tool descriptors into pi AgentTools, binding each
// execute to the AGENT actor over the host's capability invoke. Wire a capability's
// descriptor set into `createAgentSession` and its tools appear on that host — no
// session or agent change per capability.

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
	Capabilities,
	CapabilityTool,
	CapabilityToolResult
} from '@justfiles/app/capabilities'
import type { Volume } from '@justfiles/fs'
import type { TSchema } from 'typebox'

export interface CapabilityToolSet {
	capability: string
	tools: CapabilityTool[]
}

// A structured descriptor return carries the model-facing text apart from the
// out-of-band `details`; anything else is JSON for the model.
function structured(value: unknown): value is CapabilityToolResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as CapabilityToolResult).content === 'string'
	)
}

export function capabilityTools(
	invoke: Capabilities['invoke'],
	sets: readonly CapabilityToolSet[],
	volume: Volume
): AgentTool[] {
	return sets.flatMap(({ capability, tools }) =>
		tools.map(
			(tool): AgentTool => ({
				name: tool.name,
				label: tool.name,
				description: tool.description,
				parameters: tool.parameters as unknown as TSchema,
				execute: async (_toolCallId, params) => {
					const scoped = (method: string, ...args: unknown[]) =>
						invoke({ appId: 'agent', capability, method, args, scopes: [] })
					const result = await tool.execute(scoped, params, { volume })
					if (structured(result))
						return { content: [{ type: 'text', text: result.content }], details: result.details }
					return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }
				}
			})
		)
	)
}
