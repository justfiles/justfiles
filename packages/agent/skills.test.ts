import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import {
	createManifestSkillSource,
	createSkillRegistry,
	createVolumeSkillSource
} from './skills.ts'

const enc = new TextEncoder()
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)

async function seed(vol: ReturnType<typeof volume>, path: string, content: string) {
	await vol.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
	await vol.writeFile(path, enc.encode(content))
}

describe('volume skill source', () => {
	test('lists directory and single-file skills from frontmatter, loads bodies on demand', async () => {
		const vol = volume(memStorage())
		await seed(
			vol,
			'/system/skills/pdf/SKILL.md',
			'---\nname: pdf\ndescription: Work with PDFs\n---\npdf body'
		)
		await seed(
			vol,
			'/system/skills/notes.md',
			'---\nname: notes\ndescription: Take notes\n---\nnote body'
		)

		const source = createVolumeSkillSource(vol)
		expect([...(await source.list())].sort(byId)).toEqual([
			{ id: 'notes', name: 'notes', description: 'Take notes' },
			{ id: 'pdf', name: 'pdf', description: 'Work with PDFs' }
		])
		expect(await source.load('pdf')).toContain('pdf body')
		expect(await source.load('notes')).toContain('note body')
	})

	test('ignores directories without a SKILL.md', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/skills/empty', { recursive: true })
		expect(await createVolumeSkillSource(vol).list()).toEqual([])
	})

	test('returns an empty list when the skills dir is missing', async () => {
		expect(await createVolumeSkillSource(volume(memStorage())).list()).toEqual([])
	})

	test('falls back to the id when frontmatter omits name', async () => {
		const vol = volume(memStorage())
		await seed(vol, '/system/skills/raw.md', 'no frontmatter here')
		expect(await createVolumeSkillSource(vol).list()).toEqual([
			{ id: 'raw', name: 'raw', description: '' }
		])
	})
})

describe('skill registry', () => {
	test('lists every skill and dispatches read to the owning source', async () => {
		const builtin = createManifestSkillSource(
			[{ id: 'web', name: 'web', description: 'search the web' }],
			async (id) => `builtin:${id}`
		)
		const registry = createSkillRegistry([builtin])
		const index = await registry.index()
		expect(index).toContain('web')
		expect(index).toContain('search the web')
		expect(index).toContain('read_skill')
		expect(await registry.read('web')).toBe('builtin:web')
	})

	test('an earlier source shadows a built-in with the same id', async () => {
		const vol = volume(memStorage())
		await seed(
			vol,
			'/system/skills/pdf/SKILL.md',
			'---\nname: pdf\ndescription: user pdf\n---\nuser body'
		)
		const builtin = createManifestSkillSource(
			[{ id: 'pdf', name: 'pdf', description: 'builtin pdf' }],
			async (id) => `builtin:${id}`
		)
		const registry = createSkillRegistry([createVolumeSkillSource(vol), builtin])

		const index = await registry.index()
		expect(index).toContain('user pdf')
		expect(index).not.toContain('builtin pdf')
		expect(await registry.read('pdf')).toContain('user body')
	})

	test('read throws for an unknown id', async () => {
		await expect(createSkillRegistry([]).read('nope')).rejects.toThrow('Unknown skill')
	})

	test('an empty registry produces an empty index', async () => {
		expect(await createSkillRegistry([]).index()).toBe('')
	})
})
