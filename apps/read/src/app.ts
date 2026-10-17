import { type AppHandle, defineApp } from '@justfiles/app'
import { reader } from '@justfiles/app/capabilities/reader'
import { volume } from '@justfiles/app/capabilities/volume'
import { hash } from 'fast-sha256'
import * as v from 'valibot'

export type ItemKind = 'url' | 'text' | 'pdf'

export type Item = {
	slug: string
	title: string
	doc: string
	source: string | null
	savedAt: number
	read: boolean
	words: number
	kind?: ItemKind
	key?: string
}

export type ReadState = {
	items: Item[]
	current: string | null
	showRead: boolean
	selection: { slug: string; text: string } | null
	pending: { url: string; startedAt: number }[]
	failed: { url: string; error: string }[]
	revision: number
}

export type ReadDocument = { kind: 'markdown'; text: string } | { kind: 'pdf'; bytes: Uint8Array }

type Info = {
	title: string
	doc: string
	source: string | null
	savedAt: number
	read: boolean
	words: number
	kind?: ItemKind
	key?: string
}

type IndexEntry = { slug: string; identity: string }

const capabilities = {
	volume: volume({ scopes: ['/reading'] }),
	reader: reader({ scopes: [] })
}
type ReadHandle = AppHandle<ReadState, typeof capabilities>

const slugSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/))
const kindSchema = v.picklist(['url', 'text', 'pdf'])
const keySchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))
const itemSchema = v.object({
	slug: v.string(),
	title: v.string(),
	doc: v.string(),
	source: v.nullable(v.string()),
	savedAt: v.number(),
	read: v.boolean(),
	words: v.number(),
	kind: v.optional(kindSchema),
	key: v.optional(keySchema)
})
const empty = (): ReadState => ({
	items: [],
	current: null,
	showRead: false,
	selection: null,
	pending: [],
	failed: [],
	revision: 0
})

