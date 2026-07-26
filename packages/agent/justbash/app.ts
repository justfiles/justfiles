import type { ActionMeta, AppController, AppInspection, AppSummary } from '@justfiles/app'
import type { ExecResult } from 'just-bash'
import type { ShellCommand } from './index.ts'

export type { AppController } from '@justfiles/app'

/**
 * The `app` command as a ShellCommand: list, launch, inspect, and drive apps over
 * the kernel (see apps/mac/daemon/agent.ts). The canonical example of a custom
 * command — it ignores the fs entirely and closes over an injected controller,
 * showing that a ShellCommand is just a named `execute` with a summary.
 */
export function createAppCommand(controller: AppController): ShellCommand {
	return {
		name: 'app',
		summary:
			"Drive the user's apps — your MAIN way to get things done. `app list` to see them, `app inspect <id>` for an app's actions and state, `app run --id <id> <action> key=value` to act, `app launch <id>` to open it. Output is plain text you can pipe like any shell tool (a procedure's result prints verbatim); pipe long/multi-line text INTO a param with `--stdin <key>` (heredoc or `|`). Prefer this over editing files or writing scripts.",
		// just-bash hands `execute` the argv after the command name (`app list` →
		// ['list']) plus a ctx carrying stdin, exactly the shape the dispatch logic expects.
		execute: (argv, ctx) => run(controller, argv, decodeStdin(ctx.stdin))
	}
}

// `ctx.stdin` is an opaque ByteString — a latin1 byte buffer (each char code is a
// byte). just-bash's own `decodeBytesToUtf8` lives only in its Node entry (the
// browser bundle omits it), so inline the same decode: reinterpret the bytes as
// UTF-8, falling back to the raw latin1 view when they aren't valid UTF-8.
function decodeStdin(stdin: unknown): string {
	const latin1 = String(stdin ?? '')
	try {
		return new TextDecoder().decode(Uint8Array.from(latin1, (c) => c.charCodeAt(0)))
	} catch {
		return latin1
	}
}

/**
 * The `# apps` system-prompt block. Deliberately open-ended: it tells the agent that driving
 * apps through the `app` command is its primary way to act and points it at `app list` to
 * DISCOVER what's installed at runtime, rather than embedding a snapshot. A live list would
 * change the block (and so the whole stable prompt prefix) whenever apps change — this stays
 * byte-identical across turns, scales to any number of apps, and can never go stale.
 */
export const APPS_PROMPT = [
	"You operate this device by driving its apps through the `app` command in your bash tool. This is your PRIMARY way to get things done for the user: an app owns its own data and actions, so run an app action rather than editing files by hand, and NEVER write scripts to read or change an app's data directly.",
	'',
	"Don't assume from memory which apps exist — the set can change. Run `app list` to see what's installed right now, `app inspect <id>` to read an app's actions and current state, then `app run --id <id> <action> key=value` to act. `app launch <id>` opens an app for the user."
].join('\n')

async function run(controller: AppController, argv: string[], stdin: string): Promise<ExecResult> {
	const [cmd = 'help', ...rest] = argv
	try {
		if (cmd === 'help' || cmd === '--help' || cmd === '-h') return out(help())
		if (cmd === 'list') return out((await controller.list()).map(appLine).join('\n'))
		if (cmd === 'launch') {
			const id = rest[0]
			if (!id) return fail('missing app id', help())
			await controller.launch(id)
			return out(`launched ${id}`)
		}
		if (cmd === 'close') {
			const { id } = parseTarget(rest)
			await controller.close(id)
			return out(id ? `closed ${id}` : 'closed')
		}
		if (cmd === 'current') {
			const current = await controller.current()
			if (!current) return fail('no current app; use `app launch <id>` or `app run --id <id> ...`')
			return out(appLine(current))
		}
		if (cmd === 'inspect') {
			const { id } = parseTarget(rest)
			return out(renderApp(await inspectTarget(controller, id)))
		}
		if (cmd === 'state') {
			const { id } = parseTarget(rest)
			const app = await target(controller, id)
			return out(json(await controller.state(app.id)))
		}
		if (cmd === 'actions') {
			const { id } = parseTarget(rest)
			const app = await inspectTarget(controller, id)
			return out(renderActions(app.id, app.actions))
		}
		if (cmd === 'run') return await runAction(controller, rest, stdin)
		return fail(`unknown app command: ${cmd}`, help())
	} catch (error) {
		return fail(msg(error))
	}
}

