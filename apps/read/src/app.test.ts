import { appBundleFromMemory, kernel, type GetSandbox } from '@justfiles/app'
import { capabilityRegistry, implementCapability } from '@justfiles/app/capabilities'
import { reader } from '@justfiles/app/capabilities/reader'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test } from 'vitest'
import { app, type ReadState } from './app.ts'

const decoder = new TextDecoder()
const open: ReturnType<typeof kernel>[] = []

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

afterEach(() => {
	for (const instance of open.splice(0)) instance.dispose()
})

async function start() {
	const fs = volume(memStore())
	const reads: string[] = []
	const opened: string[] = []
	const sandbox: GetSandbox = async () => ({
		run: (message, context) =>
			app.dispatch(message, context as Parameters<typeof app.dispatch>[1]),
		initialState: async () => app.initialState,
		actions: async () => app.actions,
		capabilities: async () => app.capabilities,
		runProcedure: (name, params, handle) =>
			app.runProcedure(name, params, handle as Parameters<typeof app.runProcedure>[2]),
		subscriptions: async (state) => app.subscriptions(state as ReadState)
	})
	const readerCap = implementCapability(reader, {
		read: async (_ctx, { url }) => {
			reads.push(url)
			if (url.includes('blocked')) throw new Error('Blocked by the site')
			return {
				url,
				title: 'A useful article',
				markdown: '# A useful article\n\nWorth reading. ![remote](https://example.com/image.jpg)',
				wordCount: 4
			}
		},
		open: async (_ctx, { url }) => {
			opened.push(url)
		}
	})
	const instance = kernel({
		fs,
		sandbox,
		clock: {},
		capabilities: capabilityRegistry({ volume: volumeCapability(fs), reader: readerCap })
	})
	open.push(instance)
	const appId = await instance.install(
		appBundleFromMemory({ id: 'justfiles.read', name: 'Read', app: '// test' })
	)
	return { fs, instance, appId, reads, opened }
}

test('asks the host to open external URLs', async () => {
	const { instance, appId, opened } = await start()

	await instance.dispatch(appId, {
		type: 'openUrl',
		params: { url: 'https://example.com/article' }
	})

	expect(opened).toEqual(['https://example.com/article'])
	expect((await instance.actions(appId)).openUrl).toBeUndefined()
})

test('saves pasted markdown and persists read state beside it', async () => {
	const { fs, instance, appId } = await start()
	await instance.dispatch(appId, { type: 'save', params: { input: '# Hello world\n\nA note.' } })

	let state = (await instance.state(appId)) as ReadState
	expect(state.items[0]).toMatchObject({
		slug: 'hello-world',
		title: 'Hello world',
		doc: 'content.md',
		source: null,
		read: false,
		kind: 'text'
	})
	const key = await sha256('# Hello world\n\nA note.')
	expect(state.items[0]?.key).toBe(key)
	expect(
		JSON.parse(decoder.decode(await fs.readFile(`/reading/.index/text/${key}.json`)))
	).toEqual({ slug: 'hello-world', identity: key })
	expect(decoder.decode(await fs.readFile('/reading/hello-world/content.md'))).toBe(
		'# Hello world\n\nA note.'
	)
	expect(await instance.dispatch(appId, { type: 'read', params: {}, actor: 'agent' })).toBe(
		'# Hello world\n\nA note.'
	)
	expect(await instance.actions(appId)).toMatchObject({
		read: { kind: 'procedure', audience: 'agent' }
	})
	expect((await instance.actions(appId)).load).toBeUndefined()
	expect((await instance.actions(appId)).savePdf).toBeUndefined()

	await instance.dispatch(appId, {
		type: 'setRead',
		params: { slug: 'hello-world', read: true },
		actor: 'agent'
	})
	state = (await instance.state(appId)) as ReadState
	expect(state.items[0]?.read).toBe(true)
	expect(JSON.parse(decoder.decode(await fs.readFile('/reading/hello-world/info.json')))).toMatchObject({
		read: true,
		doc: 'content.md',
		kind: 'text',
		key
	})

	await instance.dispatch(appId, { type: 'save', params: { input: '# Hello world\n\nA note.' } })
	state = (await instance.state(appId)) as ReadState
	expect(state.items).toHaveLength(1)
	expect(await fs.exists('/reading/hello-world-2')).toBe(false)
})

