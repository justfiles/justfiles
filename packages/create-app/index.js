#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const appVersion = manifest.devDependencies['@justfiles/app']
const args = process.argv.slice(2)
let force = false
let help = false
let targetArg
let template = 'vanilla'

for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	if (arg === '--force') force = true
	else if (arg === '--help' || arg === '-h') help = true
	else if (arg === '--template') template = args[++i]
	else if (arg.startsWith('--template=')) template = arg.slice('--template='.length)
	else if (arg.startsWith('-')) exit(`Unknown option: ${arg}`)
	else if (targetArg) exit(`Unexpected argument: ${arg}`)
	else targetArg = arg
}

if (help) {
	console.log('Usage: create-app [directory] [--template vanilla|react] [--force]')
	process.exit(0)
}

if (template !== 'vanilla' && template !== 'react') {
	exit(`Unknown template: ${template ?? '(missing)'}. Choose vanilla or react.`)
}

const templateDir = path.join(packageDir, 'templates', template)
const targetDir = path.resolve(process.cwd(), targetArg ?? 'justfiles-app')

if (fs.existsSync(targetDir) && !isEmpty(targetDir)) {
	if (!force) {
		console.error(`Target directory is not empty: ${targetDir}`)
		console.error('Pass --force to overwrite it.')
		process.exit(1)
	}
	emptyDir(targetDir)
}

fs.mkdirSync(targetDir, { recursive: true })
copyDir(templateDir, targetDir)
patchPackageJson(targetDir)

const rel = path.relative(process.cwd(), targetDir) || '.'
const pm = packageManager()
console.log(`Created ${rel}`)
console.log('')
console.log('Next:')
if (rel !== '.') console.log(`  cd ${quote(rel)}`)
console.log(`  ${pm} install`)
console.log(`  ${runCommand(pm, 'dev')}`)

function patchPackageJson(dir) {
	const file = path.join(dir, 'package.json')
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
	pkg.name = toPackageName(path.basename(dir))
	pkg.dependencies['@justfiles/app'] = appVersion
	fs.writeFileSync(file, `${JSON.stringify(pkg, null, '\t')}\n`)
}

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true })
	for (const name of fs.readdirSync(src)) {
		const from = path.join(src, name)
		const to = path.join(dest, name === '_gitignore' ? '.gitignore' : name)
		const stat = fs.statSync(from)
		if (stat.isDirectory()) copyDir(from, to)
		else fs.copyFileSync(from, to)
	}
}

function emptyDir(dir) {
	for (const name of fs.readdirSync(dir)) {
		fs.rmSync(path.join(dir, name), { recursive: true, force: true })
	}
}

function isEmpty(dir) {
	return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0
}

function toPackageName(name) {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/^[._]/, '')
		.replace(/[^a-z\d\-~]+/g, '-')
}

function quote(value) {
	return value.includes(' ') ? JSON.stringify(value) : value
}

function packageManager() {
	if (process.versions.bun) return 'bun'
	const agent = process.env.npm_config_user_agent?.split('/')[0]
	if (agent === 'pnpm' || agent === 'bun' || agent === 'yarn' || agent === 'npm') return agent
	return 'pnpm'
}

function runCommand(pm, script) {
	if (pm === 'npm') return `npm run ${script}`
	return `${pm} ${script}`
}

function exit(message) {
	console.error(message)
	process.exit(1)
}
