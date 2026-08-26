// Bake `packages/agent/avatars/<id>/<state>.png` into modules every runtime can import:
// `pnpm run avatars` (and automatically at the end of `pnpm run faces`).
//
// The art has to be readable by FIVE runtimes — the frieren shell (vite), the Settings app
// frame (vite, and its CSP is `img-src data:` so a URL to an asset file would simply not
// load), the frieren DO (wrangler), the Mac daemon (Bun's runtime AND its bundler) and
// vitest. A data URL in a plain module is the only form all of them read with no loader,
// no plugin and no per-bundler glob syntax — so the bytes are inlined rather than imported.
//
// TWO TIERS, because the two things that need this art need different amounts of it:
//
//   avatars.ts            the state each built-in RESTS in, ~19 KB, eager. A first paint and
//                         a picker need exactly this, so it is in every bundle.
//   avatars/<id>/faces.ts one built-in's expressions, ~32 KB each, behind a dynamic import.
//                         A shell needs the WORN one's faces and only once a feeling is
//                         tagged, so a bundler splits them and fetches one.
//
// The PNGs stay the source of truth (that is what an artist edits and a reviewer looks at);
// packages/agent/avatars.test.ts fails when these modules have drifted from them.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.resolve(dir, '../../../packages/agent')
const ART = path.join(AGENT, 'avatars')
const INDEX = path.join(AGENT, 'avatars.ts')
const RESTING = 'resting'

const url = (id: string, name: string) =>
	`data:image/png;base64,${readFileSync(path.join(ART, id, name)).toString('base64')}`
const state = (name: string) => name.slice(0, -'.png'.length)

const ids = readdirSync(ART, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort()

const index: string[] = []
const loaders: string[] = []
for (const id of ids) {
	const states = readdirSync(path.join(ART, id))
		.filter((name) => name.endsWith('.png'))
		.map(state)
		.sort()
	const resting = states.find((name) => name === RESTING)
	if (!resting) throw new Error(`avatars/${id}: no resting.png — an avatar rests in a state`)

	// Emitted the way `biome format` would write it — a string this long lives on its own
	// line — so a bake never shows up as a formatting diff.
	index.push(
		`\t${id}: {\n\t\tresting:\n\t\t\t'${url(id, `${RESTING}.png`)}',\n` +
			`\t\tstates: [${states.map((name) => `'${name}'`).join(', ')}]\n\t}`
	)
	loaders.push(`\t${id}: () => import('./avatars/${id}/faces.ts')`)

	const faces = states
		.filter((name) => name !== RESTING)
		.map((name) => `\t${name}:\n\t\t'${url(id, `${name}.png`)}'`)
	writeFileSync(
		path.join(ART, id, 'faces.ts'),
		`// GENERATED from ./*.png by platform/frieren/scripts/bake-avatars.ts. Do not edit.\n` +
			`//\n// ${id}'s face for every expression the agent can tag, keyed by state. Loaded only when\n` +
			`// this built-in is the one being worn (see ../../avatars.ts).\n\n` +
			`export default {\n${faces.join(',\n')}\n}\n`
	)
}

writeFileSync(
	INDEX,
	`// GENERATED from ./avatars/** by platform/frieren/scripts/bake-avatars.ts. Do not edit.
//
// The art the platform ships: one directory per built-in avatar, one file per state it can be
// in. Data URLs, because every runtime that renders an avatar has to read them with no loader
// and the app frame's CSP allows \`data:\` and nothing else.
//
// The state it RESTS in is here (a first paint and a picker need only that); its expressions
// are a dynamic import away, so a shell downloads the set it is wearing and not the others.

export interface BuiltinAvatar {
	resting: string
	// Every state it covers, resting included — what a pane offers a slot for.
	states: string[]
}

export const BUILTIN_AVATARS: Record<string, BuiltinAvatar> = {
${index.join(',\n')}
}

const FACES: Record<string, () => Promise<{ default: Record<string, string> }>> = {
${loaders.join(',\n')}
}

/** One built-in's face per expression. Empty for an id this build does not have. */
export async function builtinFaces(id: string): Promise<Record<string, string>> {
	return (await FACES[id]?.())?.default ?? {}
}
`
)
console.log(`avatars: baked ${ids.length} built-ins → packages/agent/avatars.ts`)
