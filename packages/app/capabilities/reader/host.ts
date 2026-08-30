import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import { reader } from './index.ts'

const ENDPOINT = 'https://readable.page/md'
const MAX_BYTES = 20 * 1024 * 1024

interface ReaderHostDeps {
	fetch?: typeof fetch
}

type Meta = {
	title?: string
	siteName?: string
	byline?: string
	publishedAt?: number
}

export function readerHost(deps: ReaderHostDeps = {}) {
	return implementCapability(reader, {
		read: async (_ctx, { url }) => readUrl(url, deps),
		open: () => {
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'reader', 'open')
		}
	})
}

async function readUrl(input: string, deps: ReaderHostDeps) {
	const requested = webUrl(input)
	const endpoint = new URL(ENDPOINT)
	endpoint.searchParams.set('url', requested.href)
	const response = await (deps.fetch ?? fetch)(endpoint, {
		headers: { accept: 'text/markdown' }
	})
	if (!response.ok) throw new Error(`readable.page returned ${response.status}`)

	const parsed = frontmatter(await boundedText(response))
	if (!parsed.markdown) throw new Error('readable.page returned no content')
	return result(requested, parsed.markdown, parsed.meta)
}

function result(url: URL, markdown: string, meta: Meta) {
	const title = meta.title?.trim() || heading(markdown) || fileTitle(url)
	return {
		url: url.href,
		title,
		markdown,
		...(meta.siteName ? { siteName: meta.siteName } : {}),
		...(meta.byline ? { byline: meta.byline } : {}),
		...(meta.publishedAt ? { publishedAt: meta.publishedAt } : {}),
		wordCount: wordCount(markdown)
	}
}

async function boundedText(response: Response): Promise<string> {
	const length = Number(response.headers.get('content-length'))
	if (Number.isFinite(length) && length > MAX_BYTES)
		throw new Error('document is larger than 20 MB')
	if (!response.body) return ''

	const chunks: ArrayBuffer[] = []
	let size = 0
	for await (const chunk of response.body) {
		size += chunk.byteLength
		if (size > MAX_BYTES) throw new Error('document is larger than 20 MB')
		chunks.push(Uint8Array.from(chunk).buffer)
	}
	return new Blob(chunks).text()
}

function webUrl(input: string): URL {
	const url = new URL(input)
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new Error('URL must use HTTP or HTTPS')
	url.hash = ''
	return url
}

function fileTitle(url: URL): string {
	const part = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname)
	return (
		part
			.replace(/\.[^.]+$/, '')
			.replace(/[-_]+/g, ' ')
			.trim() || url.hostname
	)
}

function heading(markdown: string): string | undefined {
	return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
}

function wordCount(markdown: string): number {
	return markdown.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

function frontmatter(markdown: string): { markdown: string; meta: Meta } {
	const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
	if (!match) return { markdown: markdown.trim(), meta: {} }
	const fields = new Map<string, string>()
	for (const line of match[1]?.split('\n') ?? []) {
		const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
		if (field?.[1]) fields.set(field[1].toLowerCase(), unquote(field[2] ?? ''))
	}
	return {
		markdown: markdown.slice(match[0].length).trim(),
		meta: {
			title: fields.get('title'),
			siteName: fields.get('sitename') ?? fields.get('site_name'),
			byline: fields.get('byline') ?? fields.get('author'),
			publishedAt: date(fields.get('publishedat') ?? fields.get('date'))
		}
	}
}

function date(value: string | undefined): number | undefined {
	if (!value) return undefined
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function unquote(value: string): string {
	const trimmed = value.trim()
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	)
		return trimmed.slice(1, -1)
	return trimmed
}