async function runAction(
	controller: AppController,
	argv: string[],
	stdin: string
): Promise<ExecResult> {
	const { id, rest } = parseTarget(argv)
	const [action, ...tokens] = rest
	if (!action) return fail('missing action', help())
	const app = await inspectTarget(controller, id)
	const meta = app.actions[action]
	if (!meta)
		return fail(
			`unknown action: ${action}`,
			`available actions: ${Object.keys(app.actions).join(', ')}\n\n${examplesText(app.id, app.actions)}`
		)
	let params: Record<string, unknown>
	try {
		params = parseParams(tokens, stdin)
	} catch (error) {
		// A malformed param is the agent's fault-line — surface it (never a silently
		// coerced string) with THIS action's usage + examples, so the correct call is
		// discoverable exactly when it fails.
		return fail(msg(error), renderAction(app.id, action, meta))
	}
	try {
		const result = await controller.run(app.id, action, params)
		// A procedure returns a value to read, so print it (a `show` .pixel dump prints
		// verbatim, so it pipes into `setGrid --stdin grid`). A handler is a mutation —
		// stay quiet like a normal shell command; success is the exit code.
		return out(meta.kind === 'procedure' ? text(result) : 'ok')
	} catch (error) {
		return fail(msg(error), renderAction(app.id, action, meta))
	}
}

async function inspectTarget(controller: AppController, id?: string): Promise<AppInspection> {
	const app = await target(controller, id)
	return controller.inspect(app.id)
}

async function target(controller: AppController, id?: string): Promise<{ id: string }> {
	if (id) return { id }
	const current = await controller.current()
	if (!current) throw new Error('no current app; use app launch <id> or app run --id <id> ...')
	return current
}

function parseTarget(argv: string[]): { id?: string; rest: string[] } {
	const rest: string[] = []
	let id: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]
		if (token === undefined) continue
		if (token === '--id') id = argv[++i]
		else if (token.startsWith('--id=')) id = token.slice('--id='.length)
		else rest.push(token)
	}
	return { id, rest }
}

function parseParams(tokens: string[], stdin: string): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		if (token === undefined) continue
		if (token === '--params-json') {
			const raw = tokens[++i] ?? '{}'
			let parsed: unknown
			try {
				parsed = JSON.parse(raw)
			} catch (error) {
				throw new Error(
					`--params-json is not valid JSON (${msg(error)}). Single-quote the whole object so the shell passes it through verbatim, e.g. --params-json '{"pixels":[{"x":0,"y":0,"i":1}]}'.`
				)
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
				throw new Error(
					`--params-json must be a JSON object of params, got ${JSON.stringify(parsed)}. Wrap it in { } , e.g. --params-json '{"pixels":[{"x":0,"y":0,"i":1}]}'.`
				)
			// Merge (not replace) so structured params compose with earlier/later
			// key=value and --stdin tokens on the same command line.
			Object.assign(out, parsed as Record<string, unknown>)
			continue
		}
		if (token === '--stdin') {
			// The param whose value is the command's stdin — for long/multi-line text
			// (a grid, a note body) that would be mangled inline: pipe it or use a
			// heredoc, e.g. `app run --id <id> setGrid --stdin grid <<'EOF' … EOF`.
			const key = tokens[++i]
			if (!key || key.startsWith('--'))
				throw new Error(
					"--stdin needs a param name, e.g. --stdin grid, and the value piped in via a heredoc or | (app run --id <id> setGrid --stdin grid <<'EOF' … EOF)."
				)
			out[key] = stdin
			continue
		}
		const eq = token.indexOf('=')
		if (eq < 1)
			throw new Error(
				`expected key=value, got ${JSON.stringify(token)}. Pass scalars as key=value (amount=2, tool=pencil); pass an array/object as one JSON object via --params-json '<json>'; pass long/multi-line text via --stdin <key> (piped in).`
			)
		out[token.slice(0, eq)] = parseValue(token.slice(eq + 1))
	}
	return out
}

