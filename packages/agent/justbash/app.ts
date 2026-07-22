import type { ActionMeta, AppController, AppInspection } from '@justfiles/app'
import type { ExecResult } from 'just-bash'
import type { ShellCommand } from './index.ts'

export type { AppController } from '@justfiles/app'

/**
 * The `app` command as a ShellCommand: list, launch, inspect, and drive apps over
 * the kernel (see apps/spud-mac/daemon/agent.ts). The canonical example of a custom
 * command — it ignores the fs entirely and closes over an injected controller,
 * showing that a ShellCommand is just a named `execute` with a summary.
 */
export function createAppCommand(controller: AppController): ShellCommand {
	return {
		name: 'app',
		summary:
			"Drive the user's apps — your MAIN way to get things done. `app list` to see them, `app inspect <id>` for an app's actions and state, `app run --id <id> <action> key=value` to act, `app launch <id>` to open it. Prefer this over editing files or writing scripts.",
		// just-bash hands `execute` the argv after the command name (`app list` →
		// ['list']), exactly the shape the dispatch logic already expects.
		execute: (argv) => run(controller, argv)
	}
}

/**
 * The `# apps` system-prompt block: tells the agent that driving apps through the `app`
 * command is its primary way to act, and lists the LIVE installed apps so it knows what it
 * can reach without first guessing. Lives next to the command so the guidance and the
 * implementation stay in sync. The list is best-effort — if it can't be read, the guidance
 * (the part that actually changes behaviour) is still returned.
 */
export async function renderAppsPrompt(controller: AppController): Promise<string> {
	const lines = [
		"You operate this device by driving its apps through the `app` command in your bash tool. This is your PRIMARY way to get things done for the user: an app owns its own data and actions, so run an app action rather than editing files by hand, and NEVER write scripts to read or change an app's data directly.",
		'',
		"Workflow: `app list` to see installed apps, `app inspect <id>` to read one app's actions and current state, then `app run --id <id> <action> key=value` to act. `app launch <id>` opens an app for the user."
	]
	const apps = await controller.list().catch(() => [])
	if (apps.length > 0) {
		lines.push('', 'Installed apps:')
		for (const app of apps) {
			lines.push(
				`- \`${app.id}\`${app.name ? ` (${app.name})` : ''}${app.description ? ` — ${app.description}` : ''}`
			)
		}
	}
	return lines.join('\n')
}

async function run(controller: AppController, argv: string[]): Promise<ExecResult> {
	const [cmd = 'help', ...rest] = argv
	try {
		if (cmd === 'help' || cmd === '--help' || cmd === '-h') return ok(help())
		if (cmd === 'list') return ok({ ok: true, apps: await controller.list() })
		if (cmd === 'launch') {
			const id = rest[0]
			if (!id) return fail('BAD_USAGE', 'missing app id', help())
			return ok({ ok: true, current: await controller.launch(id) })
		}
		if (cmd === 'close') {
			const { id } = parseTarget(rest)
			await controller.close(id)
			return ok({ ok: true })
		}
		if (cmd === 'current') {
			const current = await controller.current()
			if (!current) return fail('NO_CURRENT_APP', 'no current app', help())
			return ok({ ok: true, current })
		}
		if (cmd === 'inspect') {
			const { id } = parseTarget(rest)
			return ok({ ok: true, app: await inspectTarget(controller, id) })
		}
		if (cmd === 'state') {
			const { id } = parseTarget(rest)
			const app = await target(controller, id)
			return ok({ ok: true, appId: app.id, state: await controller.state(app.id) })
		}
		if (cmd === 'actions') {
			const { id } = parseTarget(rest)
			const app = await inspectTarget(controller, id)
			return ok({ ok: true, appId: app.id, actions: formatActions(app.id, app.actions) })
		}
		if (cmd === 'run') return await runAction(controller, rest)
		return fail('BAD_USAGE', `unknown app command: ${cmd}`, help())
	} catch (error) {
		return fail('APP_ERROR', error instanceof Error ? error.message : String(error), help())
	}
}

