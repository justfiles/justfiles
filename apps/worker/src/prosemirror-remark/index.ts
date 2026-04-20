/**
 * prosemirror-remark
 *
 * A self-contained module bridging the unified/remark ecosystem with ProseMirror.
 * Parses Markdown via remark (with GFM support) into a ProseMirror document,
 * and serializes ProseMirror documents back to Markdown.
 *
 * Designed to be extracted into a standalone package when the project moves
 * to a monorepo structure.
 */

export { markdownToDoc } from './parser'
export { schema } from './schema'
export { docToMarkdown } from './serializer'
