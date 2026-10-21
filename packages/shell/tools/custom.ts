import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Tool } from '@justfiles/ghost'

// The user's own tools, beside settings.json rather than in this package: a web fetch, a
// search with their key, whatever the machine should offer. Each file in `tools/` of the shell
// directory is a module whose default export is a Tool, a list of them, or a function given
// `{ root }` (the Volume's root on disk) that returns either, directly or as a promise. Node
// runs `.ts` files directly, so no build step stands between a file and the daemon; a file
// that is not a tool fails the start, naming the file, so a typo is seen rather than skipped.

const EXTENSIONS = ['.ts', '.js', '.mjs']

type Context = { root: string }

type Export = Tool | Tool[] | ((ctx: Context) => Tool | Tool[] | Promise<Tool | Tool[]>)

/** The tools in `dir`'s files, in file name order; none when there is no `dir`. */
export async function loadCustomTools(dir: string, ctx: Context): Promise<Tool[]> {
	let names: string[]
	try {
		names = await readdir(dir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const tools: Tool[] = []
	for (const name of names.sort()) {
		if (!EXTENSIONS.some((ext) => name.endsWith(ext)) || name.endsWith('.d.ts')) continue
		const file = join(dir, name)
		let exported: Export
		try {
			exported = (await import(pathToFileURL(file).href)).default
		} catch (error) {
			throw new Error(`cannot load the tool ${file}: ${(error as Error).message}`, { cause: error })
		}
		const made = typeof exported === 'function' ? await exported(ctx) : exported
		for (const tool of Array.isArray(made) ? made : [made]) {
			if (!isTool(tool))
				throw new Error(
					`${file} does not export a tool: expected { name, description, parameters, execute }`
				)
			tools.push(tool)
		}
	}
	return tools
}

function isTool(value: unknown): value is Tool {
	if (typeof value !== 'object' || value === null) return false
	const { name, description, parameters, execute } = value as Record<string, unknown>
	return (
		typeof name === 'string' &&
		name !== '' &&
		typeof description === 'string' &&
		typeof parameters === 'object' &&
		parameters !== null &&
		typeof execute === 'function'
	)
}

/** `custom` tools, with those of `builtIn` whose names none of them takes. */
export function withCustomTools(builtIn: Tool[], custom: Tool[]): Tool[] {
	return [...builtIn.filter((tool) => !custom.some(({ name }) => name === tool.name)), ...custom]
}
