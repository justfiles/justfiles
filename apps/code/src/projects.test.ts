import { expect, test } from 'vitest'
import {
	createProject,
	listProjects,
	removeProject,
	saveMeta,
	slugifyName,
	type VolumeApi,
	type VolumeEntry
} from './projects.ts'

const enc = (s: string) => new TextEncoder().encode(s)

// A Map-backed VolumeApi — positional methods matching the real Volume; `scan`
// keeps its object input and returns a non-recursive listing of `path`'s
// immediate children. No kernel, no esbuild.
function fakeVolume(): VolumeApi & { dump(): Record<string, string> } {
	const files = new Map<string, Uint8Array>()
	const dec = new TextDecoder()
	return {
		async readFile(path) {
			const b = files.get(path)
			if (!b) throw new Error(`ENOENT ${path}`)
			return b
		},
		async writeFile(path, data) {
			files.set(path, data)
		},
		async mkdir() {},
		async exists(path) {
			return files.has(path) || [...files.keys()].some((p) => p.startsWith(`${path}/`))
		},
		async scan({ path }) {
			const seen = new Set<string>()
			const out: VolumeEntry[] = []
			for (const p of files.keys()) {
				if (!p.startsWith(`${path}/`)) continue
				const rest = p.slice(path.length + 1)
				const top = rest.split('/')[0]
				const full = `${path}/${top}`
				if (seen.has(full)) continue
				seen.add(full)
				out.push({ path: full, type: rest.includes('/') ? 'dir' : 'file' })
			}
			return out
		},
		async rm(path) {
			for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p)
		},
		async rename(oldPath, newPath) {
			for (const p of [...files.keys()])
				if (p === oldPath || p.startsWith(`${oldPath}/`)) {
					files.set(newPath + p.slice(oldPath.length), files.get(p)!)
					files.delete(p)
				}
		},
		dump() {
			return Object.fromEntries([...files].map(([k, vbytes]) => [k, dec.decode(vbytes)]))
		}
	}
}

test('listProjects returns {slug,name}, tolerating a missing project.json', async () => {
	const vol = fakeVolume()
	await createProject(vol, 'My Cool App', 'alice.my-cool-app')
	await vol.writeFile('/projects/untitled/src/app.ts', enc('//')) // legacy, no project.json
	expect(await listProjects(vol)).toEqual([
		{ slug: 'alice.my-cool-app', name: 'My Cool App' },
		{ slug: 'untitled', name: 'untitled' } // fallback to slug
	])
})

test('createProject rejects a bad id and a duplicate id, then seeds the plain template', async () => {
	const vol = fakeVolume()
	await expect(createProject(vol, 'X', 'nope')).rejects.toThrow()
	await expect(createProject(vol, 'X', 'com.example.x')).rejects.toThrow()
	const { slug } = await createProject(vol, 'X', 'alice.x')
	expect(slug).toBe('alice.x')
	expect(JSON.parse(vol.dump()['/projects/alice.x/project.json']!)).toMatchObject({
		id: 'alice.x',
		name: 'X',
		gui: 'src/gui.ts'
	})
	expect(vol.dump()['/projects/alice.x/src/gui.ts']).toContain('defineGUI')
	await expect(createProject(vol, 'X2', 'alice.x')).rejects.toThrow(/exists/)
})

test('createProject seeds React JSX and pinned browser imports', async () => {
	const vol = fakeVolume()
	await createProject(vol, 'React Counter', 'alice.react-counter', 'react')
	const files = vol.dump()
	const meta = JSON.parse(files['/projects/alice.react-counter/project.json']!)
	expect(meta).toMatchObject({
		gui: 'src/gui.tsx',
		compiler: { jsx: 'react-jsx' },
		imports: {
			react: 'https://esm.sh/react@19.1.1',
			'react/jsx-runtime': 'https://esm.sh/react@19.1.1/jsx-runtime',
			'react-dom/client': 'https://esm.sh/react-dom@19.1.1/client?bundle&deps=react@19.1.1'
		}
	})
	expect(files['/projects/alice.react-counter/src/gui.tsx']).toContain("from 'react-dom/client'")
	expect(files['/projects/alice.react-counter/src/gui.ts']).toBeUndefined()
})

test('slugifyName derives a sane id segment', () => {
	expect(slugifyName('My Cool App!')).toBe('my-cool-app')
	expect(slugifyName('')).toBe('app')
})

test('saveMeta rewrites name/version/description; id + entries preserved', async () => {
	const vol = fakeVolume()
	await createProject(vol, 'X', 'alice.x')
	await saveMeta(vol, 'alice.x', { name: 'Renamed', version: '1.0.0', description: 'hi' })
	const m = JSON.parse(vol.dump()['/projects/alice.x/project.json']!)
	expect(m).toMatchObject({
		id: 'alice.x',
		name: 'Renamed',
		version: '1.0.0',
		description: 'hi'
	})
	expect(m.app).toBe('src/app.ts') // entries untouched
})

test('saveMeta updates imports and preserves the React compiler setting', async () => {
	const vol = fakeVolume()
	await createProject(vol, 'React Counter', 'alice.react-counter', 'react')
	await saveMeta(vol, 'alice.react-counter', {
		name: 'React Counter',
		imports: { react: 'https://esm.sh/react@19.1.2' }
	})
	const meta = JSON.parse(vol.dump()['/projects/alice.react-counter/project.json']!)
	expect(meta.imports).toEqual({ react: 'https://esm.sh/react@19.1.2' })
	expect(meta.compiler).toEqual({ jsx: 'react-jsx' })
})

test('removeProject drops the project folder and its scratch', async () => {
	const vol = fakeVolume()
	await createProject(vol, 'X', 'alice.x')
	await vol.writeFile('/.devkit/alice.x/state/s.json', enc('{}'))
	await removeProject(vol, 'alice.x')
	expect(await vol.exists('/projects/alice.x')).toBe(false)
	expect(await vol.exists('/.devkit/alice.x')).toBe(false)
})
