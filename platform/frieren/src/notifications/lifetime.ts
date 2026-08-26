import { useEffect } from 'react'
import type { NotificationEntry } from './store'

// Lifetime is driven by urgency, not a constant (freedesktop `urgency`; dunst):
// `info` shows in the pill briefly then recedes to history; `error`/`question`
// are sticky — they hold the pill until acted on or dismissed.
const INFO_TTL_MS = 8000
const STICKY = new Set<NotificationEntry['notification']['kind']>(['error', 'question'])

export function dismissDelay(kind: NotificationEntry['notification']['kind']): number | null {
	return STICKY.has(kind) ? null : INFO_TTL_MS
}

// Auto-recede the active pill banner after its lifetime. The timer pauses while
// the tab is hidden (`document.hidden`) and while `hovered` (dunst
// `pause_on_mouse_over`), so a notification is never lost to a glance away.
export function useDismissTimer(
	active: NotificationEntry | null,
	dismiss: (id: string) => void,
	hovered: boolean
): void {
	const id = active?.notification.id
	const kind = active?.notification.kind
	useEffect(() => {
		if (!id || !kind || hovered) return
		const delay = dismissDelay(kind)
		if (delay === null) return
		let remaining = delay
		let startedAt = 0
		let timer: ReturnType<typeof setTimeout> | undefined
		const start = (): void => {
			if (document.hidden) return
			startedAt = Date.now()
			timer = setTimeout(() => dismiss(id), remaining)
		}
		const onVisibility = (): void => {
			if (document.hidden) {
				clearTimeout(timer)
				remaining = Math.max(0, remaining - (Date.now() - startedAt))
			} else start()
		}
		start()
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			clearTimeout(timer)
			document.removeEventListener('visibilitychange', onVisibility)
		}
	}, [id, kind, hovered, dismiss])
}
