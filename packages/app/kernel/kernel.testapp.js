export function greet(params, context) {
	console.log({ context })
	return `hello, ${params.name}`
}
