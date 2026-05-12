// Owns the lifecycle of an app's registered tools for one mount: registration,
// TypeBox `Value.Check` validation at the boundary, handler dispatch, error
// packaging for the agent runtime, automatic clear on unmount, and idempotent
// unregister. The Host Factory composes one of these into each per-mount
// `Host`.

import type Type from 'typebox'
import { Value } from 'typebox/value'
import type { Tool, ToolRegistry } from './contract.js'

export interface RegisteredTool {
	readonly name: string
	readonly description: string
	readonly schema: Type.TSchema
}

export interface ToolRegistryEvents {
	onRegister?(tool: RegisteredTool): void
	onUnregister?(name: string): void
}

// Stable error shape for the agent runtime to surface to the LLM.
// `kind: 'schema'` means input failed TypeBox validation. `kind: 'unknown_tool'`
// means a tool by that name is not registered. `kind: 'handler'` means the
// handler threw (or rejected) — the original message is preserved.
export type ToolInvokeError =
	| { kind: 'schema'; tool: string; message: string }
	| { kind: 'unknown_tool'; tool: string; message: string }
	| { kind: 'handler'; tool: string; message: string }

export class ToolInvokeFailure extends Error {
	readonly detail: ToolInvokeError
	constructor(detail: ToolInvokeError) {
		super(detail.message)
		this.name = 'ToolInvokeFailure'
		this.detail = detail
	}
}

export interface ToolRegistryHandle {
	/** App-facing registry to compose into `Host.agent.tools`. */
	readonly registry: ToolRegistry
	/** Host-side: invoke a registered tool. Validates input via TypeBox.
	 *  Throws `ToolInvokeFailure` on schema or handler failure. */
	invoke(name: string, input: unknown): Promise<unknown>
	/** Snapshot of currently registered tools (for the agent runtime). */
	list(): RegisteredTool[]
	/** Clear all registrations; idempotent. */
	dispose(): void
}

export function createToolRegistry(events: ToolRegistryEvents = {}): ToolRegistryHandle {
	const tools = new Map<string, Tool>()
	let disposed = false

	const registry: ToolRegistry = Object.freeze({
		register<S extends Type.TSchema>(tool: Tool<S>): () => void {
			if (disposed) throw new Error('tool registry is disposed')
			if (typeof tool.name !== 'string' || tool.name.length === 0)
				throw new Error('tool name must be a non-empty string')
			if (typeof tool.handler !== 'function') throw new Error('tool handler must be a function')
			tools.set(tool.name, tool as unknown as Tool)
			events.onRegister?.({
				name: tool.name,
				description: tool.description,
				schema: tool.schema
			})
			let unreg = false
			return () => {
				if (unreg) return
				unreg = true
				if (tools.get(tool.name) === (tool as unknown as Tool)) {
					tools.delete(tool.name)
					events.onUnregister?.(tool.name)
				}
			}
		}
	})

	const invokeError = (detail: ToolInvokeError): never => {
		throw new ToolInvokeFailure(detail)
	}

	return {
		registry,
		async invoke(name, input) {
			const tool = tools.get(name)
			if (!tool) {
				return invokeError({ kind: 'unknown_tool', tool: name, message: `unknown tool: ${name}` })
			}
			if (!Value.Check(tool.schema, input)) {
				const [first] = Value.Errors(tool.schema, input)
				const summary = first ? `${first.instancePath || '/'}: ${first.message}` : 'schema mismatch'
				return invokeError({
					kind: 'schema',
					tool: name,
					message: `invalid input for tool ${name}: ${summary}`
				})
			}
			try {
				return await tool.handler(input as never)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				return invokeError({ kind: 'handler', tool: name, message })
			}
		},
		list() {
			return [...tools.values()].map((t) => ({
				name: t.name,
				description: t.description,
				schema: t.schema
			}))
		},
		dispose() {
			if (disposed) return
			disposed = true
			const names = [...tools.keys()]
			tools.clear()
			for (const name of names) events.onUnregister?.(name)
		}
	}
}
