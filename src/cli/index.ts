#!/usr/bin/env bun

import { createInterface } from 'readline/promises'
import { sqliteStore } from '../core/store.sqlite'
import { openAI } from '../core/embedding.openai'
import { tursoStore } from '../core/store.turso'

const command = process.argv[2]

const BACKEND: 'local' | 'turso' | 'do' = 'turso'

async function getStore() {
	switch (BACKEND) {
		case 'local':
			return await sqliteStore('ghostore.db', openAI(process.env.OPENAI_KEY))
		case 'turso':
			return await tursoStore('default', openAI(process.env.OPENAI_KEY))
		case 'do':
			throw new Error('not implemented')
	}
}

if (command === 'write') {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	const text = await rl.question('Text: ')
	rl.close()

	const store = await getStore()
	const id = await store.write({ text })
	console.log(`written: ${id}`)
} else if (command === 'search') {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	const query = await rl.question('Search: ')
	rl.close()

	const store = await getStore()
	const results = await store.search({ query })
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
	console.log('  write    Write text to memory')
	console.log('  search   Search memories')
}
