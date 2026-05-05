import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { resolveTimezone, today } from './dates.ts'
import { formatSections } from './format.ts'
import { createTaskManager, type TaskManagerOptions } from './index.ts'
import { isValidDue } from './parse.ts'
import { groupTasks } from './query.ts'

const HELP = `Usage: task <command> [options]

Commands:
  add <title>      Add a new TODO task. Stdin (if piped) becomes file content.
                   Options: --due YYYYMMDD
  list             List TODO tasks grouped into overdue/today/upcoming/undated.
  done <id>        Mark a task complete by its ID.

Global options:
  --tz <zone>      IANA timezone (e.g. Pacific/Auckland). Overrides TASKS_TZ.

Environment:
  TASKS_DIR        Directory for tasks (default: ~/tasks)
  TASKS_TZ         Default timezone for date computations
`

function tasksDir(): string {
	const env = process.env.TASKS_DIR
	if (env && env.length > 0) return env
	return `${homedir()}/tasks`
}

function timezoneOption(flag?: string): TaskManagerOptions {
	return { timezone: resolveTimezone({ flag, env: process.env.TASKS_TZ }) }
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return ''
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function cmdAdd(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			due: { type: 'string' },
			tz: { type: 'string' }
		}
	})
	const title = positionals.join(' ').trim()
	if (!title) {
		process.stderr.write('error: task add requires a title\n')
		return 2
	}
	const due = values.due
	if (due !== undefined && !isValidDue(due)) {
		process.stderr.write('error: --due must be YYYYMMDD\n')
		return 2
	}
	const content = await readStdin()
	const manager = await createTaskManager(tasksDir(), timezoneOption(values.tz))
	const task = await manager.addTask(due ? { title, content, due } : { title, content })
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdDone(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { tz: { type: 'string' } }
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task done requires an ID\n')
		return 2
	}
	const manager = await createTaskManager(tasksDir(), timezoneOption(values.tz))
	const task = await manager.completeTask(id)
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdList(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { tz: { type: 'string' } }
	})
	const opts = timezoneOption(values.tz)
	const manager = await createTaskManager(tasksDir(), opts)
	const tasks = (await manager.listTasks()).filter((t) => t.status === 'TODO')
	const sections = groupTasks(tasks, today(manager.timezone))
	process.stdout.write(formatSections(sections))
	return 0
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv
	switch (command) {
		case undefined:
		case '-h':
		case '--help':
			process.stdout.write(HELP)
			return command === undefined ? 1 : 0
		case 'add':
			return cmdAdd(rest)
		case 'done':
			return cmdDone(rest)
		case 'list':
			return cmdList(rest)
		default:
			process.stderr.write(`error: unknown command: ${command}\n${HELP}`)
			return 2
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exit(code)
	},
	(err: unknown) => {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
		process.exit(1)
	}
)
