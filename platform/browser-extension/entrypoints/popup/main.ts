import { browser } from 'wxt/browser'
import { activePage, createSavePage } from '../../lib/save-page.ts'
import type { BackgroundResponse } from '../background.ts'

export function errorMessage(code: string): string {
	switch (code) {
		case 'app_not_installed':
			return 'Open Just Computer once to finish setting up Read, then retry.'
		case 'action_not_found':
			return 'Save to Read is unavailable.'
		case 'invalid_params':
			return 'Read could not save this page.'
		default:
			return 'Could not save to Read. Try again.'
	}
}

export async function afterPaint<T>(load: () => Promise<T>): Promise<T> {
	// The second frame starts after the browser has had a chance to paint the loading shell.
	await new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
	)
	return load()
}

async function main(): Promise<void> {
	const status = document.querySelector<HTMLParagraphElement>('#status')
	const pageDetails = document.querySelector<HTMLParagraphElement>('#page')
	const action = document.querySelector<HTMLButtonElement>('#action')
	if (!status || !pageDetails || !action) throw new Error('Missing popup elements')

	const showSignIn = () => {
		status.textContent = 'Sign in to Just Computer'
		pageDetails.hidden = true
		action.textContent = 'Sign in to Just Computer'
		action.hidden = false
		action.disabled = false
		action.onclick = async () => {
			await browser.tabs.create({ url: import.meta.env.WXT_FRIEREN_API_ORIGIN })
			window.close()
		}
	}

	let auth: BackgroundResponse | undefined
	try {
		auth = await afterPaint(() => browser.runtime.sendMessage({ type: 'auth/status' }))
	} catch {
		showSignIn()
		return
	}
	if (auth?.status !== 'signed_in') {
		showSignIn()
		return
	}

	const currentPage = async () => {
		const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
		return activePage(tab ?? {})
	}
	const page = await currentPage()
	if (!page) {
		status.textContent = 'Only HTTP and HTTPS pages can be saved.'
		return
	}

	status.textContent = 'Ready to save'
	pageDetails.textContent = `${page.title} — ${page.host}`
	pageDetails.hidden = false
	action.textContent = 'Save to Read'
	action.hidden = false

	const save = createSavePage((appId, action, params) =>
		browser.runtime.sendMessage({ type: 'run', appId, action, params })
	)
	action.onclick = async () => {
		action.disabled = true
		action.textContent = 'Saving...'
		status.textContent = 'Saving to Read...'
		let response: BackgroundResponse | undefined
		try {
			const target = await currentPage()
			if (!target) {
				status.textContent = 'Only HTTP and HTTPS pages can be saved.'
				pageDetails.hidden = true
				action.hidden = true
				return
			}
			pageDetails.textContent = `${target.title} — ${target.host}`
			response = (await save(target.url)) as BackgroundResponse | undefined
		} catch {
			response = undefined
		}
		if (response?.status === 'success') {
			status.textContent = 'Saved to Read'
			action.hidden = true
			return
		}
		if (
			response?.status === 'error' &&
			(response.error.code === 'unauthorized' || response.error.code === 'signed_out')
		) {
			showSignIn()
			return
		}
		status.textContent = errorMessage(
			response?.status === 'error' ? response.error.code : 'action_failed'
		)
		action.disabled = false
		action.textContent = 'Retry'
	}
}

if (typeof document !== 'undefined') void main()
