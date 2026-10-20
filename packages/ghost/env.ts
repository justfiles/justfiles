import type { Context } from '@earendil-works/chord'
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	LineScanner,
	ok,
	type Result,
	type ShellExecResult,
	type ShellSpillOptions,
	type TextLine
} from '@earendil-works/pi-durable/env'
import type { Volume } from '@justfiles/fs'
import { Bash, type CommandName, type FsStat, getCommandNames } from 'just-bash'
import { volumeFs } from './justbash/volume-fs.ts'

/** The shell's credentials; no file tool or command of the ghost reaches them. */
const PRIVATE = ['/private']

/**
 * pi-durable's `ExecutionEnv` over the Volume: the files are the Volume's, and the shell is
 * just-bash over the same files, so nothing reaches the real disk or starts a process. `at`
 * gives an environment per working directory. They share one file system id, so pi orders
 * `edit` and `write` calls on one file across them. `close` stops watching the Volume.
 */
/**
 * just-bash's commands, less `sqlite3`: it runs in a worker started from a file beside
 * just-bash, which the shell's one-file bundle does not have.
 */
const COMMANDS = getCommandNames().filter((name) => name !== 'sqlite3') as CommandName[]

export function volumeEnv(volume: Volume): {
	at(cwd: string): ExecutionEnv
	close(): Promise<void>
} {
	// Both halves go through this one adapter, so `/private` is denied to both alike.
	const fs = volumeFs(volume, PRIVATE)
	const bash = new Bash({ fs, cwd: '/', commands: COMMANDS })
	const id = `volume:${crypto.randomUUID()}`

	const at = (cwd: string): ExecutionEnv => {
		const resolve = (path: string) => fs.resolvePath(cwd, path)
		const lstatInfo = async (path: string) => toInfo(path, await fs.lstat(path))
		const makeParent = (path: string) => fs.mkdir(parentOf(path), { recursive: true })

		const env: ExecutionEnv = {
			id,
			cwd,
			absolutePath: async (path) => ok(resolve(path)),
			async joinPath(parts) {
				const joined = parts.join('/')
				const absolute = fs.resolvePath('/', joined)
				return ok(joined.startsWith('/') ? absolute : absolute.slice(1) || '.')
			},
			readTextFile: (path, context) =>
				attempt(context, resolve(path), async (at) => decode(await fs.readFileBuffer(at))),
			openTextLineReader: (path, context) =>
				attempt(context, resolve(path), async (at) =>
					lineReader(at, decode(await fs.readFileBuffer(at)))
				),
			readTextLines: (path, options, context) =>
				attempt(context, resolve(path), async (at) =>
					splitLines(decode(await fs.readFileBuffer(at)))
						.slice(0, Math.max(0, options?.maxLines ?? Number.POSITIVE_INFINITY))
						.map((line) => line.text)
				),
			readBinaryFile: (path, context) =>
				attempt(context, resolve(path), (at) => fs.readFileBuffer(at)),
			openBinaryReader: (path, options, context) =>
				attempt(context, resolve(path), async (at) => {
					if (options?.noFollow && (await fs.lstat(at)).isSymbolicLink)
						throw new FileError('invalid', 'Refusing to follow a symbolic link', at)
					const stat = await fs.stat(at)
					if (stat.isDirectory) throw new FileError('is_directory', 'Is a directory', at)
					if (!stat.isFile) throw new FileError('invalid', 'Not a regular file', at)
					// The bytes are read once, so the reader keeps the file it opened across a rename.
					return binaryReader(at, toInfo(at, stat), await fs.readFileBuffer(at))
				}),
			writeFile: (path, content, context) =>
				attempt(context, resolve(path), async (at) => {
					await makeParent(at)
					await fs.writeFile(at, content)
				}),
			appendFile: (path, content, context) =>
				attempt(context, resolve(path), async (at) => {
					await makeParent(at)
					await fs.appendFile(at, content)
				}),
			truncateFile: (path, size, context) =>
				attempt(context, resolve(path), async (at) => {
					if (!Number.isSafeInteger(size) || size < 0)
						throw new FileError('invalid', 'File size must be a non-negative safe integer', at)
					const bytes = new Uint8Array(size)
					bytes.set((await fs.readFileBuffer(at)).subarray(0, size))
					await fs.writeFile(at, bytes)
				}),
			// The Volume has no buffered handle to flush; the file only has to exist.
			flushFile: (path, context) =>
				attempt(context, resolve(path), async (at) => {
					if ((await fs.stat(at)).isDirectory)
						throw new FileError('is_directory', 'Is a directory', at)
				}),
			renameFile: (source, destination, context) =>
				attempt(context, resolve(source), (at) => fs.mv(at, resolve(destination))),
			fileInfo: (path, context) => attempt(context, resolve(path), lstatInfo),
			listDir: (path, context) =>
				attempt(context, resolve(path), async (at) => {
					const infos: FileInfo[] = []
					for (const name of await fs.readdir(at)) infos.push(await lstatInfo(join(at, name)))
					return infos
				}),
			openDirReader: (path, context) =>
				attempt(context, resolve(path), async (at) =>
					dirReader(at, await fs.readdir(at), lstatInfo)
				),
			watch: (targets, onChange, context) =>
				attempt(context, undefined, async () => {
					// A recursive Volume watch wakes on structure only, not on edits below it, and
					// names no path, so a change is reported as its target.
					let closed = false
					const stops = await Promise.all(
						targets.map((target) => {
							const at = resolve(target.path)
							return volume.watch(at, () => !closed && onChange({ paths: [at] }), {
								recursive: target.recursive
							})
						})
					)
					const watcher: FileWatcher = {
						mode: 'native',
						async close() {
							if (closed) return
							closed = true
							for (const stop of stops) stop()
						}
					}
					return watcher
				}),
			canonicalPath: (path, context) => attempt(context, resolve(path), (at) => fs.realpath(at)),
			async exists(path, context) {
				const info = await env.fileInfo(path, context)
				if (info.ok) return ok(true)
				return info.error.code === 'not_found' ? ok(false) : err(info.error)
			},
			createDir: (path, options, context) =>
				attempt(context, resolve(path), (at) =>
					fs.mkdir(at, { recursive: options?.recursive ?? true })
				),
			remove: (path, options, context) =>
				attempt(context, resolve(path), (at) =>
					fs.rm(at, { recursive: options?.recursive ?? false, force: options?.force ?? false })
				),
			createTempDir: (prefix, context) =>
				attempt(context, undefined, async () => {
					const dir = `/tmp/${prefix ?? 'tmp-'}${crypto.randomUUID()}`
					await fs.mkdir(dir, { recursive: true })
					return dir
				}),
			async createTempFile(options, context) {
				const dir = await env.createTempDir('tmp-', context)
				if (!dir.ok) return dir
				const file = join(
					dir.value,
					`${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`
				)
				return attempt(context, file, async (at) => {
					await fs.writeFile(at, '')
					return at
				})
			},

			async exec(command, options, context): Promise<Result<ShellExecResult, ExecutionError>> {
				const signals = [context.abortSignal]
				const timeout = options?.timeout
				if (timeout !== undefined) {
					if (!Number.isFinite(timeout) || timeout <= 0)
						return err(
							new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds')
						)
					signals.push(AbortSignal.timeout(timeout * 1000))
				}
				const signal = AbortSignal.any(signals.filter((s) => s !== undefined))
				const interrupted = (): Result<ShellExecResult, ExecutionError> =>
					context.abortSignal?.aborted
						? err(new ExecutionError('aborted', 'aborted'))
						: err(new ExecutionError('timeout', `timeout:${timeout}`))
				if (signal.aborted) return interrupted()

				const dir = options?.cwd === undefined ? cwd : resolve(options.cwd)
				const isDir = await fs.stat(dir).then(
					(stat) => stat.isDirectory,
					() => false
				)
				if (!isDir)
					return err(new ExecutionError('spawn_error', `Working directory does not exist: ${dir}`))
				const argv = typeof command === 'string' ? undefined : command
				const program = argv?.[0]
				if (argv !== undefined && program === undefined)
					return err(new ExecutionError('spawn_error', 'Empty argv: no program to run'))

				let result: Awaited<ReturnType<Bash['exec']>>
				try {
					result = await bash.exec(program === undefined ? (command as string) : quote(program), {
						cwd: dir,
						env: options?.env,
						replaceEnv: options?.inheritEnv === false,
						signal,
						...(argv === undefined ? {} : { args: argv.slice(1) })
					})
				} catch (error) {
					if (signal.aborted) return interrupted()
					return err(new ExecutionError('unknown', messageOf(error)))
				}
				if (signal.aborted) return interrupted()
				// just-bash reports a missing program as exit 127; argv names one program, so it never ran.
				if (argv !== undefined && result.exitCode === 127)
					return err(new ExecutionError('spawn_error', result.stderr.trim()))
				try {
					// just-bash returns the output whole; it arrives as one chunk per stream.
					for (const stream of ['stdout', 'stderr'] as const)
						if (result[stream] !== '') options?.onOutput?.(result[stream], context, { stream })
				} catch (error) {
					return err(new ExecutionError('callback_error', messageOf(error)))
				}
				// Past the thresholds, the whole output also goes to a file the model can read back.
				const output = result.stdout + result.stderr
				if (options?.spill === undefined || !exceeds(output, options.spill))
					return ok({ exitCode: result.exitCode })
				const lost = (error: FileError): Result<ShellExecResult, ExecutionError> =>
					err(
						new ExecutionError(
							'unknown',
							`Failed to preserve complete shell output: ${error.message}`,
							error
						)
					)
				const file = await env.createTempFile({ prefix: 'pi-output-', suffix: '.log' }, context)
				if (!file.ok) return lost(file.error)
				const wrote = await env.writeFile(file.value, output, context)
				if (!wrote.ok) return lost(wrote.error)
				return ok({ exitCode: result.exitCode, spillPath: file.value })
			},
			// Nothing to stop: commands run in this process and end with their call.
			async cleanup() {}
		}
		return env
	}
	return { at, close: () => fs.close() }
}

