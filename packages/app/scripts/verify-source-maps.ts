import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const missing = readdirSync('dist', { recursive: true })
	.filter((file) => file.endsWith('.js.map'))
	.filter((file) => {
		const map = JSON.parse(readFileSync(resolve('dist', file), 'utf8'))
		return (
			map.sourcesContent?.length !== map.sources.length ||
			map.sourcesContent.some((source: unknown) => typeof source !== 'string')
		)
	})

if (missing.length > 0) throw new Error(`Source maps do not embed sources: ${missing.join(', ')}`)
