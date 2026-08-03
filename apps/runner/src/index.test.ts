import { expect, test } from 'vitest'
import app from './index.ts'

const env = { ROOT_DOMAIN: 'example.com' } as CloudflareBindings

const get = (url: string) => app.request(url, {}, env)

test('routes the first host label to the handler', async () => {
	const res = await get('https://app1.example.com/')
	expect(await res.text()).toContain('app: app1')
})

test('apex and unknown hosts have no subdomain', async () => {
	expect(await (await get('https://example.com/')).text()).toContain('<h1>runner</h1>')
	expect(await (await get('https://runner.workers.dev/')).text()).toContain('<h1>runner</h1>')
	// deeper labels are not covered by Universal SSL, so they are not treated as subdomains
	expect(await (await get('https://a.b.example.com/')).text()).toContain('<h1>runner</h1>')
})

test('*.localhost works in local dev', async () => {
	const res = await get('http://app1.localhost:8787/')
	expect(await res.text()).toContain('app: app1')
})

test('only accepts DNS-label subdomains', async () => {
	const res = await get('https://_weird.example.com/')
	expect(await res.text()).toContain('<h1>runner</h1>')
})
