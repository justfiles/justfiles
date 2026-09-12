import { Agent } from '@earendil-works/pi-agent-core'
import type { Context, Message } from '@earendil-works/pi-ai'
import Type from 'typebox'
import { expect, test, vi } from 'vitest'
import { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, textBackend } from './text.ts'

const tool = {
	name: 'lookup',
	description: 'Look up a number',
	parameters: Type.Object({ count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
}
const context: Context = {
	systemPrompt: 'System\n"instruction"',
	messages: [{ role: 'user', content: 'A question\nwith "quotes" and 🦊', timestamp: 0 }],
	tools: [tool]
}

async function completion(text: string, input = context) {
	const backend = textBackend('fixture', async () => text)
	const stream = await backend.streamFn(backend.model, input)
	const events = []
	for await (const event of stream) events.push(event)
	return { message: await stream.result(), events }
}

test('encodes full roles, call IDs, results, errors and schemas without losing escapes', async () => {
	let encoded: unknown
	const first = await completion('{"type":"tool_call","name":"lookup","arguments":{"count":2}}')
	const input: Context = {
		...context,
		messages: [
			...context.messages,
			first.message,
			{
				role: 'toolResult',
				toolCallId: first.message.content[0].id,
				toolName: 'lookup',
				isError: true,
				content: [{ type: 'text', text: '{"$bytes":[0,255],"$bigint":"9007199254740993"}\nerror' }],
				timestamp: 0
			}
		]
	}
	const backend = textBackend('fixture', async ({ prompt }) => {
		encoded = JSON.parse(prompt)
		return JSON.stringify({ type: 'final', text: 'Multiline\n"answer" 🦊' })
	})
	const result = await backend.completeFn(backend.model, input)
	expect(result.content).toEqual([{ type: 'text', text: 'Multiline\n"answer" 🦊' }])
	expect(encoded).toMatchObject({
		system: context.systemPrompt,
		tools: [tool],
		messages: [
			{ role: 'user', content: context.messages[0].content },
			{ role: 'assistant', content: first.message.content },
			{
				role: 'toolResult',
				toolCallId: first.message.content[0].id,
				toolName: 'lookup',
				isError: true,
				content: input.messages[2].content
			}
		]
	})
	expect(first.message.stopReason).toBe('toolUse')
	expect(first.events.map(({ type }) => type)).toEqual(['start', 'done'])
})

test.each([
	'ordinary prose',
	'```json\n{"type":"final","text":"hi"}\n```',
	'{"type":"final","text":"hi"} {"type":"final","text":"again"}',
	'{"type":"tool_call","name":"shell","arguments":{}}',
	'{"type":"tool_call","name":"lookup","arguments":{"count":"2"}}',
	'{"type":"tool_call","name":"lookup","arguments":{"count":0}}',
	'{"type":"tool_call","name":"lookup","arguments":{"count":1,"extra":true}}',
	'{"type":"tool_call","name":"lookup","arguments":[]}',
	'{"type":"final","text":3}',
	'{"type":"final","text":"answer","name":"lookup","arguments":{"count":1}}'
])('invalid response executes no tool: %s', async (output) => {
	const execute = vi.fn()
	const backend = textBackend('fixture', async () => output)
	const agent = new Agent({
		initialState: { model: backend.model, tools: [{ ...tool, label: 'Lookup', execute }] },
		streamFn: backend.streamFn
	})
	await agent.prompt('go')
	expect(execute).not.toHaveBeenCalled()
	expect(agent.state.messages.at(-1)?.stopReason).toBe('error')
})

test('only Pi executes the tool; the next request receives its unpredictable result', async () => {
	let value: string | undefined
	const calls: Context[] = []
	const backend = textBackend('fixture', async ({ prompt }) => {
		const input = JSON.parse(prompt)
		calls.push(input)
		const last = input.messages.at(-1)
		return JSON.stringify(
			last.role === 'toolResult'
				? { type: 'final', text: last.content[0].text }
				: { type: 'tool_call', name: 'lookup', arguments: { count: 1 } }
		)
	})
	const execute = vi.fn(async () => {
		value = crypto.randomUUID()
		return { content: [{ type: 'text' as const, text: value }], details: {} }
	})
	const agent = new Agent({
		initialState: { model: backend.model, tools: [{ ...tool, label: 'Lookup', execute }] },
		streamFn: backend.streamFn
	})
	await agent.prompt('go')
	expect(calls).toHaveLength(2)
	expect(execute).toHaveBeenCalledTimes(1)
	expect(agent.state.messages.at(-1)?.content).toEqual([{ type: 'text', text: value }])
})

test('bounds input and output and rejects unsupported content', async () => {
	const generate = vi.fn(async () => '{"type":"final","text":"ok"}')
	const backend = textBackend('fixture', generate)
	for (const message of [
		{ role: 'user', content: 'a'.repeat(MAX_INPUT_BYTES), timestamp: 0 },
		{ role: 'user', content: [{ type: 'image', data: 'a', mimeType: 'image/png' }], timestamp: 0 },
		{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }], timestamp: 0 }
	]) {
		const result = await backend.completeFn(backend.model, { messages: [message as Message] })
		expect(result.stopReason).toBe('error')
	}
	expect(generate).not.toHaveBeenCalled()
	const result = await completion('a'.repeat(MAX_OUTPUT_BYTES + 1))
	expect(result.message.errorMessage).toContain('output exceeds')
	expect(result.events.at(-1)?.type).toBe('error')
})

test('transport errors and late cancelled responses produce terminal errors, never tool calls', async () => {
	const stop = new AbortController()
	const backend = textBackend('fixture', async () => {
		stop.abort('cancelled')
		return '{"type":"tool_call","name":"lookup","arguments":{"count":1}}'
	})
	const result = await backend.completeFn(backend.model, context, { signal: stop.signal })
	expect(result.stopReason).toBe('aborted')
	expect(result.content).toEqual([])
	const failed = textBackend('fixture', async () => {
		throw new Error('offline')
	})
	expect(await failed.completeFn(failed.model, context)).toMatchObject({
		stopReason: 'error',
		errorMessage: 'offline'
	})
})
