import {
	fileStem,
	imageDataUrl,
	imageFileNames,
	imageType,
	readImageFile
} from '@justfiles/app/image-type'
import {
	type AgentSoul,
	type AvatarInfo,
	DOCK_MATERIAL_NAMES,
	type DockMaterial,
	type GeneratedSoul,
	type UserFacts
} from './types.ts'

interface SoulDraftInput {
	name: string
	gender: 'female' | 'male'
	archetype?: string
	userAge?: number
	userGender?: string
}
interface IdentityPaths {
	soul: string
	avatars: string
	profile: string
}
interface HostVolume {
	exists(path: string): Promise<boolean>
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, data: Uint8Array): Promise<void>
	readdir(path: string): Promise<{ name: string }[]>
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	rm(path: string, options?: { force?: boolean }): Promise<void>
	rename(oldPath: string, newPath: string): Promise<void>
}
interface IdentityDefaults {
	soul: string
	profile: string
}

interface AgentDeps {
	volume: HostVolume
	paths: IdentityPaths
	defaults: IdentityDefaults
	builtins?: Record<string, { resting: string; states: string[] }>
	timezone?: () => string | Promise<string>
	generateSoul?: (input: SoulDraftInput) => Promise<GeneratedSoul>
}
interface AppearanceDeps {
	volume: HostVolume
	wallpaper: string
	dockMaterial: string
}

export function fileSettings({
	agent,
	appearance
}: {
	agent?: AgentDeps
	appearance?: AppearanceDeps
}) {
	return { ...agentMethods(agent), ...appearanceMethods(appearance) }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Frontmatter = Record<string, string>

function parse(text: string): { frontmatter: Frontmatter; body: string } {
	const match = text.match(/^---\n([\s\S]*?)\n---(?:\n+([\s\S]*))?$/)
	if (!match?.[1]) return { frontmatter: {}, body: text.trim() }
	const frontmatter: Frontmatter = {}
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		if (key) frontmatter[key] = line.slice(idx + 1).trim()
	}
	return { frontmatter, body: (match[2] ?? '').trim() }
}
function serialize(frontmatter: [string, string | null][], body?: string): Uint8Array {
	const lines = ['---']
	for (const [key, value] of frontmatter) {
		if (value !== null && value !== '') lines.push(`${key}: ${value.replace(/[\r\n]+/g, ' ')}`)
	}
	lines.push('---', '')
	if (body !== undefined) lines.push(body.trim(), '')
	return encoder.encode(lines.join('\n'))
}
function gender(value?: string): 'female' | 'male' | null {
	return value === 'female' || value === 'male' ? value : null
}

async function read(
	vol: HostVolume,
	path: string,
	fallback: string
): Promise<{ frontmatter: Frontmatter; body: string }> {
	if (!(await vol.exists(path))) return parse(fallback)
	return parse(decoder.decode(await vol.readFile(path)))
}
async function writeTo(vol: HostVolume, path: string, bytes: Uint8Array): Promise<void> {
	const parent = path.slice(0, path.lastIndexOf('/')) || '/'
	await vol.mkdir(parent, { recursive: true })
	await vol.writeFile(path, bytes)
}

