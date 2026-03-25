/**
 * ProseMirror schema for CommonMark + GFM tables.
 *
 * Matches the node/mark names of prosemirror-markdown's default schema
 * (so existing stored JSON documents remain compatible) while adding
 * table, table_row, table_cell, and table_header from prosemirror-tables.
 */

import { Schema } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

const tNodes = tableNodes({
	tableGroup: 'block',
	cellContent: 'block+',
	cellAttributes: {
		align: {
			default: null,
			getFromDOM(dom) {
				return (dom as HTMLElement).style.textAlign || null
			},
			setDOMAttr(value, attrs) {
				if (value) attrs.style = `text-align: ${value}`
			}
		}
	}
})

export const schema = new Schema({
	nodes: {
		doc: {
			content: 'block+'
		},

		paragraph: {
			content: 'inline*',
			group: 'block',
			parseDOM: [{ tag: 'p' }],
			toDOM() {
				return ['p', 0] as const
			}
		},

		blockquote: {
			content: 'block+',
			group: 'block',
			defining: true,
			parseDOM: [{ tag: 'blockquote' }],
			toDOM() {
				return ['blockquote', 0] as const
			}
		},

		horizontal_rule: {
			group: 'block',
			parseDOM: [{ tag: 'hr' }],
			toDOM() {
				return ['hr'] as const
			}
		},

		heading: {
			attrs: { level: { default: 1 } },
			content: '(text | image)*',
			group: 'block',
			defining: true,
			parseDOM: [
				{ tag: 'h1', attrs: { level: 1 } },
				{ tag: 'h2', attrs: { level: 2 } },
				{ tag: 'h3', attrs: { level: 3 } },
				{ tag: 'h4', attrs: { level: 4 } },
				{ tag: 'h5', attrs: { level: 5 } },
				{ tag: 'h6', attrs: { level: 6 } }
			],
			toDOM(node) {
				return [`h${node.attrs.level as number}`, 0] as const
			}
		},

		code_block: {
			attrs: { params: { default: '' } },
			content: 'text*',
			marks: '',
			group: 'block',
			code: true,
			defining: true,
			parseDOM: [
				{
					tag: 'pre',
					preserveWhitespace: 'full' as const,
					getAttrs: (node) => ({ params: (node as HTMLElement).getAttribute('data-params') || '' })
				}
			],
			toDOM(node) {
				return ['pre', node.attrs.params ? { 'data-params': node.attrs.params } : {}, ['code', 0]] as const
			}
		},

		ordered_list: {
			attrs: { order: { default: 1 }, tight: { default: false } },
			content: 'list_item+',
			group: 'block',
			parseDOM: [
				{
					tag: 'ol',
					getAttrs(dom) {
						const el = dom as HTMLElement
						return {
							order: el.hasAttribute('start') ? +(el.getAttribute('start') ?? 1) : 1,
							tight: el.hasAttribute('data-tight')
						}
					}
				}
			],
			toDOM(node) {
				return [
					'ol',
					{
						start: node.attrs.order === 1 ? null : node.attrs.order,
						'data-tight': node.attrs.tight ? 'true' : null
					},
					0
				] as const
			}
		},

		bullet_list: {
			attrs: { tight: { default: false } },
			content: 'list_item+',
			group: 'block',
			parseDOM: [
				{
					tag: 'ul',
					getAttrs: (dom) => ({ tight: (dom as HTMLElement).hasAttribute('data-tight') })
				}
			],
			toDOM(node) {
				return ['ul', { 'data-tight': node.attrs.tight ? 'true' : null }, 0] as const
			}
		},

		list_item: {
			content: 'block+',
			defining: true,
			parseDOM: [{ tag: 'li' }],
			toDOM() {
				return ['li', 0] as const
			}
		},

		// Table nodes from prosemirror-tables (table, table_row, table_cell, table_header)
		...tNodes,

		text: {
			group: 'inline'
		},

		image: {
			attrs: {
				src: {},
				alt: { default: null },
				title: { default: null }
			},
			inline: true,
			group: 'inline',
			draggable: true,
			parseDOM: [
				{
					tag: 'img[src]',
					getAttrs(dom) {
						const el = dom as HTMLElement
						return {
							src: el.getAttribute('src'),
							alt: el.getAttribute('alt'),
							title: el.getAttribute('title')
						}
					}
				}
			],
			toDOM(node) {
				return ['img', node.attrs]
			}
		},

		hard_break: {
			inline: true,
			group: 'inline',
			selectable: false,
			parseDOM: [{ tag: 'br' }],
			toDOM() {
				return ['br'] as const
			}
		}
	},

	marks: {
		em: {
			parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
			toDOM() {
				return ['em', 0] as const
			}
		},

		strong: {
			parseDOM: [{ tag: 'b' }, { tag: 'strong' }, { style: 'font-weight=bold' }],
			toDOM() {
				return ['strong', 0] as const
			}
		},

		link: {
			attrs: {
				href: {},
				title: { default: null }
			},
			inclusive: false,
			parseDOM: [
				{
					tag: 'a[href]',
					getAttrs(dom) {
						const el = dom as HTMLElement
						return {
							href: el.getAttribute('href'),
							title: el.getAttribute('title')
						}
					}
				}
			],
			toDOM(mark) {
				return ['a', mark.attrs, 0] as const
			}
		},

		code: {
			parseDOM: [{ tag: 'code' }],
			toDOM() {
				return ['code', 0] as const
			}
		}
	}
})
