#!/usr/bin/env bun

import { createInterface } from 'readline/promises'
import { sqliteStore } from '../core/store/sqlite'
import { openAI } from '../core/embedding.openai'

const command = process.argv[2]

if (command === 'capture') {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	const text = await rl.question('Capture text: ')
	rl.close()

	const store = sqliteStore('ghostore.db', openAI(process.env.OPENAI_KEY))
	const id = await store.capture({ text })
	console.log(`captured: ${id}`)
} else if (command === 'search') {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	const query = await rl.question('Search: ')
	rl.close()

	const store = sqliteStore('ghostore.db', openAI(process.env.OPENAI_KEY!))
	const results = await store.search({ query, mode: 'hybrid' })
	if (results.length === 0) {
		console.log('No results found.')
	} else {
		for (const r of results) {
			const parts = [`score: ${r.score.toFixed(3)}`]
			if (r.semanticScore != null) parts.push(`semantic: ${r.semanticScore.toFixed(3)}`)
			if (r.ftsScore != null) parts.push(`fts: ${r.ftsScore.toFixed(3)}`)
			console.log(`${parts.join('  ')}  ${r.path}`)
			if (r.snippet) console.log(`  ${r.snippet}`)
		}
	}
} else {
	console.log('Usage: ghostore <command>')
	console.log('Commands:')
	console.log('  capture  Capture text input')
	console.log('  search   Search captured text')
}