async function entries(vol: HostVolume, path: string): Promise<string[]> {
	if (!(await vol.exists(path))) return []
	return (await vol.readdir(path)).map((entry) => entry.name).sort()
}
function label(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1)
}
function today(timezone?: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

function age(birthDate: string, now: string): number | undefined {
	if (birthDate.length < 10) return undefined
	const years = Number(now.slice(0, 4)) - Number(birthDate.slice(0, 4))
	if (Number.isNaN(years)) return undefined
	return now.slice(5) < birthDate.slice(5) ? years - 1 : years
}
function appearanceMethods(deps?: AppearanceDeps) {
	return {
		readWallpaper: async (_input: Record<string, never>) => {
			const { volume: vol, wallpaper } = required(deps)
			return (await vol.exists(wallpaper)) ? vol.readFile(wallpaper) : null
		},
		writeWallpaper: async ({ bytes }: { bytes: Uint8Array | null }) => {
			const { volume: vol, wallpaper } = required(deps)
			if (!bytes) return vol.rm(wallpaper, { force: true })
			if (!imageType(bytes)) throw new Error('Invalid settings input')
			await writeTo(vol, wallpaper, bytes)
		},
		readDockMaterial: async (_input: Record<string, never>) => {
			const { volume: vol, dockMaterial } = required(deps)
			if (!(await vol.exists(dockMaterial))) return null
			const value = decoder.decode(await vol.readFile(dockMaterial)).trim()
			return DOCK_MATERIAL_NAMES.find((name) => name === value) ?? null
		},
		writeDockMaterial: async ({ material }: { material: DockMaterial }) => {
			const { volume: vol, dockMaterial } = required(deps)
			if (!DOCK_MATERIAL_NAMES.some((name) => name === material))
				throw new Error('Invalid settings input')
			await writeTo(vol, dockMaterial, encoder.encode(material))
		}
	}
}

function agentMethods(deps?: AgentDeps) {
	// Field saves share one read-modify-write queue so concurrent edits keep both patches.
	let queue: Promise<unknown> = Promise.resolve()
	const serial = <T>(run: () => Promise<T>): Promise<T> => {
		const next = queue.then(run, run)
		queue = next.catch(() => {})
		return next
	}
	const readSoul = async (_input: Record<string, never>): Promise<AgentSoul> => {
		const { volume: vol, paths, defaults } = required(deps)
		const { frontmatter, body } = await read(vol, paths.soul, defaults.soul)
		return {
			name: frontmatter.agent_name ?? '',
			gender: gender(frontmatter.agent_gender),
			avatar: frontmatter.avatar ?? null,
			body,
			seeded: frontmatter.seeded === 'true'
		}
	}
	const readProfile = async (_input: Record<string, never>): Promise<UserFacts> => {
		const { volume: vol, paths, defaults } = required(deps)
		const { frontmatter } = await read(vol, paths.profile, defaults.profile)
		return {
			name: frontmatter.name ?? '',
			birthDate: frontmatter.birth_date ?? '',
			gender: gender(frontmatter.gender)
		}
	}
	return {
		readSoul,
		writeSoul: (patch: {
			name?: string
			gender?: 'female' | 'male'
			body?: string
			avatar?: string
		}) =>
			serial(async () => {
				const { volume: vol, paths } = required(deps)
				if (
					(patch.name !== undefined && !patch.name.trim()) ||
					(patch.body !== undefined && !patch.body.trim())
				)
					throw new Error('Name and soul cannot be empty')
				const current = await readSoul({})
				await writeTo(
					vol,
					paths.soul,
					serialize(
						[
							['schema', 'frieren/agent-soul/v1'],
							['agent_name', patch.name?.trim() ?? current.name],
							['agent_gender', patch.gender ?? current.gender],
							['avatar', patch.avatar ?? current.avatar]
						],
						patch.body ?? current.body
					)
				)
			}),
		listAvatars: async (_input: Record<string, never>) => {
			const { volume: vol, paths, builtins } = required(deps)
			const art = Object.entries(builtins ?? {}).map(([id, { resting, states }]) => ({
				ref: `builtin/${id}`,
				label: label(id),
				builtin: true,
				preview: resting,
				files: states
			}))
			const installed: AvatarInfo[] = []
			for (const id of await entries(vol, paths.avatars)) {
				if (id.startsWith('.')) continue
				const dir = `${paths.avatars}/${id}`
				const files = (await entries(vol, dir)).filter((name) => !name.startsWith('.'))
				const resting = await readImageFile(files, 'resting', (name) =>
					vol.readFile(`${dir}/${name}`)
				)
				if (!resting) continue
				const preview = imageDataUrl(resting.bytes)
				if (preview) installed.push({ ref: id, label: label(id), builtin: false, preview, files })
			}
			return [...art, ...installed]
		},
		putAvatarFile: ({
			avatar,
			name,
			bytes
		}: {
			avatar: string
			name: string
			bytes: Uint8Array | null
		}) =>
			serial(async () => {
				const { volume: vol, paths } = required(deps)
				for (const part of [avatar, name]) {
					if (!part || part.startsWith('.') || /[/\\]/.test(part)) {
						throw new Error('Invalid settings input')
					}
				}
				const dir = `${paths.avatars}/${avatar}`
				const state = fileStem(name)
				const claimants = imageFileNames(await entries(vol, dir), state)
				if (bytes) {
					const staged = `${dir}/.put-${state}`
					await writeTo(vol, staged, bytes)
					await vol.rename(staged, `${dir}/${state}`)
					for (const claimant of claimants) {
						if (claimant !== state) await vol.rm(`${dir}/${claimant}`, { force: true })
					}
				} else {
					for (const claimant of claimants) await vol.rm(`${dir}/${claimant}`, { force: true })
				}
			}),
		readProfile: readProfile,
		writeProfile: (patch: {
			name?: string
			birthDate?: string
			gender?: 'female' | 'male' | null
		}) =>
			serial(async () => {
				const { volume: vol, paths } = required(deps)
				const current = await readProfile({})
				await writeTo(
					vol,
					paths.profile,
					serialize([
						['schema', 'frieren/user-profile/v1'],
						['name', patch.name ?? current.name],
						['birth_date', patch.birthDate ?? current.birthDate],
						['gender', patch.gender === undefined ? current.gender : patch.gender]
					])
				)
			}),
		generateSoul: async ({
			name,
			gender: sex,
			archetype,
			user
		}: {
			name: string
			gender: 'female' | 'male'
			archetype?: string
			user?: { birthDate?: string; gender?: 'female' | 'male' | null }
		}) => {
			const { generateSoul, timezone } = required(deps)
			const generate = required(generateSoul)
			const facts = user ?? (await readProfile({}))
			return generate({
				name,
				gender: sex,
				archetype,
				userAge: age(facts.birthDate ?? '', today(await timezone?.())),
				userGender: facts.gender ?? undefined
			})
		}
	}
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('SETTINGS_UNAVAILABLE')
	return value
}
