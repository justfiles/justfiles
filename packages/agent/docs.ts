/**
 * Docs — the project documentation the agent can read. NOT skills: a doc is just a line in
 * the system prompt plus a `read_doc` tool to load its body. The catalogue below is
 * hand-maintained (à la pi's system-prompt docs block), so a doc is opt-in: files under
 * `docs/` exist for the website (apps/docs) and carry whatever frontmatter Starlight wants;
 * a doc is invisible to the agent until it is listed here. Forgetting to list one fails safe
 * (skipped), never the reverse.
 *
 * The host supplies only a reader for the bytes (disk on quay, asset fetch on frieren); the
 * catalogue and the prompt block are shared across hosts.
 *
 * `id` is the doc path under `docs/` without `.md` (the host reads `docs/<id>.md`). `name` is
 * a short handle; `description` is the agent's cue for WHEN to read it — write it as a
 * when-to-read trigger, not a summary. Keep this list short and high-signal.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import Type from 'typebox'

export interface DocRef {
	id: string
	name: string
	description: string
}

export const DOCS: DocRef[] = [
	{
		id: 'app',
		name: 'how apps work',
		description:
			'How @justfiles/app works — the app model, kernel, sandbox, reducers, and capabilities. Read before building, editing, or explaining an app.'
	},
	{
		id: 'fs',
		name: 'the filesystem',
		description:
			'How @justfiles/fs works — storage backends, the path-based volume API, and sync. Read for anything about reading/writing files or the volume an app stores state in.'
	},
	{
		id: 'design',
		name: 'styling and shell',
		description:
			'Shared CSS tokens and platform styling (@justfiles/design). Read when building an app UI or matching the desktop look.'
	},
	{
		id: 'overview',
		name: 'system overview',
		description:
			'High-level map of how the hosts and packages fit together. Read for a general "how does this whole thing work" question.'
	}
]

// The system-prompt block: one line per doc. The agent reads a doc with the read_doc tool.
export function docsPrompt(docs: readonly DocRef[] = DOCS): string {
	return [
		'Project documentation, loaded on demand. When a request relates to one of these, call `read_doc` with its id to read it BEFORE you act:',
		...docs.map((doc) => `- ${doc.name} (id: \`${doc.id}\`) — ${doc.description}`)
	].join('\n')
}

const readDocParams = Type.Object({
	id: Type.String({ description: 'The doc id, exactly as shown in the docs list.' })
})

export function createReadDocTool(
	read: (id: string) => Promise<string>
): AgentTool<typeof readDocParams> {
	return {
		name: 'read_doc',
		label: 'Read Doc',
		description:
			'Read one of the available docs by its id to load its full contents, then follow what it says.',
		parameters: readDocParams,
		async execute(_toolCallId, params) {
			const content = await read(params.id)
			return {
				content: [{ type: 'text', text: content }],
				details: { id: params.id, size: content.length }
			}
		}
	}
}
