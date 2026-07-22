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
	const params = parseParams(tokens)
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
		if (token === '--params-json') return JSON.parse(tokens[++i] ?? '{}') as Record<string, unknown>
		const eq = token.indexOf('=')
		if (eq < 1) throw new Error(`expected key=value, got: ${token}`)
		out[token.slice(0, eq)] = parseValue(token.slice(eq + 1))
	}
	return out
}

function parseValue(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
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
		usage: `app run --id ${appId} ${name} key=value ...`,
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
	const args = Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
	return ['app run --id', appId, action, ...args].join(' ')
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
			'app actions --id com.example.counter'
		]
	}
}