export const app = defineApp({
	init: empty(),
	capabilities,
	update: (t) => ({
		open: t.on(
			v.object({ slug: slugSchema }),
			(state, { slug }) => ({ ...stateOf(state), current: slug, selection: null }),
			{
				description: 'Open an item in the reading list.',
				examples: [{ params: { slug: 'attention-and-the-open-tab' } }]
			}
		),
		setRead: t.on(
			v.object({ slug: slugSchema, read: v.boolean() }),
			(state, { slug, read }) => {
				const current = stateOf(state)
				const found = current.items.find((item) => item.slug === slug)
				if (!found || found.read === read) return current
				const item = { ...found, read }
				const next = {
					...current,
					items: current.items.map((entry) => (entry.slug === slug ? item : entry))
				}
				return [
					next,
					t.cmd('volume', 'writeFile', `/${slug}/info.json`, encode(info(item))).to('fileWritten')
				]
			},
			{
				description: 'Mark a reading item read or unread.',
				examples: [{ params: { slug: 'attention-and-the-open-tab', read: true } }]
			}
		),
		setShowRead: t.on(v.object({ showRead: v.boolean() }), (state, { showRead }) => ({
			...stateOf(state),
			showRead
		})),
		remove: t.on(
			v.object({ slug: slugSchema }),
			(state, { slug }) => {
				const current = stateOf(state)
				const found = current.items.find((item) => item.slug === slug)
				if (!found) return current
				const removeFolder = t
					.cmd('volume', 'rm', `/${slug}`, { recursive: true, force: true })
					.to('fileRemoved')
				const command =
					found.kind && found.key
						? {
								kind: 'batch' as const,
								commands: [
									removeFolder,
									t
										.cmd('volume', 'rm', indexPath(found.kind, found.key), { force: true })
										.to('fileRemoved')
								]
							}
						: removeFolder
				return [
					{
						...current,
						items: current.items.filter((item) => item.slug !== slug),
						current: current.current === slug ? null : current.current,
						selection: current.selection?.slug === slug ? null : current.selection
					},
					command
				]
			},
			{
				description: 'Delete an item from the reading library.',
				examples: [{ params: { slug: 'attention-and-the-open-tab' } }]
			}
		),
		dismissFailed: t.on(v.object({ url: v.string() }), (state, { url }) => {
			const current = stateOf(state)
			return { ...current, failed: current.failed.filter((entry) => entry.url !== url) }
		}),
		fileWritten: t.fromResult('volume', 'writeFile', (state, result) => {
			const current = stateOf(state)
			return result.ok ? current : { ...current, revision: current.revision + 1 }
		}),
		fileRemoved: t.fromResult('volume', 'rm', (state, result) => {
			const current = stateOf(state)
			return result.ok ? current : { ...current, revision: current.revision + 1 }
		}),
		treeChanged: t.fromEvent('volume', 'watch', (state) => {
			const current = stateOf(state)
			return { ...current, revision: current.revision + 1 }
		}),
		indexed: t.commit(v.object({ items: v.array(itemSchema) }), (state, { items }) => {
			const current = stateOf(state)
			const slugs = new Set(items.map((item) => item.slug))
			return {
				...current,
				items,
				current: current.current && slugs.has(current.current) ? current.current : null,
				selection: current.selection && slugs.has(current.selection.slug) ? current.selection : null
			}
		}),
		saveStarted: t.commit(
			v.object({ url: v.string(), startedAt: v.number() }),
			(state, pending) => {
				const current = stateOf(state)
				return {
					...current,
					pending: [...current.pending, pending],
					failed: current.failed.filter((entry) => entry.url !== pending.url)
				}
			}
		),
		saved: t.commit(
			v.object({ item: itemSchema, startedAt: v.optional(v.number()) }),
			(state, { item, startedAt }) => {
				const current = stateOf(state)
				return {
					...current,
					items: [item, ...current.items.filter((entry) => entry.slug !== item.slug)].sort(
						(a, b) => b.savedAt - a.savedAt
					),
					current: item.slug,
					selection: null,
					pending:
						startedAt === undefined
							? current.pending
							: current.pending.filter((entry) => entry.startedAt !== startedAt),
					failed: item.source
						? current.failed.filter((entry) => entry.url !== item.source)
						: current.failed
				}
			}
		),
		saveFailed: t.commit(
			v.object({ url: v.string(), startedAt: v.number(), error: v.string() }),
			(state, failed) => {
				const current = stateOf(state)
				return {
					...current,
					pending: current.pending.filter((entry) => entry.startedAt !== failed.startedAt),
					failed: [
						{ url: failed.url, error: failed.error },
						...current.failed.filter((entry) => entry.url !== failed.url)
					]
				}
			}
		),
		pendingFailed: t.commit(v.object({}), (state) => {
			const current = stateOf(state)
			if (!current.pending.length) return current
			return {
				...current,
				pending: [],
				failed: [
					...current.pending.map(({ url }) => ({
						url,
						error: 'Save interrupted before it finished'
					})),
					...current.failed
				]
			}
		}),
		selected: t.commit(
			v.object({ slug: slugSchema, text: v.pipe(v.string(), v.maxLength(10_000)) }),
			(state, { slug, text }) => ({
				...stateOf(state),
				selection: text.trim() ? { slug, text: text.trim() } : null
			})
		)
	}),
	procedures: (p) => ({
		openUrl: p.procedure({
			audience: 'gui',
			description: 'Open a web URL outside the app.',
			schema: v.object({ url: v.pipe(v.string(), v.maxLength(8192)) }),
			run: ({ url }, handle) => handle.cap.reader.open({ url })
		}),
		save: p.procedure({
			description: 'Save a web URL or pasted Markdown to the reading library.',
			schema: v.object({ input: v.pipe(v.string(), v.minLength(1), v.maxLength(500_000)) }),
			async run({ input }, handle) {
				const pasted = input.trim()
				const url = asUrl(pasted)
				const state = stateOf(handle.state)
				const markdown = url ? null : stripImages(pasted)
				const textKey = markdown === null ? null : sha256(encode(markdown))
				const existing = url
					? await itemByIndexedUrl(handle, state.items, url)
					: await itemByIndexedKey(handle, state.items, 'text', textKey!)
				if (existing) {
					const { seq } = await handle.dispatch({ type: 'saved', params: { item: existing } })
					return handle.settled(seq)
				}
				if (url && state.pending.some((entry) => asUrl(entry.url) === url)) return
				const savedAt = Date.now()
				const startedAt = savedAt
				let slug: string | undefined
				if (url) await handle.dispatch({ type: 'saveStarted', params: { url, startedAt } })
				try {
					const read = url
						? await handle.cap.reader.read({ url })
						: {
								url: null,
								title: markdownTitle(pasted),
								markdown: pasted,
								wordCount: words(pasted)
							}
					const source = url ? (asUrl(read.url ?? url) ?? url) : null
					const fetched = source
						? await itemByIndexedUrl(handle, stateOf(handle.state).items, source)
						: null
					if (fetched) {
						const { seq } = await handle.dispatch({
							type: 'saved',
							params: { item: fetched, startedAt }
						})
						return handle.settled(seq)
					}
					const savedMarkdown = markdown ?? stripImages(read.markdown)
					const kind: ItemKind = source ? 'url' : 'text'
					const key = source ? sha256(source) : textKey!
					slug = await claimSlug(handle, read.title)
					const item: Item = {
						slug,
						title: read.title,
						doc: 'content.md',
						source,
						savedAt,
						read: false,
						words: words(savedMarkdown),
						kind,
						key
					}
					await handle.cap.volume.writeFile(`/${slug}/content.md`, encode(savedMarkdown), {
						parents: false
					})
					await handle.cap.volume.writeFile(`/${slug}/info.json`, encode(info(item)), {
						parents: false
					})
					const saved = await claimIdentity(handle, item)
					if (saved.slug !== item.slug)
						await handle.cap.volume.rm(`/${item.slug}`, {
							recursive: true,
							force: true
						})
					const { seq } = await handle.dispatch({
						type: 'saved',
						params: { item: saved, ...(url ? { startedAt } : {}) }
					})
					return handle.settled(seq)
				} catch (error) {
					if (slug)
						await handle.cap.volume.rm(`/${slug}`, { recursive: true, force: true }).catch(() => {})
					if (!url) throw error
					const { seq } = await handle.dispatch({
						type: 'saveFailed',
						params: { url, startedAt, error: errorText(error) }
					})
					return handle.settled(seq)
				}
			}
		}),
		savePdf: p.procedure({
			audience: 'gui',
			description: 'Save a PDF from the clipboard to the reading library.',
			schema: v.object({
				name: v.pipe(v.string(), v.maxLength(255)),
				data: v.pipe(v.string(), v.minLength(1))
			}),
			async run({ name, data }, handle) {
				const doc = safeName(name) && /\.pdf$/i.test(name) ? name : 'document.pdf'
				const title = fileTitle(doc)
				const bytes = unbase64(data)
				const key = sha256(bytes)
				const existing = await itemByIndexedKey(handle, stateOf(handle.state).items, 'pdf', key)
				if (existing) {
					const { seq } = await handle.dispatch({ type: 'saved', params: { item: existing } })
					return handle.settled(seq)
				}
				const slug = await claimSlug(handle, title)
				const item: Item = {
					slug,
					title,
					doc,
					source: null,
					savedAt: Date.now(),
					read: false,
					words: 0,
					kind: 'pdf',
					key
				}
				try {
					await handle.cap.volume.writeFile(`/${slug}/${doc}`, bytes, {
						parents: false
					})
					await handle.cap.volume.writeFile(`/${slug}/info.json`, encode(info(item)), {
						parents: false
					})
					const saved = await claimIdentity(handle, item)
					if (saved.slug !== item.slug)
						await handle.cap.volume.rm(`/${item.slug}`, {
							recursive: true,
							force: true
						})
					const { seq } = await handle.dispatch({ type: 'saved', params: { item: saved } })
					return handle.settled(seq)
				} catch (error) {
					await handle.cap.volume.rm(`/${slug}`, { recursive: true, force: true }).catch(() => {})
					throw error
				}
			}
		}),
		refresh: p.procedure({
			description: 'Rescan the shared reading folder and update the list.',
			schema: v.object({}),
			async run(_params, handle) {
				if (stateOf(handle.state).pending.length)
					await handle.dispatch({ type: 'pendingFailed', params: {} })

				let entries = await handle.cap.volume.scan({ path: '/', recursive: true })
				const loose = entries.filter(
					(entry) => entry.type === 'file' && /^\/[^/]+$/.test(entry.path)
				)
				for (const entry of loose) {
					const doc = entry.path.slice(1)
					if (!supported(doc)) continue
					const stat = await handle.cap.volume.stat(entry.path)
					const slug = await claimSlug(handle, fileTitle(doc))
					const item: Item = {
						slug,
						title: fileTitle(doc),
						doc,
						source: null,
						savedAt: Number(stat.mtimeNs / 1_000_000n),
						read: false,
						words: 0
					}
					try {
						await handle.cap.volume.writeFile(`/${slug}/info.json`, encode(info(item)), {
							parents: false
						})
						await handle.cap.volume.rename(entry.path, `/${slug}/${doc}`)
					} catch {
						await handle.cap.volume.rm(`/${slug}`, { recursive: true, force: true }).catch(() => {})
					}
				}
				if (loose.length) entries = await handle.cap.volume.scan({ path: '/', recursive: true })

				const folders = entries
					.filter((entry) => entry.type === 'dir' && /^\/[^/]+$/.test(entry.path))
					.map((entry) => entry.path.slice(1))
					.filter((slug) => slug !== '.index')
				const found = (
					await Promise.all(
						folders.map(async (slug): Promise<Item | null> => {
							const files = entries
								.filter(
									(entry) =>
										entry.type === 'file' &&
										entry.path.startsWith(`/${slug}/`) &&
										!entry.path.slice(slug.length + 2).includes('/')
								)
								.map((entry) => entry.path.slice(slug.length + 2))
							const sidecar = await handle.cap.volume
								.readFile(`/${slug}/info.json`)
								.then((bytes) => parseInfo(decode(bytes)))
								.catch(() => null)
							const doc =
								sidecar && safeName(sidecar.doc) && files.includes(sidecar.doc)
									? sidecar.doc
									: files.find(supported)
							if (!doc) return null
							const savedAt =
								sidecar?.savedAt ||
								Number((await handle.cap.volume.stat(`/${slug}/${doc}`)).mtimeNs / 1_000_000n)
							const item = await identifyItem(handle, {
								slug,
								title: sidecar?.title || fileTitle(doc),
								doc,
								source: sidecar?.source ?? null,
								savedAt,
								read: sidecar?.read ?? false,
								words: sidecar?.words ?? 0,
								kind: sidecar?.kind,
								key: sidecar?.key
							})
							if (!sameInfo(sidecar, item))
								await handle.cap.volume.writeFile(`/${slug}/info.json`, encode(info(item)))
							return claimIdentity(handle, item)
						})
					)
				).filter((item): item is Item => item !== null)
				const items = [...new Map(found.map((item) => [item.slug, item])).values()]
				items.sort((a, b) => b.savedAt - a.savedAt)
				const { seq } = await handle.dispatch({ type: 'indexed', params: { items } })
				return handle.settled(seq)
			}
		}),
		read: p.procedure({
			description:
				'Read processed text. Omit params for the item currently open, pass slug for another saved item, or pass url to process a new page without saving it. A matching saved URL is read from the library instead of fetched again.',
			audience: 'agent',
			schema: v.object({
				slug: v.optional(slugSchema),
				url: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)))
			}),
			async run({ slug, url }, handle): Promise<string> {
				if (slug && url) throw new Error('Pass either slug or url, not both')
				const state = stateOf(handle.state)
				const fromItem = async (item: Item): Promise<string> => {
					if (item.doc.toLowerCase().endsWith('.pdf'))
						throw new Error('This PDF has no processed text')
					return decode(await handle.cap.volume.readFile(`/${item.slug}/${item.doc}`))
				}
				if (!url) return fromItem(itemFor(state, slug))

				const source = asUrl(url)
				if (!source) throw new Error('URL must use HTTP or HTTPS')
				const saved = await itemByIndexedUrl(handle, state.items, source)
				if (saved) return fromItem(saved)
				return stripImages((await handle.cap.reader.read({ url: source })).markdown)
			}
		}),
		load: p.procedure({
			audience: 'gui',
			schema: v.object({ slug: slugSchema }),
			async run({ slug }, handle): Promise<ReadDocument> {
				const item = itemFor(stateOf(handle.state), slug)
				const bytes = await handle.cap.volume.readFile(`/${slug}/${item.doc}`)
				return item.doc.toLowerCase().endsWith('.pdf')
					? { kind: 'pdf', bytes }
					: { kind: 'markdown', text: decode(bytes) }
			}
		}),
		select: p.procedure({
			audience: 'gui',
			schema: v.object({ slug: slugSchema, text: v.pipe(v.string(), v.maxLength(10_000)) }),
			async run(params, handle) {
				const { seq } = await handle.dispatch({ type: 'selected', params })
				return handle.settled(seq)
			}
		})
	}),
	subscriptions: (_state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).coalesce().to('treeChanged')
	]
})

