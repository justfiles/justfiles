import { describe, expect, test } from 'vitest'
import { createReadDocTool, type DocRef, docsPrompt } from './docs.ts'

const refs: DocRef[] = [
	{ id: 'app', name: 'how apps work', description: 'The app model and SDK' },
	{ id: 'fs', name: 'the filesystem', description: 'Files and volumes' }
]

describe('docsPrompt', () => {
	test('lists one line per doc with its id and description, and names the read_doc tool', () => {
		const block = docsPrompt(refs)
		expect(block).toContain('read_doc')
		expect(block).toContain('- how apps work (id: `app`) — The app model and SDK')
		expect(block).toContain('- the filesystem (id: `fs`) — Files and volumes')
		// One line per doc, plus the leading instruction line.
		expect(block.split('\n')).toHaveLength(refs.length + 1)
	})
})

describe('createReadDocTool', () => {
	test('loads a doc body by id through the provided reader', async () => {
		const tool = createReadDocTool(async (id) => `body of ${id}`)
		expect(tool.name).toBe('read_doc')
		const result = await tool.execute('call-1', { id: 'app' })
		expect(result.content[0]).toEqual({ type: 'text', text: 'body of app' })
		expect(result.details).toEqual({ id: 'app', size: 'body of app'.length })
	})
})
