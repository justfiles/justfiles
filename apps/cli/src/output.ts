export function out(msg: string) {
	process.stdout.write(msg + '\n')
}

export function info(msg: string, quiet: boolean) {
	if (!quiet) process.stderr.write(msg + '\n')
}

export function printError(msg: string, usage?: string) {
	process.stderr.write(`Error: ${msg}\n`)
	if (usage) process.stderr.write(`\n${usage}\n`)
}

export function printJson(data: unknown) {
	process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export function printJsonError(data: { error: string; code: string; usage?: string }) {
	printJson(data)
}

export async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return ''
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
		chunks.push(chunk)
	}
	return Buffer.concat(chunks).toString('utf8')
}

export function writeBytes(data: Uint8Array) {
	process.stdout.write(Buffer.from(data))
}
