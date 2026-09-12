import type { AgentTool } from '@earendil-works/pi-agent-core'
import Type from 'typebox'
import type { CapabilityCall } from '../../types.ts'
import { references } from './references.ts'

const params = Type.Object({
	capability: Type.String({ description: 'The app-local binding name.' }),
	method: Type.Optional(
		Type.String({ description: 'Omit to read the capability’s API reference.' })
	),
	args: Type.Optional(Type.Array(Type.Unknown(), { description: 'Positional method arguments.' }))
})

export function appTool(app: NonNullable<CapabilityCall['app']>): AgentTool<typeof params> {
	return {
		name: 'capability',
		label: 'App capability',
		description: [
			'Use the calling app’s capabilities. Omit method to read its API, then call a method with positional args.',
			'Encode Uint8Array as {"$bytes":"UTF-8 text"} or {"$bytes":[0,255]}, and bigint as {"$bigint":"123"}. Results use the same encoding.',
			`Available bindings: ${JSON.stringify(app.bindings)}`
		].join('\n'),
		parameters: params,
		async execute(_id, { capability, method, args = [] }, signal) {
			signal?.throwIfAborted()
			if (!Object.hasOwn(app.bindings, capability))
				throw new Error(`undeclared capability: ${capability}`)
			const binding = app.bindings[capability]!
			const result = method
				? await app.invoke(capability, method, JSON.parse(JSON.stringify(args), decode))
				: (references[binding.id] ?? `No bundled API reference for ${binding.id}.`)
			return {
				content: [
					{
						type: 'text',
						text: typeof result === 'string' ? result : (JSON.stringify(result, encode) ?? 'done')
					}
				],
				details: {}
			}
		}
	}
}

function decode(_key: string, value: unknown): unknown {
	if (value && typeof value === 'object') {
		if ('$bytes' in value)
			return typeof value.$bytes === 'string'
				? new TextEncoder().encode(value.$bytes)
				: Uint8Array.from(value.$bytes as number[])
		if ('$bigint' in value) return BigInt(value.$bigint as string)
	}
	return value
}

function encode(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return { $bigint: String(value) }
	if (value instanceof Uint8Array) {
		const text = new TextDecoder().decode(value)
		const bytes = new TextEncoder().encode(text)
		return {
			$bytes:
				bytes.length === value.length && bytes.every((b, i) => b === value[i]) ? text : [...value]
		}
	}
	return value
}
