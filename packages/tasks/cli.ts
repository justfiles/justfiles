import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { formatMarkdown } from './format.ts'
import { createTaskManager } from './index.ts'

const HELP = `Usage: task <command> [options]

Commands:
  add <title>      Add a new TODO task. Stdin (if piped) becomes file content.
  list             List TODO tasks as a markdown bullet list.

Environment:
  TASKS_DIR        Directory for tasks (default: ~/tasks)
`

function tasksDir(): string {
	const env = process.env.TASKS_DIR
	if (env && env.length > 0) return env
	return `${homedir()}/tasks`
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
	const { positionals } = parseArgs({ args, allowPositionals: true })
	const title = positionals.join(' ').trim()
	if (!title) {
		process.stderr.write('error: task add requires a title\n')
		return 2
	}
	const content = await readStdin()
	const manager = await createTaskManager(tasksDir())
	const task = await manager.addTask({ title, content })
	process.stdout.write(`${task.id}\n`)
	return 0
}

async function cmdList(_args: string[]): Promise<number> {
	const manager = await createTaskManager(tasksDir())
	const tasks = (await manager.listTasks()).filter((t) => t.status === 'TODO')
	process.stdout.write(formatMarkdown(tasks))
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