export type ReadApp = typeof app

function stateOf(value: ReadState): ReadState {
	const state = value as Partial<ReadState>
	return {
		items: Array.isArray(state.items) ? state.items.filter(isItem) : [],
		current: typeof state.current === 'string' ? state.current : null,
		showRead: state.showRead === true,
		selection:
			state.selection &&
			typeof state.selection.slug === 'string' &&
			typeof state.selection.text === 'string'
				? state.selection
				: null,
		pending: Array.isArray(state.pending)
			? state.pending.filter(
					(entry) => typeof entry?.url === 'string' && typeof entry.startedAt === 'number'
				)
			: [],
		failed: Array.isArray(state.failed)
			? state.failed.filter(
					(entry) => typeof entry?.url === 'string' && typeof entry.error === 'string'
				)
			: [],
		revision: typeof state.revision === 'number' ? state.revision : 0
	}
}

function itemFor(state: ReadState, slug?: string): Item {
	const wanted = slug ?? state.current
	if (!wanted) throw new Error('No reading item is open; pass a slug from the reading list')
	const item = state.items.find((entry) => entry.slug === wanted)
	if (!item || !safeName(item.doc)) throw new Error(`Reading item not found: ${wanted}`)
	return item
}

function isItem(value: unknown): value is Item {
	if (!record(value)) return false
	return (
		typeof value.slug === 'string' &&
		typeof value.title === 'string' &&
		typeof value.doc === 'string' &&
		(value.source === null || typeof value.source === 'string') &&
		typeof value.savedAt === 'number' &&
		typeof value.read === 'boolean' &&
		typeof value.words === 'number' &&
		(value.kind === undefined || isKind(value.kind)) &&
		(value.key === undefined || isKey(value.key))
	)
}