// A bare word stays a string when it isn't JSON, so `color=#d04648` / `tool=pencil`
// work. But a value that plainly MEANT to be structured (`[…]` / `{…}`) yet fails
// to parse is almost always the shell having stripped the quotes off inline JSON
// (`pixels=[{"x":0}]` → `pixels=]`) — surface that as an error pointing at the
// robust form, rather than passing a broken string on to schema validation.
function parseValue(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch (error) {
		if (/^\s*[[{]/.test(value))
			throw new Error(
				`could not parse JSON value ${JSON.stringify(value)} (${msg(error)}). Inline key=value is unquoted by the shell, so it mangles JSON — pass structured params as one JSON object via --params-json '<json>' (single-quoted), e.g. app run --id <id> <action> --params-json '{"pixels":[{"x":0,"y":0,"i":1}]}'.`
			)
		return value
	}
}

function msg(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function examplesText(appId: string, actions: Record<string, ActionMeta>): string {
	return Object.entries(actions)
		.flatMap(([name, meta]) =>
			(meta.examples ?? []).map((e) => `  ${example(appId, name, e.params)}`)
		)
		.join('\n')
}

function example(appId: string, action: string, params: Record<string, unknown>): string {
	const head = `app run --id ${appId} ${action}`
	// Any array/object value must go through --params-json: an inline JSON value is
	// unquoted by the shell (`pixels=[{"x":0}]` → `pixels=]`), and schema validation
	// then rejects it. So the moment a param is structured, emit the whole object as
	// one single-quoted --params-json blob — the only form that round-trips a shell.
	const structured = Object.values(params).some((v) => v !== null && typeof v === 'object')
	if (structured) return `${head} --params-json '${JSON.stringify(params)}'`
	const args = Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
	return [head, ...args].join(' ')
}

function out(body: string): ExecResult {
	return { stdout: body, stderr: '', exitCode: 0 }
}

// Errors are plain text on stderr with a non-zero exit — the shell-native signal,
// not a `{ok:false}` envelope. `hint` carries the (already-text) usage/examples so
// a failed call is self-correcting.
function fail(message: string, hint?: string): ExecResult {
	return { stdout: '', stderr: hint ? `${message}\n\n${hint}` : message, exitCode: 1 }
}

// A result printed for a human/agent: a string verbatim (so a `show` dump pipes
// on), anything else as JSON — structured data has no canonical text form, so JSON
// is its natural serialization (there is no universal envelope).
function text(value: unknown): string {
	return typeof value === 'string' ? value : json(value)
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2)
}

function appLine(app: AppSummary): string {
	return app.description ? `${app.id}  ${app.name} — ${app.description}` : `${app.id}  ${app.name}`
}

function renderApp(app: AppInspection): string {
	return [
		appLine(app),
		'',
		'state:',
		json(app.state),
		'',
		'actions:',
		renderActions(app.id, app.actions)
	].join('\n')
}

function renderActions(appId: string, actions: Record<string, ActionMeta>): string {
	return Object.entries(actions)
		.map(([name, meta]) => renderAction(appId, name, meta))
		.join('\n\n')
}

function renderAction(appId: string, name: string, meta: ActionMeta): string {
	const lines = [meta.description ? `${name} — ${meta.description}` : name]
	const params = paramsHint(meta.schemaHint)
	if (params) lines.push(`  params: ${params}`)
	for (const e of meta.examples ?? []) lines.push(`  ${example(appId, name, e.params)}`)
	return lines.join('\n')
}

function paramsHint(schemaHint: unknown): string {
	if (!schemaHint || typeof schemaHint !== 'object') return ''
	return Object.entries(schemaHint as Record<string, unknown>)
		.map(([k, v]) => `${k}:${String(v)}`)
		.join(' ')
}

function help(): string {
	return [
		'app <list|launch|close|current|inspect|state|actions|run|help>',
		'',
		'Scalars pass as key=value (amount=2, tool=pencil, color=#d04648).',
		"Arrays/objects go as one JSON object via --params-json '<json>' (single-quoted) — inline key=value is unquoted by the shell, which mangles JSON.",
		'Long or multi-line text (a grid, a note body) goes via --stdin <key>: pipe it or use a heredoc, and its value becomes params[<key>].',
		'',
		'Examples:',
		'  app list',
		'  app launch com.example.counter',
		'  app current',
		'  app run --id com.example.counter increment amount=2',
		'  app run --id com.example.counter setItems --params-json \'{"items":[{"x":0,"y":0}]}\'',
		"  printf '..66..' | app run --id com.example.pixel setGrid --stdin grid",
		'  app run --id com.example.pixel show | app run --id com.example.pixel setGrid --stdin grid',
		'  app actions --id com.example.counter'
	].join('\n')
}
