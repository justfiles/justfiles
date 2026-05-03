export class ParseError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ParseError'
	}
}

export function parse(input: string): string[] {
	const argv: string[] = []
	let token = ''
	let inToken = false
	let quote: '"' | "'" | null = null

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		if (quote) {
			if (ch === quote) {
				quote = null
			} else {
				token += ch
			}
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			inToken = true
			continue
		}
		if (ch === ' ' || ch === '\t' || ch === '\n') {
			if (inToken) {
				argv.push(token)
				token = ''
				inToken = false
			}
			continue
		}
		token += ch
		inToken = true
	}

	if (quote) throw new ParseError(`unterminated ${quote === '"' ? 'double' : 'single'} quote`)
	if (inToken) argv.push(token)
	return argv
}