function info(item: Item): string {
	const { slug: _slug, ...sidecar } = item
	return `${JSON.stringify(sidecar, null, '\t')}\n`
}

function parseInfo(text: string): Info | null {
	try {
		const value: unknown = JSON.parse(text)
		if (!record(value) || typeof value.doc !== 'string') return null
		return {
			title: typeof value.title === 'string' ? value.title : '',
			doc: value.doc,
			source: typeof value.source === 'string' ? value.source : null,
			savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
			read: value.read === true,
			words: typeof value.words === 'number' ? value.words : 0,
			kind: isKind(value.kind) ? value.kind : undefined,
			key: isKey(value.key) ? value.key : undefined
		}
	} catch {
		return null
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asUrl(input: string): string | null {
	try {
		const url = new URL(input)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
		url.hash = ''
		return url.href
	} catch {
		return null
	}
}

function itemByUrl(items: Item[], url: string): Item | null {
	const wanted = asUrl(url)
	if (!wanted) return null
	return items.find((item) => item.source && asUrl(item.source) === wanted) ?? null
}

async function itemByIndexedUrl(
	handle: ReadHandle,
	items: Item[],
	url: string
): Promise<Item | null> {
	const key = sha256(url)
	const indexed = await indexedItem(handle, 'url', key, url)
	if (indexed) return indexed

	const old = itemByUrl(items, url)
	if (!old || !(await handle.cap.volume.exists(`/${old.slug}/${old.doc}`))) return null
	const item = { ...old, source: url, kind: 'url' as const, key }
	await handle.cap.volume.writeFile(`/${item.slug}/info.json`, encode(info(item)))
	return claimIdentity(handle, item)
}

async function itemByIndexedKey(
	handle: ReadHandle,
	items: Item[],
	kind: 'text' | 'pdf',
	key: string
): Promise<Item | null> {
	const indexed = await indexedItem(handle, kind, key, key)
	if (indexed) return indexed

	const old = items.find((item) => item.kind === kind && item.key === key)
	if (!old || !(await handle.cap.volume.exists(`/${old.slug}/${old.doc}`))) return null
	return claimIdentity(handle, old)
}

async function indexedItem(
	handle: ReadHandle,
	kind: ItemKind,
	key: string,
	identity: string
): Promise<Item | null> {
	const path = indexPath(kind, key)
	const bytes = await handle.cap.volume.readFile(path).catch(() => null)
	if (!bytes) return null
	const entry = parseIndex(decode(bytes))
	if (!entry) {
		await handle.cap.volume.rm(path, { force: true }).catch(() => {})
		return null
	}
	if (entry.identity !== identity) throw new Error(`Hash collision in ${path}`)

	const sidecar = await handle.cap.volume
		.readFile(`/${entry.slug}/info.json`)
		.then((bytes) => parseInfo(decode(bytes)))
		.catch(() => null)
	if (
		!sidecar ||
		sidecar.kind !== kind ||
		sidecar.key !== key ||
		(kind === 'url' && asUrl(sidecar.source ?? '') !== identity) ||
		!(await handle.cap.volume.exists(`/${entry.slug}/${sidecar.doc}`))
	) {
		await handle.cap.volume.rm(path, { force: true }).catch(() => {})
		return null
	}
	return { slug: entry.slug, ...sidecar }
}

async function identifyItem(handle: ReadHandle, item: Item): Promise<Item> {
	const source = item.source ? asUrl(item.source) : null
	if (source) return { ...item, source, kind: 'url', key: sha256(source) }

	const kind = item.doc.toLowerCase().endsWith('.pdf') ? 'pdf' : 'text'
	if (item.kind === kind && isKey(item.key)) return item
	const bytes = await handle.cap.volume.readFile(`/${item.slug}/${item.doc}`)
	return { ...item, kind, key: sha256(bytes) }
}

// The exclusive index write claims the identity. A loser returns the item that
// won so a save can drop its extra folder before committing state.
async function claimIdentity(handle: ReadHandle, item: Item): Promise<Item> {
	if (!item.kind || !item.key) return item
	const identity = item.kind === 'url' ? asUrl(item.source ?? '') : item.key
	if (!identity) return item
	const path = indexPath(item.kind, item.key)
	const data = encode(`${JSON.stringify({ slug: item.slug, identity }, null, '\t')}\n`)
	for (;;) {
		try {
			await handle.cap.volume.writeFile(path, data, { exclusive: true })
			return item
		} catch (error) {
			if (!errorText(error).startsWith('EEXIST')) throw error
			const existing = await indexedItem(handle, item.kind, item.key, identity)
			if (existing) return existing
		}
	}
}

function sameInfo(sidecar: Info | null, item: Item): boolean {
	return (
		sidecar !== null &&
		sidecar.title === item.title &&
		sidecar.doc === item.doc &&
		sidecar.source === item.source &&
		sidecar.savedAt === item.savedAt &&
		sidecar.read === item.read &&
		sidecar.words === item.words &&
		sidecar.kind === item.kind &&
		sidecar.key === item.key
	)
}

function parseIndex(text: string): IndexEntry | null {
	try {
		const value: unknown = JSON.parse(text)
		return record(value) && isSlug(value.slug) && typeof value.identity === 'string'
			? { slug: value.slug, identity: value.identity }
			: null
	} catch {
		return null
	}
}

function indexPath(kind: ItemKind, key: string): string {
	return `/.index/${kind}/${key}.json`
}

function isKind(value: unknown): value is ItemKind {
	return value === 'url' || value === 'text' || value === 'pdf'
}

function isKey(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isSlug(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)
}

function sha256(value: string | Uint8Array): string {
	const bytes = typeof value === 'string' ? encode(value) : value
	return Array.from(hash(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function claimSlug(handle: ReadHandle, title: string): Promise<string> {
	const base = slugify(title) || 'reading'
	for (let index = 1; ; index++) {
		const slug = index === 1 ? base : `${base}-${index}`
		try {
			await handle.cap.volume.mkdir(`/${slug}`)
			return slug
		} catch (error) {
			if (!errorText(error).startsWith('EEXIST')) throw error
		}
	}
}

function slugify(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 72)
		.replace(/-$/, '')
}

function markdownTitle(markdown: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]
	const first = markdown.split('\n').find((line) => line.trim())
	return (heading ?? first ?? 'Untitled')
		.replace(/[*_`[\]]/g, '')
		.trim()
		.slice(0, 160)
}

function stripImages(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
		.replace(/<img\b[^>]*>/gi, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

function words(value: string): number {
	return value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

function supported(name: string): boolean {
	return /\.(?:md|markdown|txt|pdf)$/i.test(name) && name !== 'info.json'
}

function safeName(name: string): boolean {
	return (
		name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
	)
}

function fileTitle(name: string): string {
	return (
		name
			.replace(/\.[^.]+$/, '')
			.replace(/[-_]+/g, ' ')
			.trim() || name
	)
}

function encode(value: string): Uint8Array {
	return new TextEncoder().encode(value)
}

function decode(value: Uint8Array): string {
	return new TextDecoder().decode(value)
}

function unbase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