test('saves URLs without remote images and records failures without files', async () => {
	const { fs, instance, appId, reads } = await start()
	await instance.dispatch(appId, {
		type: 'save',
		params: { input: 'https://example.com/article' }
	})
	const urlKey = await sha256('https://example.com/article')
	expect(
		JSON.parse(decoder.decode(await fs.readFile(`/reading/.index/url/${urlKey}.json`)))
	).toEqual({ slug: 'a-useful-article', identity: 'https://example.com/article' })
	expect(decoder.decode(await fs.readFile('/reading/a-useful-article/content.md'))).not.toContain(
		'image.jpg'
	)
	expect(
		await instance.dispatch(appId, { type: 'read', params: {}, actor: 'agent' })
	).toBe('# A useful article\n\nWorth reading.')
	expect(
		await instance.dispatch(appId, {
			type: 'read',
			params: { url: 'https://example.com/article' },
			actor: 'agent'
		})
	).toBe('# A useful article\n\nWorth reading.')
	expect(reads).toEqual(['https://example.com/article'])

	expect(
		await instance.dispatch(appId, {
			type: 'read',
			params: { url: 'https://example.com/new' },
			actor: 'agent'
		})
	).toBe('# A useful article\n\nWorth reading.')
	expect(reads).toEqual(['https://example.com/article', 'https://example.com/new'])
	expect(((await instance.state(appId)) as ReadState).items).toHaveLength(1)

	await instance.dispatch(appId, {
		type: 'save',
		params: { input: 'https://blocked.example/article' }
	})
	const state = (await instance.state(appId)) as ReadState
	expect(state.failed).toEqual([
		{ url: 'https://blocked.example/article', error: 'Blocked by the site' }
	])
	const paths: string[] = []
	await fs.scan('/reading', async (path) => {
		paths.push(path)
	})
	expect(paths.some((path) => path.includes('blocked'))).toBe(false)
})

test('opens an existing item when the URL is saved again', async () => {
	const { instance, appId, reads } = await start()
	await instance.dispatch(appId, {
		type: 'save',
		params: { input: 'https://example.com/article#start' }
	})
	await instance.dispatch(appId, {
		type: 'save',
		params: { input: '# Another item\n\nSome text.' }
	})
	await instance.dispatch(appId, {
		type: 'save',
		params: { input: 'https://example.com/article#end' }
	})

	const state = (await instance.state(appId)) as ReadState
	expect(state.items).toHaveLength(2)
	expect(state.current).toBe('a-useful-article')
	expect(reads).toEqual(['https://example.com/article'])
})

test('claims distinct folders when saves with the same title overlap', async () => {
	const { fs, instance, appId } = await start()

	await Promise.all([
		instance.dispatch(appId, {
			type: 'save',
			params: { input: 'https://example.com/first' }
		}),
		instance.dispatch(appId, {
			type: 'save',
			params: { input: 'https://example.com/second' }
		})
	])

	const state = (await instance.state(appId)) as ReadState
	expect(state.items.map((item) => item.slug).sort()).toEqual([
		'a-useful-article',
		'a-useful-article-2'
	])
	const sources = await Promise.all(
		state.items.map(async ({ slug }) => {
			const info = JSON.parse(decoder.decode(await fs.readFile(`/reading/${slug}/info.json`)))
			return info.source
		})
	)
	expect(sources.sort()).toEqual([
		'https://example.com/first',
		'https://example.com/second'
	])
})

