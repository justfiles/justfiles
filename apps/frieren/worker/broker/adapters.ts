// Provider adapters: convert existing low-level provider clients
// (JMAP, CalDAV, fs Volume) into the broker's platform-agnostic adapter
// contracts. These keep DTOs normalized and credentials behind the client.

import type { Volume } from '@justfiles/fs'
import type { JmapClient } from '../integrations/fastmail/jmap.ts'
import type { CalDavClient } from '../integrations/icloud-calendar/caldav.ts'
import type {
	CalendarEventDTO,
	CalendarProviderAdapter,
	EmailDetailDTO,
	EmailDTO,
	EmailProviderAdapter,
	VolumeProviderAdapter
} from './contracts.ts'

export function fastmailEmailAdapter(accountId: string, client: JmapClient): EmailProviderAdapter {
	return {
		async listUnread({ since, limit }) {
			const summaries = await client.list({ limit: limit ?? 50, unread: true })
			const sinceMs = since
			const filtered = sinceMs
				? summaries.filter((s) => Date.parse(s.receivedAt) >= sinceMs)
				: summaries
			return filtered.map<EmailDTO>((s) => ({
				id: s.id,
				accountId,
				source: 'fastmail',
				from: { name: s.from[0]?.name ?? undefined, email: s.from[0]?.email ?? '' },
				subject: s.subject ?? '',
				receivedAt: Date.parse(s.receivedAt),
				preview: s.preview
			}))
		},
		async readDetail({ id }) {
			const detail = await client.read(id)
			const dto: EmailDetailDTO = {
				id: detail.id,
				accountId,
				source: 'fastmail',
				from: { name: detail.from[0]?.name ?? undefined, email: detail.from[0]?.email ?? '' },
				subject: detail.subject ?? '',
				receivedAt: Date.parse(detail.receivedAt),
				preview: detail.preview,
				to: detail.to.map((a) => ({ name: a.name ?? undefined, email: a.email })),
				text: detail.text
			}
			return dto
		},
		async markRead({ id }) {
			await client.markRead(id)
		}
	}
}

const DAY_MS = 24 * 60 * 60 * 1000

export function icloudCalendarAdapter(
	accountId: string,
	client: CalDavClient
): CalendarProviderAdapter {
	return {
		async listToday({ timezone, now }) {
			const events = await client.listEvents({ days: 2 })
			const today = todayBounds(timezone, now ?? Date.now())
			return events
				.map<CalendarEventDTO>((ev) => ({
					id: ev.uid,
					accountId,
					source: 'icloud-calendar',
					title: ev.summary,
					startAt: parseEventInstant(ev.dtstart),
					endAt: parseEventInstant(ev.dtend),
					...(ev.location ? { location: ev.location } : {}),
					...(ev.description ? { notes: ev.description } : {})
				}))
				.filter((ev) => ev.startAt < today.endMs && ev.endAt > today.startMs)
				.sort((a, b) => a.startAt - b.startAt)
		}
	}
}

export function volumeAdapter(vol: Volume, root?: string): VolumeProviderAdapter {
	const resolve = (path: string) => {
		if (!root) return path
		const r = root.replace(/\/$/, '')
		const p = path.startsWith('/') ? path : `/${path}`
		return `${r}${p}`
	}
	return {
		async readFile({ path }) {
			return vol.readFile(resolve(path))
		},
		async writeFile({ path, data }) {
			await vol.writeFile(resolve(path), data)
		}
	}
}

function parseEventInstant(value: string): number {
	if (value.length === 10) return Date.parse(`${value}T00:00:00Z`)
	return Date.parse(value)
}

function todayBounds(timezone: string, nowMs: number): { startMs: number; endMs: number } {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	})
	const parts: Record<string, string> = {}
	for (const { type, value } of fmt.formatToParts(new Date(nowMs))) parts[type] = value
	const y = +parts.year
	const mo = +parts.month - 1
	const d = +parts.day
	const h = +(parts.hour === '24' ? '0' : parts.hour)
	const mi = +parts.minute
	const s = +parts.second
	const wallMidnight = Date.UTC(y, mo, d, 0, 0, 0)
	const wallNow = Date.UTC(y, mo, d, h, mi, s)
	const offset = wallNow - nowMs
	const startMs = wallMidnight - offset
	return { startMs, endMs: startMs + DAY_MS }
}
