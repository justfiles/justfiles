import type { VolumeCapability, VolumeEntry } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// The subset of the (Volume-shaped) capability the disk helpers use. The methods
// are positional now (`writeFile(path, data)`, `exists(path)`, `rm(path, opts)`,
// …) — matching the real `Volume` they wrap — except `scan`, which keeps its
// object input (it RETURNS a listing instead of taking a visitor).
export type VolumeApi = Pick<
	VolumeCapability,
	'readFile' | 'writeFile' | 'mkdir' | 'scan' | 'exists' | 'rm' | 'rename'
>
export type { VolumeEntry }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const SRC = (slug: string, path = '') => `/projects/${slug}/src${path}`
// The project's app icon, stored verbatim (image data URL) at the project root.
export const ICON = (slug: string) => `/projects/${slug}/icon`
// The build contract devkit reads (identity + entry/icon paths). Project root.
export const PROJECT = (slug: string) => `/projects/${slug}/project.json`

export type ProjectTemplate = 'plain' | 'react'

const REACT_IMPORTS = {
	react: 'https://esm.sh/react@19.1.1',
	'react/jsx-runtime': 'https://esm.sh/react@19.1.1/jsx-runtime',
	'react-dom/client': 'https://esm.sh/react-dom@19.1.1/client?bundle&deps=react@19.1.1'
}

// Catalog bundle id: `<github-login>.<app>`, with lowercase segments and internal hyphens.
// It is also a strict subset of the folder slug, so the id is always a valid folder name.
export const bundleIdSchema = v.pipe(
	v.string(),
	v.regex(
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
		'bundle id must be <github-login>.<app>, e.g. alice.notes'
	)
)

function basename(path: string) {
	return path.split('/').filter(Boolean).at(-1) ?? path
}

async function readText(vol: VolumeApi, path: string) {
	return decoder.decode(await vol.readFile(path))
}

// Names-only scan of `/projects`: each directory is a project, its `name` read
// from `project.json`. Tolerant — a missing/invalid manifest (legacy `untitled`)
// falls back to the slug. Cheap for a handful of projects.
export async function listProjects(vol: VolumeApi): Promise<{ slug: string; name: string }[]> {
	const entries = await vol.scan({ path: '/projects' }).catch(() => [] as VolumeEntry[])
	const dirs = entries
		.filter((e) => e.type === 'dir')
		.map((e) => basename(e.path))
		.sort()
	return Promise.all(dirs.map(async (slug) => ({ slug, name: await projectName(vol, slug) })))
}

export async function projectName(vol: VolumeApi, slug: string): Promise<string> {
	try {
		return JSON.parse(await readText(vol, PROJECT(slug))).name || slug
	} catch {
		return slug
	}
}

// The only seeder. The folder IS the bundle id, so uniqueness is the id's job —
// one `exists` check, no de-dup dance. Checks the project ROOT (not `src/`) so a
// corrupt/partial folder still counts as taken.
export async function createProject(
	vol: VolumeApi,
	name: string,
	id: string,
	template: ProjectTemplate = 'plain'
): Promise<{ slug: string }> {
	v.parse(bundleIdSchema, id)
	if (await vol.exists(`/projects/${id}`)) throw new Error(`project id already exists: ${id}`)
	await seed(vol, id, name, template)
	return { slug: id }
}

// Derive a sane id segment from a display name (GUI prefill: `${org}.${slug}`).
export function slugifyName(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
	return s || 'app'
}

export async function seed(
	vol: VolumeApi,
	id: string,
	name: string,
	template: ProjectTemplate = 'plain'
): Promise<void> {
	await vol.writeFile(SRC(id, '/app.ts'), encoder.encode(starterApp))
	await vol.writeFile(
		SRC(id, template === 'react' ? '/gui.tsx' : '/gui.ts'),
		encoder.encode(template === 'react' ? reactStarterGui : starterGui)
	)
	await writeProjectManifest(vol, id, name, template)
}