test('deduplicates overlapping saves by URL and text identity', async () => {
	for (const input of ['https://example.com/same', '# Same text\n\nKeep one copy.']) {
		const { fs, instance, appId } = await start()

		await Promise.all([
			instance.dispatch(appId, { type: 'save', params: { input } }),
			instance.dispatch(appId, { type: 'save', params: { input } })
		])

		expect(((await instance.state(appId)) as ReadState).items).toHaveLength(1)
		expect((await fs.readdir('/reading')).filter(({ name }) => name !== '.index')).toHaveLength(1)
	}
})

test('deduplicates overlapping PDF saves by content identity', async () => {
	const { fs, instance, appId } = await start()
	const action = {
		type: 'savePdf' as const,
		params: { name: 'Same.pdf', data: btoa('%PDF same') }
	}

	await Promise.all([instance.dispatch(appId, action), instance.dispatch(appId, action)])

	expect(((await instance.state(appId)) as ReadState).items).toHaveLength(1)
	expect((await fs.readdir('/reading')).filter(({ name }) => name !== '.index')).toHaveLength(1)
})

test('removes an item and its index entry together', async () => {
	const { fs, instance, appId } = await start()
	const markdown = '# Remove me\n\nTemporary.'
	const key = await sha256(markdown)
	await instance.dispatch(appId, { type: 'save', params: { input: markdown } })

	await instance.dispatch(appId, { type: 'remove', params: { slug: 'remove-me' } })
	await instance.settled(appId, 1)

	expect(await fs.exists('/reading/remove-me')).toBe(false)
	expect(await fs.exists(`/reading/.index/text/${key}.json`)).toBe(false)
	expect(((await instance.state(appId)) as ReadState).items).toEqual([])
})

test('does not delete folders absent from state', async () => {
	const { fs, instance, appId } = await start()
	await fs.mkdir('/reading/unlisted', { recursive: true })
	await fs.writeFile('/reading/unlisted/private.txt', new TextEncoder().encode('keep'))

	await instance.dispatch(appId, { type: 'remove', params: { slug: 'unlisted' } })

	expect(await fs.exists('/reading/unlisted/private.txt')).toBe(true)
})

test('uses the URL index without loading the reading list first', async () => {
	const { fs, instance, appId, reads } = await start()
	const source = 'https://example.com/indexed'
	const key = await sha256(source)
	await fs.mkdir('/reading/already-here', { recursive: true })
	await fs.mkdir('/reading/.index/url', { recursive: true })
	await fs.writeFile(
		'/reading/already-here/info.json',
		new TextEncoder().encode(
			JSON.stringify({
				title: 'Already here',
				doc: 'content.md',
				source,
				savedAt: 1,
				read: false,
				words: 2,
				kind: 'url',
				key
			})
		)
	)
	await fs.writeFile('/reading/already-here/content.md', new TextEncoder().encode('Already saved.'))
	await fs.writeFile(
		`/reading/.index/url/${key}.json`,
		new TextEncoder().encode(JSON.stringify({ slug: 'already-here', identity: source }))
	)

	await instance.dispatch(appId, { type: 'save', params: { input: source } })

	const state = (await instance.state(appId)) as ReadState
	expect(state.items).toMatchObject([{ slug: 'already-here', source }])
	expect(state.current).toBe('already-here')
	expect(reads).toEqual([])
})

