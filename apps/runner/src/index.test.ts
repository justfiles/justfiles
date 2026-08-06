import { expect, test } from 'vitest'
import worker from './index.ts'

const env = { ROOT_DOMAIN: 'example.com' } as CloudflareBindings

const get = (url: string) => worker.fetch(new Request(url), env, {} as ExecutionContext)

// The store holds whatever `bin/` holds, so these assert the SPLIT — which host
// reaches the app site at all — rather than any particular app being hosted.

test('a decodable label reaches the app site', async () => {
	// nothing is published under `alice.notes`, so the app site 404s rather than
	// falling through to the runner page
	expect((await get('https://alice-notes.example.com/')).status).toBe(404)
})

test('apex and unknown hosts have no subdomain', async () => {
	expect(await (await get('https://example.com/')).text()).toContain('<h1>runner</h1>')
	expect(await (await get('https://runner.workers.dev/')).text()).toContain('<h1>runner</h1>')
	// deeper labels are not covered by Universal SSL, so they are not treated as subdomains
	expect(await (await get('https://a.b.example.com/')).text()).toContain('<h1>runner</h1>')
})

test('*.localhost works in local dev', async () => {
	expect((await get('http://alice-notes.localhost:8787/')).status).toBe(404)
})

test('the platform keeps every label an id cannot encode to', async () => {
	// every id has two segments, so every app label carries a hyphen — and a-b-c style
	// labels that are not the canonical encoding of anything are refused too
	for (const host of ['www', 'api', 'store', '_weird', 'a---b']) {
		expect(await (await get(`https://${host}.example.com/`)).text()).toContain('<h1>runner</h1>')
	}
})

test('app routes do not exist on the apex host', async () => {
	expect((await get('https://example.com/worker.js')).status).toBe(404)
	expect((await get('https://example.com/logo.svg')).status).toBe(404)
})