async function runAction(controller: AppController, argv: string[]): Promise<ExecResult> {
	const { id, rest } = parseTarget(argv)
	const [action, ...tokens] = rest
	if (!action) return fail('BAD_USAGE', 'missing action', help())
	const app = await inspectTarget(controller, id)
	if (!app.actions[action]) {
		return fail('UNKNOWN_ACTION', `unknown action: ${action}`, {
			availableActions: Object.keys(app.actions),
			examples: examples(app.id, app.actions)
		})
	}
	let params: Record<string, unknown>
	try {
		params = parseParams(tokens)
	} catch (error) {
		// A malformed param is the agent's fault-line — surface it as an error (never
		// a silently-coerced string) carrying THIS action's full usage + examples, so
		// the correct call is discoverable exactly when it fails.
		return fail('BAD_PARAMS', error instanceof Error ? error.message : String(error), {
			action: formatAction(app.id, action, app.actions[action])
		})
	}
	try {
		// `result` is the action's return: the new state for handlers, the
		// query's return value for queries. The action's `kind` is in
		// `app.actions[action]`, so the agent can interpret accordingly.
		return ok({
			ok: true,
			appId: app.id,
			action: { type: action, params, actor: 'agent', kind: app.actions[action].kind },
			result: await controller.run(app.id, action, params)
		})
	} catch (error) {
		return fail('APP_VALIDATION_FAILED', error instanceof Error ? error.message : String(error), {
			action: formatAction(app.id, action, app.actions[action])
		})
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

function parseParams(tokens: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		if (token === undefined) continue
		if (token === '--params-json') {
			const raw = tokens[++i] ?? '{}'
			try {
				return JSON.parse(raw) as Record<string, unknown>
			} catch (error) {
				throw new Error(
					`--params-json is not valid JSON (${msg(error)}). Single-quote the whole object so the shell passes it through verbatim, e.g. --params-json '{"pixels":[{"x":0,"y":0,"i":1}]}'.`
				)
			}
		}
		const eq = token.indexOf('=')
		if (eq < 1)
			throw new Error(
				`expected key=value, got ${JSON.stringify(token)}. Pass scalars as key=value (amount=2, tool=pencil); pass an array/object as one JSON object via --params-json '<json>'.`
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

function formatActions(appId: string, actions: Record<string, ActionMeta>) {
	return Object.fromEntries(
		Object.entries(actions).map(([name, meta]) => [name, formatAction(appId, name, meta)])
	)
}

function formatAction(appId: string, name: string, meta: ActionMeta) {
	return {
		name,
		description: meta.description,
		usage: `app run --id ${appId} ${name} key=value ...  (arrays/objects: --params-json '<json>')`,
		schemaHint: meta.schemaHint,
		examples: (meta.examples ?? []).map((e) => example(appId, name, e.params))
	}
}

function examples(appId: string, actions: Record<string, ActionMeta>): string[] {
	return Object.entries(actions).flatMap(([name, meta]) =>
		(meta.examples ?? []).map((e) => example(appId, name, e.params))
	)
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

function ok(value: unknown): ExecResult {
	return {
		stdout: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
		stderr: '',
		exitCode: 0
	}
}

function fail(code: string, message: string, extra?: unknown): ExecResult {
	return {
		stdout: '',
		stderr: JSON.stringify({ ok: false, error: { code, message }, ...object(extra) }, null, 2),
		exitCode: 1
	}
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : { usage: value }
}

function help() {
	return {
		usage: 'app <list|launch|close|current|inspect|state|actions|run|help>',
		examples: [
			'app list',
			'app launch com.example.counter',
			'app current',
			'app run increment amount=2',
			'app run --id com.example.counter increment amount=2',
			'app run --id com.example.counter setItems --params-json \'{"items":[{"x":0,"y":0}]}\'',
			'app actions --id com.example.counter'
		],
		params:
			"Scalars pass as key=value (amount=2, tool=pencil, color=#d04648). Arrays/objects MUST go as one JSON object via --params-json '<json>' (single-quoted) — inline key=value is unquoted by the shell, which mangles JSON."
	}
}