test('indexes existing readable folders during refresh', async () => {
	const { fs, instance, appId } = await start()
	const markdown = '# Existing note\n\nKept readable.'
	const key = await sha256(markdown)
	await fs.mkdir('/reading/existing-note', { recursive: true })
	await fs.writeFile('/reading/existing-note/content.md', new TextEncoder().encode(markdown))
	await fs.writeFile(
		'/reading/existing-note/info.json',
		new TextEncoder().encode(
			JSON.stringify({
				title: 'Existing note',
				doc: 'content.md',
				source: null,
				savedAt: 1,
				read: false,
				words: 4
			})
		)
	)

	await instance.dispatch(appId, { type: 'refresh', params: {} })

	expect(
		JSON.parse(decoder.decode(await fs.readFile('/reading/existing-note/info.json')))
	).toMatchObject({ kind: 'text', key })
	expect(
		JSON.parse(decoder.decode(await fs.readFile(`/reading/.index/text/${key}.json`)))
	).toEqual({ slug: 'existing-note', identity: key })
	await instance.dispatch(appId, { type: 'save', params: { input: markdown } })
	expect(((await instance.state(appId)) as ReadState).items).toHaveLength(1)
})

test('refresh adopts one identity winner for duplicate unindexed folders', async () => {
	const { fs, instance, appId } = await start()
	const markdown = '# Same content\n\nOnly one item.'
	const key = await sha256(markdown)
	for (const slug of ['first-copy', 'second-copy']) {
		await fs.mkdir(`/reading/${slug}`, { recursive: true })
		await fs.writeFile(`/reading/${slug}/content.md`, new TextEncoder().encode(markdown))
	}

	await instance.dispatch(appId, { type: 'refresh', params: {} })

	const state = (await instance.state(appId)) as ReadState
	expect(state.items).toHaveLength(1)
	expect(state.items[0]).toMatchObject({ kind: 'text', key })
	expect(
		JSON.parse(decoder.decode(await fs.readFile(`/reading/.index/text/${key}.json`))).slug
	).toBe(state.items[0]?.slug)
})

test('repairs an index after a readable folder is renamed', async () => {
	const { fs, instance, appId } = await start()
	const markdown = '# Rename me\n\nStill the same text.'
	const key = await sha256(markdown)
	await instance.dispatch(appId, { type: 'save', params: { input: markdown } })
	await fs.rename('/reading/rename-me', '/reading/a-better-name')
	await instance.dispatch(appId, { type: 'refresh', params: {} })

	await instance.dispatch(appId, { type: 'save', params: { input: markdown } })

	const state = (await instance.state(appId)) as ReadState
	expect(state.items).toMatchObject([{ slug: 'a-better-name', key }])
	expect(state.current).toBe('a-better-name')
	expect(
		JSON.parse(decoder.decode(await fs.readFile(`/reading/.index/text/${key}.json`)))
	).toEqual({ slug: 'a-better-name', identity: key })
})

test('adopts a loose PDF during refresh', async () => {
	const { fs, instance, appId } = await start()
	await fs.writeFile('/reading/paper.pdf', new Uint8Array([37, 80, 68, 70]))

	await instance.dispatch(appId, { type: 'refresh', params: {} })
	const state = (await instance.state(appId)) as ReadState
	expect(state.items).toMatchObject([
		{ slug: 'paper', title: 'paper', doc: 'paper.pdf', read: false }
	])
	expect(await fs.exists('/reading/paper.pdf')).toBe(false)
	expect(await fs.exists('/reading/paper/paper.pdf')).toBe(true)
})

test('saves a PDF from the clipboard', async () => {
	const { fs, instance, appId } = await start()
	await instance.dispatch(appId, {
		type: 'savePdf',
		params: { name: 'A Paper.pdf', data: btoa('%PDF') }
	})

	const state = (await instance.state(appId)) as ReadState
	expect(state.items).toMatchObject([
		{ slug: 'a-paper', title: 'A Paper', doc: 'A Paper.pdf', read: false }
	])
	expect(decoder.decode(await fs.readFile('/reading/a-paper/A Paper.pdf'))).toBe('%PDF')

	await instance.dispatch(appId, {
		type: 'savePdf',
		params: { name: 'A Different Name.pdf', data: btoa('%PDF') }
	})
	expect(((await instance.state(appId)) as ReadState).items).toHaveLength(1)
	expect(await fs.exists('/reading/a-different-name')).toBe(false)
})
