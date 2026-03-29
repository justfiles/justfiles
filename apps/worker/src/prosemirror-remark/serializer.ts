/**
 * Converts a ProseMirror document → Markdown string via unified/remark.
 *
 * Pipeline: PM Node → mdast (Root) → remark-stringify → markdown string
 */

import { unified } from 'unified'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type {
	Root,
	BlockContent,
	PhrasingContent,
	ListItem,
	TableCell,
	TableRow,
	AlignType
} from 'mdast'
import type { Node as PMNode, Mark } from 'prosemirror-model'

const processor = unified().use(remarkGfm).use(remarkStringify, {
	bullet: '-',
	emphasis: '_',
	strong: '*',
	fence: '`',
	fences: true,
	listItemIndent: 'one'
})

export function docToMarkdown(doc: PMNode): string {
	const root = serializeDoc(doc)
	return processor.stringify(root)
}

// ── Document ──────────────────────────────────────────────────────────────────

function serializeDoc(doc: PMNode): Root {
	const children: BlockContent[] = []
	doc.forEach((node) => {
		const block = serializeBlock(node)
		if (block) children.push(block)
	})
	return { type: 'root', children }
}

// ── Block nodes ───────────────────────────────────────────────────────────────

function serializeBlock(node: PMNode): BlockContent | null {
	switch (node.type.name) {
		case 'paragraph':
			return { type: 'paragraph', children: serializeInlineContent(node) }

		case 'heading':
			return {
				type: 'heading',
				depth: (node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6) ?? 1,
				children: serializeInlineContent(node)
			}

		case 'blockquote': {
			const children: BlockContent[] = []
			node.forEach((child) => {
				const b = serializeBlock(child)
				if (b) children.push(b)
			})
			return { type: 'blockquote', children }
		}

		case 'code_block':
			return {
				type: 'code',
				lang: (node.attrs.params as string) || null,
				value: node.textContent
			}

		case 'horizontal_rule':
			return { type: 'thematicBreak' }

		case 'bullet_list':
			return serializeList(node, false)

		case 'ordered_list':
			return serializeList(node, true)

		case 'table':
			return serializeTable(node)

		case 'drawing':
			return {
				type: 'paragraph',
				children: [
					{
						type: 'image',
						url: node.attrs.id as string,
						alt: 'drawing',
						title: null
					}
				]
			}

		default:
			// Unknown block node — preserve text content as a plain paragraph
			// rather than silently dropping it.
			return node.textContent
				? { type: 'paragraph', children: [{ type: 'text', value: node.textContent }] }
				: null
	}
}

// ── List nodes ────────────────────────────────────────────────────────────────

function serializeList(node: PMNode, ordered: boolean) {
	const items: ListItem[] = []
	node.forEach((item) => {
		const children: BlockContent[] = []
		item.forEach((child) => {
			const b = serializeBlock(child)
			if (b) children.push(b)
		})
		const spread = item.childCount > 1
		items.push({ type: 'listItem', spread, children })
	})

	const spread = items.some((i) => i.spread)
	return {
		type: 'list' as const,
		ordered,
		start: ordered ? ((node.attrs.order as number) ?? 1) : null,
		spread,
		children: items
	}
}

// ── Table nodes ───────────────────────────────────────────────────────────────

function serializeTable(node: PMNode) {
	const rows: TableRow[] = []
	const align: AlignType[] = []
	let firstRow = true

	node.forEach((rowNode) => {
		const cells: TableCell[] = []
		rowNode.forEach((cellNode) => {
			if (firstRow) {
				align.push((cellNode.attrs.align as AlignType) ?? null)
			}
			// Markdown table cells are single-line. Collect inline content from
			// all block children (not just the first) so nothing is dropped.
			const inlines: PhrasingContent[] = []
			cellNode.forEach((blockChild) => {
				const block = serializeInlineContent(blockChild)
				if (inlines.length > 0 && block.length > 0) {
					// Separate multiple paragraphs with a space to avoid run-on text
					inlines.push({ type: 'text', value: ' ' })
				}
				inlines.push(...block)
			})
			cells.push({ type: 'tableCell', children: inlines })
		})
		rows.push({ type: 'tableRow', children: cells })
		firstRow = false
	})

	return { type: 'table' as const, align, children: rows }
}

// ── Inline nodes ──────────────────────────────────────────────────────────────

/**
 * Collect all inline (phrasing content) children of a block node.
 */
function serializeInlineContent(node: PMNode): PhrasingContent[] {
	const result: PhrasingContent[] = []
	node.forEach((child) => {
		const phrasing = serializeInline(child)
		if (phrasing) result.push(phrasing)
	})
	return result
}

function serializeInline(node: PMNode): PhrasingContent | null {
	if (node.type.name === 'hard_break') {
		return { type: 'break' }
	}

	if (node.type.name === 'image') {
		return {
			type: 'image',
			url: node.attrs.src as string,
			alt: (node.attrs.alt as string) ?? '',
			title: (node.attrs.title as string) ?? null
		}
	}

	if (node.isText) {
		return wrapWithMarks(node.text!, node.marks)
	}

	// Unknown inline node — fall back to plain text rather than dropping content.
	const text = node.textContent
	return text ? { type: 'text', value: text } : null
}

/**
 * Wraps a plain text string in the appropriate mdast mark nodes.
 * Marks are applied outermost-first (last mark in array = outermost wrapper).
 */
function wrapWithMarks(text: string, marks: readonly Mark[]): PhrasingContent {
	// Start from a plain text node
	let content: PhrasingContent = { type: 'text', value: text }

	// Apply marks from innermost to outermost.
	// `code` mark is special: inlineCode is a leaf with `.value`, not `.children`.
	for (const mark of marks) {
		switch (mark.type.name) {
			case 'code':
				// inlineCode overrides everything — extract the raw text value
				content = { type: 'inlineCode', value: text }
				break
			case 'strong':
				if (content.type === 'inlineCode') break // can't wrap inlineCode
				content = { type: 'strong', children: [content] }
				break
			case 'em':
				if (content.type === 'inlineCode') break
				content = { type: 'emphasis', children: [content] }
				break
			case 'link':
				if (content.type === 'inlineCode') break
				content = {
					type: 'link',
					url: mark.attrs.href as string,
					title: (mark.attrs.title as string) ?? null,
					children: [content]
				}
				break
		}
	}

	return content
}
