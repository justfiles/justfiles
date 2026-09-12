import { lookup } from 'node:dns'
import { request as http } from 'node:http'
import { request as https } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'

const blocked = new BlockList()
for (const [address, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const)
	blocked.addSubnet(address, prefix)
blocked.addSubnet('2001::', 23, 'ipv6')
blocked.addSubnet('2001:db8::', 32, 'ipv6')
blocked.addSubnet('2002::', 16, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

function publicAddress(address: string): boolean {
	const family = isIP(address)
	if (family === 4) return !blocked.check(address, 'ipv4')
	return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

// Check the address handed to the socket, so a second DNS lookup cannot rebind it.
export async function publicFetch(
	input: string | URL | Request,
	init?: RequestInit
): Promise<Response> {
	const url = new URL(String(input))
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Only public HTTP(S) URLs without credentials are allowed')
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (isIP(host) && !publicAddress(host)) throw new Error('Private network address denied')
	return new Promise<Response>((resolve, reject) => {
		const request = (url.protocol === 'https:' ? https : http)(
			url,
			{
				method: init?.method ?? 'GET',
				headers: Object.fromEntries(new Headers(init?.headers)),
				signal: init?.signal ?? undefined,
				agent: false,
				lookup: (hostname, options, callback) => {
					lookup(hostname, { all: true }, (error, addresses) => {
						if (error) return callback(error, [])
						if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
							return callback(new Error('Private network address denied'), [])
						if (options.all) callback(null, addresses)
						else callback(null, addresses[0]!.address, addresses[0]!.family)
					})
				}
			},
			(response) => {
				try {
					const status = response.statusCode ?? 502
					if (init?.redirect === 'error' && [301, 302, 303, 307, 308].includes(status))
						throw new Error('Unexpected redirect')
					const headers = new Headers()
					for (let i = 0; i < response.rawHeaders.length; i += 2)
						headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!)
					const body =
						init?.method === 'HEAD' || [204, 205, 304].includes(status)
							? null
							: (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>)
					if (!body) response.resume()
					resolve(new Response(body, { status, headers }))
				} catch (error) {
					response.destroy()
					reject(error)
				}
			}
		)
		request.on('error', reject)
		request.end(init?.body)
	})
}
