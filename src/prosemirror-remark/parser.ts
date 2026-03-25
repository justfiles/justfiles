/**
 * Converts Markdown text → ProseMirror document via unified/remark.
 *
 * Pipeline: markdown string → mdast (remark-parse + remark-gfm) → PM Node
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type {
	Root,
	BlockContent,
	DefinitionContent,
	PhrasingContent,
	List,
	Table
} from 'mdast'
import { type Schema, type Node as PMNode, type Mark, Fragment } from 'prosemirror-model'

// Single shared processor — stateless after construction
const processor = unified().use(remarkParse).use(remarkGfm)

export function markdownToDoc(markdown: string, schema: Schema): PMNode {
	const ast = processor.parse(markdown) as Root
	const blocks = convertBlocks(ast.children as (BlockContent | DefinitionContent)[], schema)
	// Ensure doc always has at least one block
	const content = blocks.length > 0 ? blocks : [schema.nodes.paragraph.createAndFill()!]
	return schema.nodes.doc.create(null, content)
}

// ── Block conversion ──────────────────────────────────────────────────────────

function convertBlocks(
	nodes: (BlockContent | DefinitionContent)[],
	schema: Schema
): PMNode[] {
	return nodes.flatMap((node) => {
		const result = convertBlock(node, schema)
		if (!result) return []
		return Array.isArray(result) ? result : [result]
	})
}

// Returns PMNode[] to allow unknown containers to flatten their children inline.
function convertBlock(
	node: BlockContent | DefinitionContent,
	schema: Schema
): PMNode | PMNode[] | null {
	switch (node.type) {
		case 'paragraph':
			return schema.nodes.paragraph.create(
				null,
				convertInlines(node.children, schema, [])
			)

		case 'heading':
			return schema.nodes.heading.create(
				{ level: node.depth },
				convertInlines(node.children, schema, [])
			)

		case 'blockquote':
			return schema.nodes.blockquote.create(
				null,
				convertBlocks(node.children, schema)
			)

		case 'code':
			return schema.nodes.code_block.create(
				{ params: node.lang ?? '' },
				node.value ? [schema.text(node.value)] : []
			)

		case 'thematicBreak':
			return schema.nodes.horizontal_rule.create()

		case 'list':
			return convertList(node, schema)

		case 'table':
			return convertTable(node, schema)

		default: {
			const n = node as unknown as Record<string, unknown>

			// Raw HTML blocks and any other value-only node — preserve as plain text
			// in a paragraph rather than silently dropping the content.
			if (typeof n.value === 'string') {
				const text = (n.value as string).trim()
				return text
					? schema.nodes.paragraph.create(null, [schema.text(text)])
					: null
			}

			// Unknown container nodes (e.g. footnoteDefinition) — flatten children
			// into the surrounding block flow so their content is not lost.
			if (Array.isArray(n.children)) {
				return convertBlocks(n.children as (BlockContent | DefinitionContent)[], schema)
			}

			return null
		}
	}
}

// ── List conversion ───────────────────────────────────────────────────────────

function convertList(node: List, schema: Schema): PMNode {
	const tight = !node.spread && node.children.every((item) => !item.spread)

	const items = node.children.map((item) => {
		const children =
			item.children.length > 0
				? convertBlocks(item.children as (BlockContent | DefinitionContent)[], schema)
				: [schema.nodes.paragraph.createAndFill()!]
		return schema.nodes.list_item.create(null, children)
	})

	if (node.ordered) {
		return schema.nodes.ordered_list.create(
			{ order: node.start ?? 1, tight },
			items
		)
	}
	return schema.nodes.bullet_list.create({ tight }, items)
}

// ── Table conversion ──────────────────────────────────────────────────────────

function convertTable(node: Table, schema: Schema): PMNode {
	const align = node.align ?? []

	const rows = node.children.map((row, rowIndex) => {
		const isHeader = rowIndex === 0
		const cellType = isHeader ? schema.nodes.table_header : schema.nodes.table_cell

		const cells = row.children.map((cell, colIndex) => {
			const inlines = convertInlines(cell.children as PhrasingContent[], schema, [])
			const para = schema.nodes.paragraph.create(null, inlines)
			return cellType.create({ align: align[colIndex] ?? null }, para)
		})

		return schema.nodes.table_row.create(null, cells)
	})

	return schema.nodes.table.create(null, rows)
}

// ── Inline conversion ─────────────────────────────────────────────────────────

function convertInlines(
	nodes: PhrasingContent[],
	schema: Schema,
	marks: readonly Mark[]
): PMNode[] {
	return nodes.flatMap((node) => convertInline(node, schema, marks))
}

function convertInline(
	node: PhrasingContent,
	schema: Schema,
	marks: readonly Mark[]
): PMNode[] {
	switch (node.type) {
		case 'text':
			return node.value ? [schema.text(node.value, marks as Mark[])] : []

		case 'inlineCode':
			return [schema.text(node.value, addMark(marks, schema.marks.code.create()))]

		case 'strong':
			return convertInlines(
				node.children,
				schema,
				addMark(marks, schema.marks.strong.create())
			)

		case 'emphasis':
			return convertInlines(
				node.children,
				schema,
				addMark(marks, schema.marks.em.create())
			)

		case 'link':
			return convertInlines(
				node.children,
				schema,
				addMark(marks, schema.marks.link.create({ href: node.url, title: node.title ?? null }))
			)

		case 'image':
			return [
				schema.nodes.image.create({
					src: node.url,
					alt: node.alt ?? null,
					title: node.title ?? null
				})
			]

		case 'break':
			return [schema.nodes.hard_break.create(null, Fragment.empty, marks as Mark[])]

		// imageReference: no href available, fall back to alt text to avoid data loss
		case 'imageReference':
			return node.alt ? [schema.text(node.alt, marks as Mark[])] : []

		// linkReference / delete / html (inline) / footnoteReference / etc.
		// — recurse into children (preserves text, loses structural marks)
		// — for leaf value nodes fall back to plain text
		default: {
			const n = node as unknown as Record<string, unknown>
			if (Array.isArray(n.children)) {
				return convertInlines(n.children as PhrasingContent[], schema, marks)
			}
			if (typeof n.value === 'string') {
				return n.value ? [schema.text(n.value as string, marks as Mark[])] : []
			}
			return []
		}
	}
}

function addMark(existing: readonly Mark[], mark: Mark): readonly Mark[] {
	return mark.addToSet(existing as Mark[])
}
