import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { CapabilityCall } from '@justfiles/app/capabilities'
import Type from 'typebox'
import ai from '../app/capabilities/ai/contract.ts?raw'
import calendar from '../app/capabilities/calendar/contract.ts?raw'
import devkit from '../app/capabilities/devkit/contract.ts?raw'
import email from '../app/capabilities/email/contract.ts?raw'
import image from '../app/capabilities/image/contract.ts?raw'
import notify from '../app/capabilities/notify/index.ts?raw'
import notifications from '../app/capabilities/notify/types.ts?raw'
import reader from '../app/capabilities/reader/contract.ts?raw'
import volume from '../app/capabilities/volume/contract.ts?raw'
import fs from '../fs/volume.ts?raw'

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

// Read the contracts themselves so the tool's reference follows SDK changes.
const references: Record<string, string> = {
	ai,
	calendar,
	devkit,
	email,
	image,
	reader,
	notify: `${notify}\n${notifications}`,
	volume: `${fs.slice(fs.indexOf('export interface Volume {')).split('\n}')[0]}\n}\n${volume}`
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
