import { fileURLToPath } from 'node:url'
import { chromium, expect, webkit } from '@playwright/test'
import { createServer } from 'vite'
import { kernelHost } from '../../../packages/app/vite.ts'

const root = fileURLToPath(new URL('../../../packages/app/test-frame', import.meta.url))
const server = await createServer({
	configFile: false,
	root,
	plugins: kernelHost({
		id: 'local.gui-parity',
		name: 'GUI parity fixture',
		app: `${root}/app.ts`,
		gui: `${root}/gui.ts`
	}),
	server: { host: '127.0.0.1', port: 0 }
})
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === 'string') throw new Error('Missing server address')
const url = `http://127.0.0.1:${address.port}`
console.log(url)

try {
	if (process.argv.includes('--serve')) {
		await new Promise<void>((resolve) => process.once('SIGINT', resolve))
	} else {
		for (const engine of [chromium, webkit]) {
			const browser = await engine.launch()
			try {
				const page = await browser.newPage()
				page.on('console', (message) => {
					if (message.type() === 'error') console.error(message.text())
				})
				page.on('pageerror', (error) => console.error(error))
				await page.goto(url)
				const gui = page.frameLocator('#app > iframe')
				await expect(gui.getByRole('heading')).toHaveCSS('color', 'rgb(21, 83, 145)')
				await expect(gui.getByText('GUI isolated: true')).toBeVisible()
				expect(
					await gui
						.getByAltText('Bundled asset')
						.evaluate((image) => (image as unknown as { naturalWidth: number }).naturalWidth)
				).toBe(20)
				const material = gui.frameLocator('iframe')
				await expect(material.getByText('Isolated: true')).toBeVisible()
				await material.getByRole('button').click()
				await expect(material.getByRole('button')).toHaveText('Material count: 1')
				await material.locator('p').evaluate((element) => {
					const document = element.ownerDocument
					const range = document.createRange()
					range.selectNodeContents(element)
					document.getSelection()!.removeAllRanges()
					document.getSelection()!.addRange(range)
				})
				await expect(gui.locator('#selection')).toHaveText('Select this material text')
				expect(
					JSON.parse((await gui.locator('#root').getAttribute('data-material')) ?? '{}')
				).toMatchObject({ isolated: true, client: 'undefined' })
				const count = Number((await gui.locator('#increment').textContent())!.split(': ')[1])
				await gui.locator('#increment').click()
				await expect(gui.locator('#increment')).toHaveText(`Host count: ${count + 1}`)
				await gui.getByRole('button', { name: 'Confirm', exact: true }).click()
				await page.getByRole('button', { name: 'Continue', exact: true }).click()
				await expect(gui.locator('#dialog-result')).toHaveText('true')
				const download = page.waitForEvent('download')
				await gui.getByRole('button', { name: 'Download', exact: true }).click()
				expect((await download).suggestedFilename()).toBe('gui-parity.txt')
				await gui.getByLabel('Window title').fill('Frame title')
				await expect(page).toHaveTitle('Frame title')
				await page
					.locator('#app > iframe')
					.evaluate((frame) => frame.setAttribute('srcdoc', frame.getAttribute('srcdoc')!))
				await expect(gui.locator('#increment')).toHaveText(`Host count: ${count + 1}`)
				await page.locator('#app > iframe').evaluate((element) => {
					const parent = element.parentElement!
					element.remove()
					parent.append(element)
				})
				await expect(gui.locator('#increment')).toHaveText(`Host count: ${count + 1}`)
				await gui.locator('#increment').click()
				await expect(gui.locator('#increment')).toHaveText(`Host count: ${count + 2}`)
				await page.reload()
				await expect(gui.locator('#increment')).toHaveText(`Host count: ${count + 2}`)
				console.log(
					`${engine.name()}: GUI, material, selection, isolation, styles, asset, dialog, download, title, reload, reattachment passed`
				)
			} finally {
				await browser.close()
			}
		}
	}
} finally {
	await server.close()
}
