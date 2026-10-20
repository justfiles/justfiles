import type { Message, Models } from '@earendil-works/pi-ai'
import type { Volume } from '@justfiles/fs'
import * as paths from './paths.ts'
import { NOTE_TAKING_PROMPT } from './prompts.ts'
import { readText } from './sections.ts'
import { dayInTz } from './timezone.ts'
import { text } from './transcript.ts'

interface NoteDeps {
	volume: Volume
	models: Models
	model: { provider: string; modelId: string } | undefined
	shellId: string
	timeZone: string
}

/** Notes taken before entries leave the model's context, kept in this shell's daily file. */
export function createNotes({ volume, models, model, shellId, timeZone }: NoteDeps) {
	let appending: Promise<void> = Promise.resolve()
	return { take, append }

	/** The note-taking prompt over `messages`: the notes, '' when there are none. Throws on a model error. */
	async function take(messages: readonly Message[], signal?: AbortSignal): Promise<string> {
		const conversation = serialize(messages)
		const resolved = model && models.getModel(model.provider, model.modelId)
		if (conversation === '' || !resolved) return ''
		const answer = await models.complete(
			resolved,
			{
				systemPrompt: NOTE_TAKING_PROMPT,
				messages: [{ role: 'user', content: conversation, timestamp: Date.now() }]
			},
			{ signal }
		)
		if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
			throw new Error(answer.errorMessage ?? `Note-taking stopped: ${answer.stopReason}`)
		return text(answer.content).trim()
	}

	/** Append `notes` to today's daily file, dropping paragraphs it already holds. One at a time. */
	function append(notes: string): Promise<void> {
		const next = appending.then(() => appendNew(notes))
		appending = next.catch(() => {})
		return next
	}

	async function appendNew(notes: string): Promise<void> {
		const path = paths.daily(dayInTz(new Date(), timeZone), shellId)
		const existing = (await readText(volume, path)) ?? ''
		const seen = new Set(paragraphs(existing))
		const fresh = paragraphs(notes).filter((paragraph) => {
			if (seen.has(paragraph)) return false
			seen.add(paragraph)
			return true
		})
		if (fresh.length === 0) return
		await volume.mkdir(paths.DAILY_DIR, { recursive: true })
		const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
		await volume.appendFile(path, new TextEncoder().encode(`${separator}${fresh.join('\n\n')}\n`))
	}
}

function paragraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== '')
}

/** What was said, as plain text, so the note-taker reads a transcript instead of continuing it. */
function serialize(messages: readonly Message[]): string {
	const parts: string[] = []
	for (const message of messages) {
		if (message.role !== 'user' && message.role !== 'assistant') continue
		const said = text(message.content).trim()
		if (said !== '') parts.push(`[${message.role === 'user' ? 'User' : 'Assistant'}]: ${said}`)
	}
	return parts.join('\n\n')
}
