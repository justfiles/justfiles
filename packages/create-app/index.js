#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const force = args.includes('--force')
const help = args.includes('--help') || args.includes('-h')
const targetArg = args.find((arg) => !arg.startsWith('-')) ?? 'justbuddy-app'

if (help) {
	console.log('Usage: create-app [directory] [--force]')
	process.exit(0)
}

const templateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template')
const targetDir = path.resolve(process.cwd(), targetArg)

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
	if (agent === 'pnpm' || agent === 'bun' || agent === 'yarn') return agent
	return 'npm'
}

function runCommand(pm, script) {
	if (pm === 'npm') return `npm run ${script}`
	return `${pm} ${script}`
}
