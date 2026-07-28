/**
 * Skills — markdown guides the agent loads on demand (pi's progressive-disclosure
 * model). A skill is identity + routing + a lazily-loaded body:
 *
 *   - meta (id, name, description) is cheap and always in the system prompt;
 *   - the body is fetched only when the agent calls `read_skill`, never held resident.
 *
 * Two source kinds feed one registry:
 *   - createVolumeSkillSource — user-authored skills under /system/skills (cross-platform);
 *   - createManifestSkillSource — built-in skills (a resident manifest + a body loader).
 *
 * Docs are NOT skills — see docs.ts. A doc is a system-prompt line plus a `read_doc` tool,
 * a separate, host-agnostic feature with its own hand-maintained catalogue.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Volume } from '@justfiles/fs'
import Type from 'typebox'
import { file } from './file.ts'
import { parseFrontmatter } from './markdown.ts'
import { SKILLS_DIR } from './paths.ts'

export interface SkillMeta {
	id: string
	name: string
	description: string
}

export interface SkillSource {
	list(): Promise<SkillMeta[]>
	load(id: string): Promise<string>
}

// User/project skills on the Volume — cross-platform (both hosts implement the same
// Volume interface). A skill is a directory `<id>/SKILL.md` or a single file `<id>.md`.
// Only frontmatter is read for listing; the body is read on demand in `load`.
export function createVolumeSkillSource(volume: Volume): SkillSource {
	return { list, load }

	async function list(): Promise<SkillMeta[]> {
		let entries: Awaited<ReturnType<Volume['readdir']>>
		try {
			entries = await volume.readdir(SKILLS_DIR)
		} catch {
			return [] // no skills dir yet
		}
		const out: SkillMeta[] = []
		for (const entry of entries) {
			// FileType.Directory === 1 (not exported from @justfiles/fs; see tools.ts).
			const isDir = entry.type === 1
			if (!isDir && !entry.name.endsWith('.md')) continue
			const id = isDir ? entry.name : entry.name.slice(0, -'.md'.length)
			const text = await file(volume, skillPath(id, isDir)).text()
			if (text === null) continue // a directory without SKILL.md is not a skill
			const fm = parseFrontmatter(text)
			out.push({ id, name: fm.name || id, description: fm.description || '' })
		}
		return out
	}

	async function load(id: string): Promise<string> {
		const text =
			(await file(volume, skillPath(id, true)).text()) ??
			(await file(volume, skillPath(id, false)).text())
		if (text === null) throw new Error(`Skill "${id}" not found`)
		return text
	}

	function skillPath(id: string, isDir: boolean): string {
		return isDir ? `${SKILLS_DIR}/${id}/SKILL.md` : `${SKILLS_DIR}/${id}.md`
	}
}

// Built-in skills the host/agent ships: a resident manifest plus a loader that fetches a body
// on demand. The counterpart to volume (user-authored) skills.
export function createManifestSkillSource(
	manifest: SkillMeta[],
	load: (id: string) => Promise<string>
): SkillSource {
	return { list: async () => manifest, load }
}

export interface SkillRegistry {
	// The system-prompt block listing every skill's id + description (empty if none).
	index(): Promise<string>
	// Body for one skill id, dispatched to the source that owns it.
	read(id: string): Promise<string>
	// The merged skill metas (id + name + description), id-collisions resolved as in
	// index(). A host projects these into its own menu — skills are not commands.
	list(): Promise<SkillMeta[]>
}

// Merges sources into one catalog. Earlier sources win on id collision, so a user's
// volume skill shadows a built-in of the same id.
export function createSkillRegistry(sources: SkillSource[]): SkillRegistry {
	return { index, read, list }

	async function list(): Promise<SkillMeta[]> {
		return (await collect()).map(({ meta }) => meta)
	}

	async function collect(): Promise<{ meta: SkillMeta; source: SkillSource }[]> {
		const out: { meta: SkillMeta; source: SkillSource }[] = []
		const seen = new Set<string>()
		for (const source of sources) {
			for (const meta of await source.list()) {
				if (seen.has(meta.id)) continue
				seen.add(meta.id)
				out.push({ meta, source })
			}
		}
		return out
	}

	async function index(): Promise<string> {
		const all = await collect()
		if (all.length === 0) return ''
		const lines = all.map(({ meta }) => `- ${meta.name} (id: \`${meta.id}\`) — ${meta.description}`)
		return [
			"Focused guides loaded on demand. When a task matches a skill's description, call `read_skill` with its id to load the full instructions BEFORE you act.",
			...lines
		].join('\n')
	}

	async function read(id: string): Promise<string> {
		const all = await collect()
		const hit = all.find(({ meta }) => meta.id === id)
		if (!hit) throw new Error(`Unknown skill "${id}".`)
		return hit.source.load(id)
	}
}

const readSkillParams = Type.Object({
	id: Type.String({ description: 'The skill id, exactly as shown in the skills list.' })
})

// The skill registry a Volume-backed host exposes: the ONE place that names the sources
// (user skills on the Volume today; built-in manifest sources later), so `createAssistant`
// and `listSkills` never drift. Package-internal — hosts use `createAssistant` / `listSkills`.
export function createVolumeSkillRegistry(volume: Volume): SkillRegistry {
	return createSkillRegistry([createVolumeSkillSource(volume)])
}

// Cheap, LLM-free enumeration of the user's Volume skills, so a host can render its `/`
// menu (or any picker) WITHOUT building the full Assistant. Reuses the shared registry
// factory so it can't drift from what the agent reads. Skills are not commands: the host
// decides how to project these metas into whatever surface it owns.
export async function listSkills(volume: Volume): Promise<SkillMeta[]> {
	return createVolumeSkillRegistry(volume).list()
}

export function createReadSkillTool(registry: SkillRegistry): AgentTool<typeof readSkillParams> {
	return {
		name: 'read_skill',
		label: 'Read Skill',
		description:
			'Load the full instructions for one of the available skills by its id, then follow what it says. Call this before performing a task a skill covers.',
		parameters: readSkillParams,
		async execute(_toolCallId, params) {
			const content = await registry.read(params.id)
			return {
				content: [{ type: 'text', text: content }],
				details: { id: params.id, size: content.length }
			}
		}
	}
}