// Delete a project: its folder plus the devkit scratch (best-effort — it may not
// exist if the project was never run). Installed copies in /applications are
// untouched. The folder is the bundle id, so one `rm` per location.
export async function removeProject(vol: VolumeApi, slug: string): Promise<void> {
	await vol.rm(`/projects/${slug}`, { recursive: true })
	await vol.rm(`/.devkit/${slug}`, { recursive: true }).catch(() => {})
}

// The build contract on disk. React projects also declare pinned imports and
// opt in to automatic JSX.
export type ProjectMeta = {
	id: string
	name: string
	version?: string
	description?: string
	app: string
	gui?: string
	icon?: string
	imports?: Record<string, string>
	compiler?: { jsx: 'react-jsx' }
}

// Read the open project's manifest to populate the settings form.
export async function readMeta(vol: VolumeApi, slug: string): Promise<ProjectMeta> {
	return JSON.parse(await readText(vol, PROJECT(slug))) as ProjectMeta
}

// Rewrite the editable metadata and imports. The id, entries, compiler, and icon
// stay unchanged. The bundle id is immutable in v1, so the folder never moves.
export async function saveMeta(
	vol: VolumeApi,
	slug: string,
	fields: {
		name: string
		version?: string
		description?: string
		imports?: Record<string, string>
	}
): Promise<void> {
	const prev = await readMeta(vol, slug)
	const next = { ...prev, ...fields }
	await vol.writeFile(PROJECT(slug), encoder.encode(`${JSON.stringify(next, null, 2)}\n`))
}

// The project file devkit builds from. `name` defaults to the slug — used by the
// `open` backfill for legacy projects created before the manifest existed.
export async function writeProjectManifest(
	vol: VolumeApi,
	slug: string,
	name = slug,
	template: ProjectTemplate = 'plain'
): Promise<void> {
	const manifest = {
		id: slug,
		name,
		icon: 'icon',
		app: 'src/app.ts',
		gui: template === 'react' ? 'src/gui.tsx' : 'src/gui.ts',
		...(template === 'react'
			? { imports: REACT_IMPORTS, compiler: { jsx: 'react-jsx' as const } }
			: {})
	}
	await vol.writeFile(PROJECT(slug), encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`))
}

const starterApp = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export type CounterState = {
	count: number
}

export const app = defineApp({
	init: { count: 0 } as CounterState,
	// One update table of pure edges: (state, params) => next state. A public
	// edge declares a schema, which makes it the validated, agent-visible app API
	// — its description and examples are what the agent sees as a tool.
	update: (t) => ({
		increment: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ ...state, count: state.count + amount }),
			{ description: 'Add to the counter.', examples: [{ params: { amount: 1 } }] }
		)
	})
})
`

const starterGui = `import { defineGUI } from '@justfiles/app/browser'
import type { app } from './app'

// Change this color, then save the file to update the preview.
const buttonColor = '#007aff'

export const gui = defineGUI<typeof app>({
	mount(root, state, { client }) {
		const button = document.createElement('button')
		button.type = 'button'
		button.style.backgroundColor = buttonColor
		button.style.color = 'white'
		button.onclick = () => void client.increment({ amount: 1 })
		root.append(button)

		const render = (next: { count: number } | null) => {
			button.textContent = \`Count: \${next?.count ?? 0}\`
		}

		render(state)
		return { update: render, unmount: () => button.remove() }
	}
})
`

const reactStarterGui = `import { defineGUI } from '@justfiles/app/browser'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { type CounterState, app } from './app'

export const gui = defineGUI<typeof app>({
	mount(element, state, { client }) {
		const root = createRoot(element)
		const render = (next: CounterState | null) => {
			root.render(
				<StrictMode>
					<button
						type="button"
						style={{ backgroundColor: '#007aff', color: 'white' }}
						onClick={() => void client.increment({ amount: 1 })}
					>
						Count: {next?.count ?? 0}
					</button>
				</StrictMode>
			)
		}

		render(state)
		return { update: render, unmount: () => root.unmount() }
	}
})
`
