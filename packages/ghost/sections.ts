import type { Context } from '@earendil-works/chord/context'
import { LiveDoc, type PromptInput, type PromptSection, section } from '@earendil-works/pi-durable'
import type { Volume } from '@justfiles/fs'
import * as paths from './paths.ts'
import {
	DEFAULT_AGENT_NAME,
	DEFAULT_SOUL,
	EXPRESSION_PROMPT,
	filesystemPrompt,
	MEMORY_PREAMBLE,
	SKILLS_PREAMBLE
} from './prompts.ts'
import { dayBefore, dayInTz, formatInTimezone } from './timezone.ts'
import type { ShellRecord } from './types.ts'

/**
 * The system prompt, in order. Each key is one pi section, so a change resends only that one.
 * The PRD's optional listing of other shells from file mtimes is left out until the agent is
 * seen looking them up again and again; the map names their records and `transcript` reads them.
 */
const KEYS = [
	'soul',
	'filesystem',
	'user',
	'skills',
	'time',
	'memory',
	'recent',
	'expression'
] as const

type Rendered = Record<(typeof KEYS)[number], string | undefined>

interface SectionDeps {
	volume: Volume
	shell: ShellRecord
	/** Names of the built-in tools no shell tool replaced. */
	builtIns: readonly string[]
	/** Names of the shell's tools, which reach the machine instead of the Volume. */
	machineTools: readonly string[]
	/** Whether each day starts a new session. */
	daily: boolean
	timeZone: string
}

/**
 * The ghost's prompt sections. pi renders them before every request; they are read from the
 * Volume once per turn, the answer to one input, and served from that through all of its tool
 * rounds, so they stay byte-stable between turn boundaries, the current time included.
 */
export function ghostSections(deps: SectionDeps): PromptSection[] {
	let turn: { input: string; rendered: Promise<Rendered> } | undefined

	async function rendered(input: PromptInput, context: Context) {
		const live = await input.read.snapshot(LiveDoc, input.conversationId, context)
		// The input the running turn answers; each request of the turn has its own task.
		const answering = String(live?.run?.inputs[0] ?? '')
		if (turn?.input !== answering) {
			const next = render(deps)
			turn = { input: answering, rendered: next }
			// A failed read is not this run's prompt; the next request reads again.
			next.catch(() => {
				if (turn?.rendered === next) turn = undefined
			})
		}
		return turn.rendered
	}

	return KEYS.map((key) =>
		section(key, async (input, context) => (await rendered(input, context))[key], { tag: false })
	)
}

async function render({
	volume,
	shell,
	builtIns,
	machineTools,
	daily,
	timeZone
}: SectionDeps): Promise<Rendered> {
	const now = new Date()
	const today = dayInTz(now, timeZone)
	return {
		soul: (await readText(volume, paths.soul())) ?? DEFAULT_SOUL,
		filesystem: block('# your filesystem', filesystemPrompt(shell, builtIns, machineTools, daily)),
		user: block('# about the user', await readText(volume, paths.PROFILE)),
		skills: block('# skills', await skillsCatalogue(volume)),
		time: block(
			'# current time',
			[
				`Now: ${formatInTimezone(now, timeZone)} (${timeZone}).`,
				'When the user references relative dates ("today", "tomorrow", "next week"), interpret them in this timezone.',
				'If this conversation has been running long enough that the time above may be stale, run `date` to get the current time.'
			].join('\n')
		),
		memory: block('# permanent memory', await readText(volume, paths.MEMORY)),
		recent: block(
			'# memories of the past 2 days',
			await recentNotes(volume, [dayBefore(today), today])
		),
		expression: block('# expression', EXPRESSION_PROMPT)
	}
}

function block(heading: string, body: string | undefined): string | undefined {
	return body?.trim() ? `${heading}\n\n${body.trim()}` : undefined
}

async function recentNotes(volume: Volume, days: string[]): Promise<string | undefined> {
	const notes = (await dailyNotes(volume, days)).map(
		({ day, shell, text }) => `## ${day}, shell ${shell}\n\n${text}`
	)
	return notes.length === 0 ? undefined : [MEMORY_PREAMBLE, ...notes].join('\n\n')
}

/** Every shell's daily notes for `days`, oldest first, empty files left out. */
export async function dailyNotes(
	volume: Volume,
	days: readonly string[]
): Promise<{ day: string; shell: string; text: string }[]> {
	const notes: { day: string; shell: string; text: string }[] = []
	for (const name of await names(volume, paths.DAILY_DIR)) {
		const day = days.find((day) => name.startsWith(`${day}.`) && name.endsWith('.md'))
		if (day === undefined) continue
		const text = (await readText(volume, `${paths.DAILY_DIR}/${name}`))?.trim()
		if (text) notes.push({ day, shell: name.slice(day.length + 1, -'.md'.length), text })
	}
	return notes
}

/**
 * User skills under /system/skills: a directory `<id>/SKILL.md` or a file `<id>.md`, listed
 * from their frontmatter. The agent reads a body with `read` when it needs it.
 */
async function skillsCatalogue(volume: Volume): Promise<string | undefined> {
	const lines: string[] = []
	for (const name of await names(volume, paths.SKILLS_DIR)) {
		const path = name.endsWith('.md')
			? `${paths.SKILLS_DIR}/${name}`
			: `${paths.SKILLS_DIR}/${name}/SKILL.md`
		// A directory without SKILL.md, or a file that is not markdown, is not a skill.
		const text = await readText(volume, path)
		if (text === undefined) continue
		const meta = parseFrontmatter(text)
		lines.push(
			`- ${meta.name || name.replace(/\.md$/, '')} (\`${path}\`) — ${meta.description ?? ''}`
		)
	}
	return lines.length === 0 ? undefined : [SKILLS_PREAMBLE, ...lines].join('\n')
}

/** What the agent is called: `agent_name` in its soul's frontmatter. */
export async function agentName(volume: Pick<Volume, 'readFile'>): Promise<string> {
	const soul = (await readText(volume, paths.soul())) ?? DEFAULT_SOUL
	return parseFrontmatter(soul).agent_name || DEFAULT_AGENT_NAME
}

/** A directory's entry names, sorted so the prompt is the same on every backend; none if missing. */
export async function names(volume: Volume, dir: string): Promise<string[]> {
	try {
		return (await volume.readdir(dir)).map((entry) => entry.name).sort()
	} catch (error) {
		if (isMissing(error)) return []
		throw error
	}
}

/** A file's text; undefined when it does not exist or is a directory. */
export async function readText(
	volume: Pick<Volume, 'readFile'>,
	path: string
): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await volume.readFile(path))
	} catch (error) {
		if (isMissing(error) || (error instanceof Error && error.message.startsWith('EISDIR')))
			return undefined
		throw error
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && /^(ENOENT|ENOTDIR)/.test(error.message)
}

function parseFrontmatter(text: string): Record<string, string> {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
	if (!match) return {}
	const out: Record<string, string> = {}
	for (const line of (match[1] ?? '').split(/\r?\n/)) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		if (key) out[key] = line.slice(idx + 1).trim()
	}
	return out
}
