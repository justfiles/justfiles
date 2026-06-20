// Generic agent tools that reach email/calendar through the kernel's use-facet
// capabilities — the exact path an app uses. The agent holds a `Capability`, never
// a credential: the provider mints the impl host-side and the multi-account
// fan-out lives in the use-facet host (email.listUnread/readDetail/markRead,
// calendar.listToday). Read-only surface only; the creds-bearing CLI commands they
// replace are retired in the storage cut-over.

import { DEFAULT_TIMEZONE, isoToTimezone } from '@justfiles/agent'
import { type Capability, CapabilityError } from '@justfiles/app/capabilities'
import type { CalendarEvent } from '@justfiles/app/capabilities/calendar'
import type { EmailDetail, EmailSummary } from '@justfiles/app/capabilities/email'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import Type from 'typebox'

// The use facets ignore ctx (appId/scopes); this names the caller for clarity only.
const AGENT_APP_ID = 'agent'

const emailParams = Type.Object({
	action: Type.Union([Type.Literal('list'), Type.Literal('read'), Type.Literal('mark-read')], {
		description:
			"'list' unread mail, 'read' one message's full body by id, or 'mark-read' a message by id."
	}),
	id: Type.Optional(Type.String({ description: 'Message id (required for read and mark-read).' })),
	accountId: Type.Optional(
		Type.String({
			description:
				'Restrict to one account (from a list result). Omit to span all connected accounts.'
		})
	),
	limit: Type.Optional(Type.Number({ description: 'Max messages for list (default 20).' }))
})

const calendarParams = Type.Object({
	accountId: Type.Optional(
		Type.String({ description: 'Restrict to one calendar account. Omit to span all.' })
	)
})

type AccountTool = AgentTool<typeof emailParams> | AgentTool<typeof calendarParams>

export function accountTools(deps: {
	email: Capability
	calendar: Capability
	getTimezone: () => string | Promise<string>
}): AccountTool[] {
	const invoke = (cap: Capability, capability: string, method: string, input: unknown) =>
		cap.invoke({ appId: AGENT_APP_ID, capability, method, args: [input], scopes: [] })
	const tz = async () => (await deps.getTimezone()) || DEFAULT_TIMEZONE
	const at = (epochMs: number, zone: string) => isoToTimezone(new Date(epochMs).toISOString(), zone)
	// UNAVAILABLE = no account backs the capability; surface it as text so the agent
	// can tell the user to connect one rather than seeing an opaque tool failure.
	const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }], details: {} })

	const email: AgentTool<typeof emailParams> = {
		name: 'email',
		label: 'Email',
		description:
			'Read the user’s email across connected accounts. List unread messages, read one in full, or mark one read. Read-only — no sending.',
		parameters: emailParams,
		async execute(_id, params) {
			try {
				if (params.action === 'list') {
					const items = (await invoke(deps.email, 'email', 'listUnread', {
						limit: params.limit ?? 20,
						accountId: params.accountId
					})) as EmailSummary[]
					if (items.length === 0) return text('(no unread mail)')
					const zone = await tz()
					return text(
						items
							.map((e) => `${e.id}\t${at(e.receivedAt, zone)}\t${e.from}\t${e.subject}`)
							.join('\n')
					)
				}
				if (!params.id) return text(`${params.action}: missing required id`)
				if (params.action === 'mark-read') {
					await invoke(deps.email, 'email', 'markRead', {
						id: params.id,
						accountId: params.accountId
					})
					return text(`marked ${params.id} as read`)
				}
				const d = (await invoke(deps.email, 'email', 'readDetail', {
					id: params.id,
					accountId: params.accountId,
					purpose: 'summarization'
				})) as EmailDetail
				const zone = await tz()
				return text(
					[
						`From: ${d.from}`,
						`Subject: ${d.subject}`,
						`Date: ${at(d.receivedAt, zone)}`,
						'',
						d.bodyText
					].join('\n')
				)
			} catch (error) {
				return text(toMessage(error, 'email'))
			}
		}
	}

	const calendar: AgentTool<typeof calendarParams> = {
		name: 'calendar',
		label: 'Calendar',
		description: 'List the user’s events for today across connected calendar accounts. Read-only.',
		parameters: calendarParams,
		async execute(_id, params) {
			try {
				const zone = await tz()
				const events = (await invoke(deps.calendar, 'calendar', 'listToday', {
					timezone: zone,
					accountId: params.accountId
				})) as CalendarEvent[]
				if (events.length === 0) return text('(no events today)')
				return text(
					events
						.map((e) => {
							const loc = e.location ? `\t${e.location}` : ''
							return `${e.id}\t${at(e.startsAt, zone)}–${at(e.endsAt, zone)}\t${e.title}${loc}`
						})
						.join('\n')
				)
			} catch (error) {
				return text(toMessage(error, 'calendar'))
			}
		}
	}

	return [email, calendar]
}

function toMessage(error: unknown, capability: string): string {
	if (error instanceof CapabilityError && error.code === 'CAPABILITY_UNAVAILABLE')
		return `No ${capability} account is connected. Connect one in Settings first.`
	return error instanceof Error ? error.message : String(error)
}
