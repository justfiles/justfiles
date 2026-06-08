import { expect, test } from 'vitest'
import {
	createProject,
	listProjects,
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
	await createProject(vol, 'My Cool App', 'com.example.my-cool-app')
	await vol.writeFile('/projects/untitled/src/app.ts', enc('//')) // legacy, no project.json
	expect(await listProjects(vol)).toEqual([
		{ slug: 'com.example.my-cool-app', name: 'My Cool App' },
		{ slug: 'untitled', name: 'untitled' } // fallback to slug
	])
})

test('createProject rejects a bad id, a dup id; seeds project.json', async () => {
	const vol = fakeVolume()
	await expect(createProject(vol, 'X', 'nope')).rejects.toThrow() // not reverse-DNS
	const { slug } = await createProject(vol, 'X', 'com.example.x')
	expect(slug).toBe('com.example.x')
	expect(JSON.parse(vol.dump()['/projects/com.example.x/project.json']!)).toMatchObject({
		id: 'com.example.x',
		name: 'X'
	})
	await expect(createProject(vol, 'X2', 'com.example.x')).rejects.toThrow(/exists/)
})

test('slugifyName derives a sane id segment', () => {
	expect(slugifyName('My Cool App!')).toBe('my-cool-app')
	expect(slugifyName('')).toBe('app')
})
