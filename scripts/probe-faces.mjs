// Throwaway feasibility probe (NOT shipped): can the platform's image model turn one
// avatar into a set of per-expression faces? Same model + provider the DO uses
// (`google/gemini-3.1-flash-image` over OpenRouter images), same payload shape the
// pi-ai openrouter-images api builds (input image as a data-url `image_url` part).
//
//   node --env-file=apps/frieren/.dev.vars scripts/probe-faces.mjs
//
// Writes results + a cost/latency table to /tmp/face-probe/.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const MODEL = 'google/gemini-3.1-flash-image'
const OUT = '/tmp/face-probe'
const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) throw new Error('OPENROUTER_API_KEY missing')

const SOURCES = {
	kodama: 'apps/frieren/src/agent/agent-avatar.png',
	portrait: 'apps/frieren/src/assets/companion.png',
	photo: 'apps/frieren/src/assets/himmel.jpg'
}

// The framing instruction is the load-bearing part: identity, crop and palette must
// hold across independent calls or the face "jumps" between expressions.
const KEEP =
	'Keep the same character, art style, colours, lighting, framing, crop and background. ' +
	'Do not change identity, hair, clothing or composition. Output one square image.'

const EXPRESSIONS = {
	pleased: 'Change only the facial expression to pleased: a warm, closed-mouth smile, eyes softly narrowed.',
	concerned: 'Change only the facial expression to concerned: brows drawn slightly together, mouth neutral-tense.',
	thinking: 'Change only the facial expression to thinking: eyes looking up and away, mouth a small flat line.'
}

const SHEET =
	'Produce a 3x2 grid (3 columns, 2 rows) contact sheet of this same character with six ' +
	'facial expressions, in this order: neutral, thinking, pleased, curious, concerned, apologetic. ' +
	'Identical framing and scale in every cell, no labels, no borders, no gaps. ' +
	KEEP

function dataUrl(path) {
	const bytes = readFileSync(path)
	const mime = path.endsWith('.jpg') ? 'image/jpeg' : 'image/png'
	return { url: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length }
}

async function edit(label, sourcePath, prompt) {
	const source = dataUrl(sourcePath)
	const started = Date.now()
	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model: MODEL,
			modalities: ['image', 'text'],
			stream: false,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: prompt },
						{ type: 'image_url', image_url: { url: source.url } }
					]
				}
			]
		})
	})
	const body = await response.json()
	const ms = Date.now() - started
	if (!response.ok) return { label, ms, error: JSON.stringify(body).slice(0, 300) }

	const choice = body.choices?.[0]
	const image = choice?.message?.images?.[0]
	const url = typeof image?.image_url === 'string' ? image.image_url : image?.image_url?.url
	if (!url) {
		return {
			label,
			ms,
			error: `no image; finish=${choice?.finish_reason} text=${String(choice?.message?.content).slice(0, 160)}`
		}
	}
	const [, , base64] = url.match(/^data:([^;]+);base64,(.+)$/)
	const out = `${OUT}/${label}.png`
	const bytes = Buffer.from(base64, 'base64')
	writeFileSync(out, bytes)
	return { label, ms, kb: Math.round(bytes.length / 1024), usage: body.usage, out }
}

mkdirSync(OUT, { recursive: true })
const results = []
for (const [name, path] of Object.entries(SOURCES)) {
	for (const [expression, instruction] of Object.entries(EXPRESSIONS)) {
		results.push(await edit(`${name}-${expression}`, path, `${instruction} ${KEEP}`))
	}
	results.push(await edit(`${name}-sheet`, path, SHEET))
}

// Catalogue price for the model, per million tokens (pi-ai image-models.generated).
const COST = { input: 0.5, output: 3 }
let total = 0
for (const r of results) {
	if (r.usage) {
		r.usd =
			(r.usage.prompt_tokens * COST.input + r.usage.completion_tokens * COST.output) / 1_000_000
		total += r.usd
	}
	console.log(
		[
			r.label.padEnd(20),
			r.error ? `ERROR ${r.error}` : `${r.ms}ms  ${r.kb}KB  $${r.usd?.toFixed(4)}`
		].join(' ')
	)
}
console.log(`\ntotal $${total.toFixed(4)} — ${OUT}`)
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2))