/** Whether `output` is past either spill threshold, counting a last unterminated line. */
function exceeds(output: string, spill: ShellSpillOptions): boolean {
	if (output === '') return false
	const lines = output.split('\n').length - (output.endsWith('\n') ? 1 : 0)
	return new TextEncoder().encode(output).length > spill.afterBytes || lines > spill.afterLines
}

/** Run `fn` on `path` as a pi `Result`: an abort before it starts, or its error as a `FileError`. */
async function attempt<T, P extends string | undefined>(
	context: Context,
	path: P,
	fn: (path: P) => Promise<T>
): Promise<Result<T, FileError>> {
	if (context.abortSignal?.aborted) return err(new FileError('aborted', 'aborted', path))
	try {
		return ok(await fn(path))
	} catch (error) {
		return err(toFileError(error, path))
	}
}

const CODES: Record<string, FileErrorCode> = {
	ENOENT: 'not_found',
	EACCES: 'permission_denied',
	EPERM: 'permission_denied',
	ENOTDIR: 'not_directory',
	EISDIR: 'is_directory',
	EINVAL: 'invalid',
	ELOOP: 'invalid',
	ENOSYS: 'not_supported'
}

/** volumeFs tags each Volume error with its POSIX `code`; pi wants its own. */
function toFileError(error: unknown, path?: string): FileError {
	if (error instanceof FileError) return error
	const cause = error instanceof Error ? error : new Error(String(error))
	const code = CODES[(cause as Error & { code?: string }).code ?? ''] ?? 'unknown'
	return new FileError(code, cause.message, path, cause)
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function toInfo(path: string, stat: FsStat): FileInfo {
	const kind = stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file'
	return {
		name: path.slice(path.lastIndexOf('/') + 1),
		path,
		kind,
		size: stat.size,
		mtimeMs: stat.mtime.getTime()
	}
}

/** UTF-8 text keeping a byte-order mark, as Node's `readFile(path, 'utf8')` does. */
function decode(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

function splitLines(text: string): TextLine[] {
	if (text === '') return []
	const parts = text.split('\n')
	const last = parts.pop() as string
	const lines = parts.map((line) => ({ text: line, terminated: true }))
	if (last !== '') lines.push({ text: last, terminated: false })
	return lines
}

/** A reader that refuses use after close and stops on abort, as pi's readers do. */
function guarded(path: string) {
	let closed = false
	return {
		check(context: Context): FileError | undefined {
			if (context.abortSignal?.aborted) return new FileError('aborted', 'aborted', path)
			if (closed) return new FileError('invalid', 'Reader is closed', path)
		},
		async close() {
			closed = true
		}
	}
}

function lineReader(path: string, text: string) {
	const lines = splitLines(text)
	const state = guarded(path)
	return {
		async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
			const failed = state.check(context)
			return failed === undefined ? ok(lines.shift()) : err(failed)
		},
		close: state.close
	}
}

function binaryReader(path: string, info: FileInfo, bytes: Uint8Array): BinaryReader {
	const state = guarded(path)
	return {
		async info(context) {
			const failed = state.check(context)
			return failed === undefined ? ok(info) : err(failed)
		},
		async read(offset, length, context) {
			const failed = state.check(context)
			if (failed !== undefined) return err(failed)
			if (
				!Number.isSafeInteger(offset) ||
				!Number.isSafeInteger(length) ||
				offset < 0 ||
				length < 0
			)
				return err(
					new FileError('invalid', 'Offset and length must be non-negative integers', path)
				)
			return ok(bytes.slice(offset, offset + length))
		},
		async scanLines({ startLine, endLine }, context) {
			const failed = state.check(context)
			if (failed !== undefined) return err(failed)
			try {
				const scanner = new LineScanner(startLine, endLine)
				scanner.push(bytes)
				return ok(scanner.finish())
			} catch (error) {
				return err(new FileError('invalid', messageOf(error), path))
			}
		},
		close: state.close
	}
}

function dirReader(
	path: string,
	names: string[],
	info: (path: string) => Promise<FileInfo>
): DirReader {
	const state = guarded(path)
	return {
		async next(maxEntries, context) {
			const failed = state.check(context)
			if (failed !== undefined) return err(failed)
			if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
				return err(new FileError('invalid', 'maxEntries must be a positive integer', path))
			const entries: FileInfo[] = []
			while (entries.length < maxEntries && names.length > 0) {
				const at = join(path, names.shift() as string)
				try {
					entries.push(await info(at))
				} catch (error) {
					// An entry removed since the listing is skipped.
					const failure = toFileError(error, at)
					if (failure.code !== 'not_found') return err(failure)
				}
			}
			return ok({ entries, done: names.length === 0 })
		},
		close: state.close
	}
}

function join(dir: string, name: string): string {
	return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function parentOf(path: string): string {
	const i = path.lastIndexOf('/')
	return i <= 0 ? '/' : path.slice(0, i)
}

/** One shell word, so just-bash runs `program` as named. */
function quote(program: string): string {
	return `'${program.replaceAll("'", `'\\''`)}'`
}
