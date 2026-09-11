import { lookup } from 'node:dns'
import { EventEmitter } from 'node:events'
import { request as http, type RequestOptions } from 'node:http'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, test, vi } from 'vitest'
import { publicFetch } from './public-fetch.ts'

vi.mock('node:dns', () => ({ lookup: vi.fn() }))
vi.mock('node:http', () => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

test.each([
	'127.0.0.1',
	'2130706433',
	'0x7f000001',
	'10.1.2.3',
	'169.254.169.254',
	'192.168.1.1',
	'[::1]',
	'[::ffff:127.0.0.1]',
	'[fc00::1]'
])('rejects private literal %s before opening a socket', async (host) => {
	await expect(publicFetch(`http://${host}`)).rejects.toThrow('Private network')
	expect(http).not.toHaveBeenCalled()
})

test.each([
	'file:///etc/passwd',
	'http://user:password@example.com'
])('rejects credentials and non-HTTP URLs: %s', async (url) => {
	await expect(publicFetch(url)).rejects.toThrow('Only public HTTP(S)')
	expect(http).not.toHaveBeenCalled()
})

test.each([
	'127.0.0.1',
	'10.0.0.1',
	'::1',
	'fc00::1',
	'::ffff:7f00:1'
])('rejects a DNS result pointing to %s', async (address) => {
	vi.mocked(lookup).mockImplementation(((...args: unknown[]) =>
		(args[2] as (...args: unknown[]) => void)(null, [
			{ address, family: address.includes(':') ? 6 : 4 }
		])) as typeof lookup)
	vi.mocked(http).mockImplementation(((...args: unknown[]) => {
		const options = args[1] as RequestOptions
		const req = new EventEmitter()
		Object.assign(req, {
			end: () => {
				options.lookup!('example.com', { all: true }, (error: Error | null) =>
					req.emit('error', error)
				)
			}
		})
		return req
	}) as typeof http)
	await expect(publicFetch('http://example.com')).rejects.toThrow('Private network')
})

test('hands the checked DNS result directly to the socket and returns a readable body', async () => {
	vi.mocked(lookup).mockImplementation(((...args: unknown[]) =>
		(args[2] as (...args: unknown[]) => void)(null, [
			{ address: '93.184.216.34', family: 4 }
		])) as typeof lookup)
	vi.mocked(http).mockImplementation(((...args: unknown[]) => {
		const options = args[1] as RequestOptions
		const receive = args[2] as (response: PassThrough) => void
		const req = new EventEmitter()
		Object.assign(req, {
			end: () => {
				options.lookup!('example.com', { all: true }, (error: Error | null, addresses: unknown) => {
					expect(error).toBeNull()
					expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
					const response = Object.assign(new PassThrough(), {
						statusCode: 200,
						rawHeaders: ['content-type', 'text/plain']
					})
					receive(response)
					response.end('public page')
				})
			}
		})
		return req
	}) as typeof http)
	expect(await (await publicFetch('http://example.com')).text()).toBe('public page')
	expect(lookup).toHaveBeenCalledTimes(1)
})

test.each([
	600, 999
])('rejects status %s without throwing from the response callback', async (statusCode) => {
	let receive!: (response: PassThrough) => void
	vi.mocked(http).mockImplementation(((...args: unknown[]) => {
		receive = args[2] as typeof receive
		const req = new EventEmitter()
		Object.assign(req, { end: vi.fn() })
		return req
	}) as typeof http)
	const response = Object.assign(new PassThrough(), { statusCode, rawHeaders: [] })
	const result = publicFetch('http://example.com')
	expect(() => receive(response)).not.toThrow()
	await expect(result).rejects.toThrow(RangeError)
	expect(response.destroyed).toBe(true)
})
