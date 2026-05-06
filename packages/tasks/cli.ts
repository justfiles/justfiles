import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { resolveTimezone, today } from './dates.ts'
import { formatSections } from './format.ts'
import { createTaskManager, type TaskManagerOptions } from './index.ts'
import { isValidDue } from './parse.ts'
import { filterTasks, groupTasks } from './query.ts'

const HELP = `Usage: task <command> [options]

Commands:
  add <title>      Add a new TODO task. Stdin (if piped) becomes file content.
                   Options: --due YYYYMMDD, --tag <name> (repeatable), --priority 1|2|3
  list             List TODO tasks grouped into overdue/today/upcoming/undated.
                   Options: --tag <name> (repeatable, AND), --priority 1|2|3
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

function parsePriority(val: string | undefined): 1 | 2 | 3 | undefined {
	if (val === '1') return 1
	if (val === '2') return 2
	if (val === '3') return 3
	return undefined
}

async function cmdAdd(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			due: { type: 'string' },
			tag: { type: 'string', multiple: true },
			priority: { type: 'string' },
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
	const priority = parsePriority(values.priority)
	if (values.priority !== undefined && priority === undefined) {
		process.stderr.write('error: --priority must be 1, 2, or 3\n')
		return 2
	}
	const tags = values.tag ?? []
	const content = await readStdin()
	const manager = await createTaskManager(tasksDir(), timezoneOption(values.tz))
	const task = await manager.addTask({ title, content, ...(due ? { due } : {}), tags, ...(priority ? { priority } : {}) })
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
		options: {
			tz: { type: 'string' },
			tag: { type: 'string', multiple: true },
			priority: { type: 'string' }
		}
	})
	const opts = timezoneOption(values.tz)
	const manager = await createTaskManager(tasksDir(), opts)
	const priority = parsePriority(values.priority)
	const tags = values.tag ?? []
	let tasks = (await manager.listTasks()).filter((t) => t.status === 'TODO')
	tasks = filterTasks(tasks, { ...(tags.length > 0 ? { tags } : {}), ...(priority ? { priority } : {}) })
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
