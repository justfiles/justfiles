import type { Volume } from '@justfiles/fs'
import type { z } from 'zod'

export function file(volume: Volume, path: string) {
	return { text, lines, json, jsonl, write, append }

	async function text(): Promise<string | null> {
		let raw: Uint8Array
		try {
			raw = await volume.readFile(path)
		} catch {
			return null
		}
		if (!raw) return null
		return new TextDecoder().decode(raw)
	}

	async function lines(): Promise<string[]> {
		const content = await text()
		if (!content?.trim()) return []
		return content.trim().split('\n')
	}

	async function json<T>(schema: z.ZodType<T>): Promise<T | null> {
		let raw: Uint8Array
		try {
			raw = await volume.readFile(path)
		} catch {
			return null
		}
		const json = JSON.parse(new TextDecoder().decode(raw))
		return schema.parse(json)
	}

	async function jsonl<T>(schema: z.ZodType<T>): Promise<T[]> {
		const all = await lines()
		return all.map((line) => schema.parse(JSON.parse(line)))
	}

	async function write(content: string): Promise<void> {
		await ensureDir()
		await volume.writeFile(path, new TextEncoder().encode(content))
	}

	async function append(content: string): Promise<void> {
		await ensureDir()
		await volume.appendFile(path, new TextEncoder().encode(content))
	}

	async function ensureDir(): Promise<void> {
		const dir = path.slice(0, path.lastIndexOf('/')) || '/'
		await volume.mkdir(dir, { recursive: true })
	}
}
