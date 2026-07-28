import type { OsWindowInfo } from '@justfiles/agent'
import type { Volume } from '@justfiles/fs'

const OS_STATE_PATH = '/system/os-state.json'

/**
 * The ONE reader of the persisted shell snapshot, feeding two projections: `os windows`
 * (what the user is looking at, for the agent) and the app bridge's "current app".
 *
 * `/system/os-state.json` is a host artifact — versioned, normalised in `src/os`, free to
 * change — so the agent never parses it and this is the only place the worker does. Every
 * field is validated on the way out, and a corrupt or absent snapshot reads as "no
 * windows" rather than throwing.
 *
 * Focus order is `focusStack` last-to-first (most recently focused wins), falling back to
 * `openOrder` when no focus is recorded. A window with neither an appId nor a title (the
 * chat window) is labelled with its id — the only handle it has.
 */
export async function readWindows(fs: Volume): Promise<OsWindowInfo[]> {
	try {
		if (!(await fs.exists(OS_STATE_PATH))) return []
		const snapshot = JSON.parse(new TextDecoder().decode(await fs.readFile(OS_STATE_PATH))) as {
			windows?: Record<string, { appId?: unknown; title?: unknown; mode?: unknown } | undefined>
			focusStack?: unknown
			openOrder?: unknown
		}
		const ordered = [snapshot.focusStack, snapshot.openOrder]
			.flatMap((value) => (Array.isArray(value) ? [value] : []))
			.find((value) => value.length > 0)
		const ids = (ordered ?? []).filter((id): id is string => typeof id === 'string').reverse()
		return ids.flatMap((id, index) => {
			const window = snapshot.windows?.[id]
			if (!window) return []
			const appId = typeof window.appId === 'string' ? window.appId : undefined
			const title = typeof window.title === 'string' ? window.title : appId ? undefined : id
			const minimized = window.mode === 'minimized'
			return [
				{
					...(appId ? { appId } : {}),
					...(title ? { title } : {}),
					focused: index === 0 && !minimized,
					...(minimized ? { minimized } : {})
				}
			]
		})
	} catch {
		return []
	}
}

/** The frontmost APP — the chat window presents none, so it is skipped. */
export async function currentAppId(fs: Volume): Promise<string | undefined> {
	return (await readWindows(fs)).find((w) => w.appId)?.appId
}
