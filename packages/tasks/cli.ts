import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { parseDueInput, resolveTimezone, today } from './dates.ts'
import { formatIds, formatJson, formatSections } from './format.ts'
import { createTaskManager, findLocalTasksDir, type TaskManagerOptions } from './index.ts'
import { isValidDue } from './parse.ts'

import { filterTasks, groupTasks, SECTION_ORDER } from './query.ts'

const HELP = `Usage: task <command> [options]

Commands:
  add <title>      Add a new TODO task. Stdin (if piped) becomes file content.
                   Options: --due YYYYMMDD, --tag <name> (repeatable), --priority 1|2|3
  list             List tasks grouped into overdue/today/upcoming/undated.
                   Options: --tag <name> (repeatable, AND), --priority 1|2|3, --due YYYYMMDD, --status <status>, --json, --ids
  done <id>        Mark a task complete by its ID.
  delete <id>      Delete a task by its ID.
  snooze <id>      Change a task due date. Options: --due YYYYMMDD
  edit <id>        Open task content in $EDITOR.
  set <id>         Mutate task metadata. Options: --status, --due, --title, --tag, --priority
  show <id>        Print parsed metadata and file content.

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

function taskPath(taskDir: string, path: string): string {
	return `${taskDir.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function scopedDir(local?: boolean): Promise<string> {
	if (!local) return tasksDir()
	const dir = await findLocalTasksDir(process.cwd())
	if (!dir) throw new Error('no local tasks/ directory found (walked up to git root or home)')
	return dir
}

async function managerFor(local: boolean | undefined, opts: TaskManagerOptions) {
	return createTaskManager(await scopedDir(local), opts)
}

async function cmdAdd(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			due: { type: 'string' },
			tag: { type: 'string', multiple: true },
			priority: { type: 'string' },
			tz: { type: 'string' },
			local: { type: 'boolean' }
		}
	})
	const title = positionals.join(' ').trim()
	if (!title) {
		process.stderr.write('error: task add requires a title\n')
		return 2
	}
	const tz = resolveTimezone({ flag: values.tz, env: process.env.TASKS_TZ })
	let due: string | undefined
	if (values.due !== undefined) {
		try {
			due = parseDueInput(values.due, tz)
		} catch (e) {
			process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`)
			return 2
		}
	}
	const priority = parsePriority(values.priority)
	if (values.priority !== undefined && priority === undefined) {
		process.stderr.write('error: --priority must be 1, 2, or 3\n')
		return 2
	}
	const tags = values.tag ?? []
	const content = await readStdin()
	const manager = await managerFor(values.local, timezoneOption(values.tz))
	const task = await manager.addTask({
		title,
		content,
		...(due ? { due } : {}),
		tags,
		...(priority ? { priority } : {})
	})
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdDelete(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { tz: { type: 'string' }, local: { type: 'boolean' } }
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task delete requires an ID\n')
		return 2
	}
	const manager = await managerFor(values.local, timezoneOption(values.tz))
	await manager.deleteTask(id)
	process.stdout.write(`${id}\n`)
	return 0
}

async function cmdDone(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { tz: { type: 'string' }, local: { type: 'boolean' } }
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task done requires an ID\n')
		return 2
	}
	const manager = await managerFor(values.local, timezoneOption(values.tz))
	const task = await manager.completeTask(id)
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdSnooze(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { due: { type: 'string' }, tz: { type: 'string' }, local: { type: 'boolean' } }
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task snooze requires an ID\n')
		return 2
	}
	if (!values.due) {
		process.stderr.write('error: task snooze requires --due\n')
		return 2
	}
	const tz = resolveTimezone({ flag: values.tz, env: process.env.TASKS_TZ })
	let due: string
	try {
		due = parseDueInput(values.due, tz)
	} catch (e) {
		process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`)
		return 2
	}
	const manager = await managerFor(values.local, timezoneOption(values.tz))
	const task = await manager.setTask(id, { due })
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdEdit(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { tz: { type: 'string' }, local: { type: 'boolean' } }
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task edit requires an ID\n')
		return 2
	}
	const editor = process.env.EDITOR
	if (!editor) {
		process.stderr.write('error: EDITOR is not set\n')
		return 2
	}
	const dir = await scopedDir(values.local)
	const manager = await createTaskManager(dir, timezoneOption(values.tz))
	const task = await manager.getTask(id)
	if (!task) throw new Error(`task not found: ${id}`)
	const result = spawnSync(editor, [taskPath(dir, task.path)], { stdio: 'inherit' })
	return result.status ?? 1
}

