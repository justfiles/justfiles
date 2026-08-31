export interface Page {
	url: string
	title: string
	host: string
}

type Run = (appId: string, action: string, params: unknown) => Promise<unknown>

export function activePage(tab: { url?: string; title?: string }): Page | undefined {
	if (!tab.url) return
	try {
		const url = new URL(tab.url)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return
		return { url: tab.url, title: tab.title || url.hostname, host: url.hostname }
	} catch {
		return
	}
}

export function createSavePage(run: Run): (url: string) => Promise<unknown> {
	let saving = false
	return async (url) => {
		if (saving) return
		saving = true
		try {
			return await run('justfiles.read', 'save', { input: url })
		} finally {
			saving = false
		}
	}
}