async function cmdSet(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			status: { type: 'string' },
			due: { type: 'string' },
			title: { type: 'string' },
			tag: { type: 'string', multiple: true },
			priority: { type: 'string' },
			tz: { type: 'string' },
			local: { type: 'boolean' }
		}
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task set requires an ID\n')
		return 2
	}
	const priority = parsePriority(values.priority)
	if (values.priority !== undefined && values.priority !== '' && priority === undefined) {
		process.stderr.write('error: --priority must be 1, 2, or 3\n')
		return 2
	}
	const tz = resolveTimezone({ flag: values.tz, env: process.env.TASKS_TZ })
	let parsedDue: string | undefined
	if (values.due !== undefined && values.due !== '') {
		try {
			parsedDue = parseDueInput(values.due, tz)
		} catch (e) {
			process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`)
			return 2
		}
	}
	if (values.status === '' || values.title === '') {
		process.stderr.write('error: --status and --title cannot be empty\n')
		return 2
	}
	const manager = await managerFor(values.local, timezoneOption(values.tz))
	const task = await manager.setTask(id, {
		...(values.status !== undefined ? { status: values.status } : {}),
		...(values.due !== undefined ? { due: values.due === '' ? null : parsedDue } : {}),
		...(values.title !== undefined ? { title: values.title } : {}),
		...(values.tag !== undefined ? { tags: values.tag } : {}),
		...(values.priority !== undefined ? { priority: values.priority === '' ? null : priority } : {})
	})
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdShow(args: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { tz: { type: 'string' }, local: { type: 'boolean' } }
	})
	const id = positionals[0]?.trim()
	if (!id) {
		process.stderr.write('error: task show requires an ID\n')
		return 2
	}
	const manager = await managerFor(values.local, timezoneOption(values.tz))
	const task = await manager.getTask(id)
	if (!task) throw new Error(`task not found: ${id}`)
	const content = await manager.getTaskContent(id)
	process.stdout.write(`${JSON.stringify(task, null, 2)}\n\n${content}`)
	return 0
}

async function cmdList(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			tz: { type: 'string' },
			tag: { type: 'string', multiple: true },
			priority: { type: 'string' },
			due: { type: 'string' },
			status: { type: 'string' },
			json: { type: 'boolean' },
			ids: { type: 'boolean' },
			local: { type: 'boolean' },
			all: { type: 'boolean' }
		}
	})
	if (values.json && values.ids) {
		process.stderr.write('error: --json and --ids cannot be combined\n')
		return 2
	}
	if (values.local && values.all) {
		process.stderr.write('error: --local and --all cannot be combined\n')
		return 2
	}
	if (values.due !== undefined && !isValidDue(values.due)) {
		process.stderr.write('error: --due must be YYYYMMDD\n')
		return 2
	}
	const opts = timezoneOption(values.tz)
	const manager = await managerFor(values.local, opts)
	const priority = parsePriority(values.priority)
	if (values.priority !== undefined && priority === undefined) {
		process.stderr.write('error: --priority must be 1, 2, or 3\n')
		return 2
	}
	const tags = values.tag ?? []
	let tasks = await manager.listTasks()
	if (values.all) {
		const globalDir = tasksDir()
		const localDir = await findLocalTasksDir(process.cwd())
		const global = await (await createTaskManager(globalDir, opts)).listTasks()
		const local = localDir ? await (await createTaskManager(localDir, opts)).listTasks() : []
		tasks = [
			...global.map((task) => ({
				...task,
				path: taskPath(globalDir, task.path),
				source: 'global'
			})),
			...local.map((task) => ({
				...task,
				path: taskPath(localDir ?? '', task.path),
				source: localDir?.split('/').slice(-2, -1)[0] ?? 'local'
			}))
		]
	}
	tasks = filterTasks(tasks, {
		...(tags.length > 0 ? { tags } : {}),
		...(priority ? { priority } : {}),
		...(values.due ? { due: values.due } : {}),
		...(values.status ? { status: values.status } : { status: 'TODO' })
	})
	const sections = groupTasks(tasks, today(manager.timezone))
	const ordered = SECTION_ORDER.flatMap((section) => sections[section])
	if (values.json) process.stdout.write(formatJson(ordered))
	else if (values.ids) process.stdout.write(formatIds(ordered))
	else process.stdout.write(formatSections(sections))
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
		case 'delete':
			return cmdDelete(rest)
		case 'done':
			return cmdDone(rest)
		case 'edit':
			return cmdEdit(rest)
		case 'list':
			return cmdList(rest)
		case 'set':
			return cmdSet(rest)
		case 'show':
			return cmdShow(rest)
		case 'snooze':
			return cmdSnooze(rest)
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
