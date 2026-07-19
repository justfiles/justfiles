import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createClerkClient } from '@clerk/backend'
import { PROFILE_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
import { apiStorage, createFsClient } from '@justfiles/core'
import { volume } from '@justfiles/fs'
import { chromium } from '@playwright/test'

const DEFAULT_EMAIL = 'llm+clerk_test@example.com'
const DEFAULT_BASE_URL = 'http://localhost:5173'
const DEFAULT_AUTH_STATE = '.auth/frieren-llm.json'
const DEFAULT_SESSION = 'frieren'
const TOKEN_EXPIRES_SECONDS = 60 * 60

const encoder = new TextEncoder()

type BrowserClerk = {
	client?: {
		signIn: {
			create(input: { strategy: 'ticket'; ticket: string }): Promise<{
				status: string
				createdSessionId?: string
			}>
		}
	}
	setActive(input: { session: string }): Promise<void>
}

function log(message: string) {
	console.error(message)
}

async function loadEnvFile(path: string) {
	let text: string
	try {
		text = await readFile(path, 'utf8')
	} catch {
		return
	}
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
		if (!match) continue
		const [, key, rawValue] = match
		if (process.env[key] !== undefined) continue
		process.env[key] = rawValue.replace(/^['"]|['"]$/g, '')
	}
}

async function loadEnv() {
	await loadEnvFile('.env')
	await loadEnvFile('.dev.vars')
	if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY) {
		process.env.CLERK_PUBLISHABLE_KEY = process.env.VITE_CLERK_PUBLISHABLE_KEY
	}
}

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing ${name}. Add it to apps/frieren/.dev.vars or export it.`)
	return value
}

function config() {
	const baseUrl = (process.env.FRIEREN_TEST_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
	return {
		baseUrl,
		email: process.env.FRIEREN_TEST_EMAIL ?? DEFAULT_EMAIL,
		authState: process.env.FRIEREN_TEST_AUTH_STATE ?? DEFAULT_AUTH_STATE,
		session: process.env.FRIEREN_TEST_SESSION ?? DEFAULT_SESSION,
		headless: process.env.FRIEREN_TEST_HEADLESS !== '0'
	}
}

async function ensureTestUser() {
	const client = createClerkClient({ secretKey: requireEnv('CLERK_SECRET_KEY') })
	const { email } = config()
	const existing = await client.users.getUserList({ emailAddress: [email], limit: 1 })
	const user = existing.data.find((candidate) =>
		candidate.emailAddresses.some((entry) => entry.emailAddress === email)
	)
	if (user) return { client, user }

	log(`Creating Clerk test user ${email}`)
	return {
		client,
		user: await client.users.createUser({
			emailAddress: [email],
			firstName: 'LLM',
			lastName: 'Tester',
			skipPasswordRequirement: true,
			skipLegalChecks: true
		})
	}
}

async function createSessionToken(): Promise<string> {
	const { client, user } = await ensureTestUser()
	const session = await client.sessions.createSession({ userId: user.id })
	const token = await client.sessions.getToken(session.id, undefined, TOKEN_EXPIRES_SECONDS)
	return token.jwt
}

async function createAuthedVolume(token: string) {
	const { baseUrl } = config()
	const client = createFsClient({
		baseUrl: `${baseUrl}/fs`,
		headers: { Authorization: `Bearer ${token}` }
	})
	return volume(await apiStorage(client))
}

async function seedOnboarding(token: string) {
	const vol = await createAuthedVolume(token)
	await vol.writeFile(
		PROFILE_PATH,
		encoder.encode(
			[
				'---',
				'schema: frieren/user-profile/v1',
				'name: LLM Tester',
				'birth_date: 1990-01-01',
				'---',
				''
			].join('\n')
		)
	)
	await vol.mkdir('/system/agents/main', { recursive: true })
	await vol.writeFile(
		SOUL_PATH,
		encoder.encode(
			[
				'---',
				'schema: frieren/agent-soul/v1',
				'agent_name: Frieren',
				'archetype: assistant',
				'---',
				'',
				'Frieren is a concise, reliable assistant for local UI verification.',
				''
			].join('\n')
		)
	)
}

async function bootstrapBrowserAuth() {
	const { baseUrl, authState, headless } = config()
	const { client, user } = await ensureTestUser()
	const signInToken = await client.signInTokens.createSignInToken({
		userId: user.id,
		expiresInSeconds: 300
	})

	await mkdir(dirname(resolve(authState)), { recursive: true })
	const browser = await chromium.launch({ headless })
	try {
		const page = await browser.newPage()
		await page.goto(baseUrl)
		await page.waitForFunction('Boolean(window.Clerk?.loaded)', null, { timeout: 30_000 })
		await page.evaluate(async (ticket) => {
			const clerk = (globalThis as typeof globalThis & { Clerk?: BrowserClerk }).Clerk
			if (!clerk?.client) throw new Error('Clerk client is not loaded')
			const signIn = await clerk.client.signIn.create({ strategy: 'ticket', ticket })
			if (signIn.status !== 'complete' || !signIn.createdSessionId) {
				throw new Error(`Sign-in failed: ${signIn.status}`)
			}
			await clerk.setActive({ session: signIn.createdSessionId })
		}, signInToken.token)
		await page.goto(baseUrl)
		await page.waitForFunction('Boolean(window.Clerk?.user)', null, { timeout: 30_000 })
		await page.context().storageState({ path: authState })
		log(`Wrote Playwright auth state to ${authState}`)
	} finally {
		await browser.close()
	}
}

async function run(command: string[]) {
	log(`$ ${command.join(' ')}`)
	const [bin, ...args] = command
	if (!bin) throw new Error('run() called with empty command')
	const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
		const proc = spawn(bin, args, { stdio: 'inherit' })
		proc.on('error', rejectExit)
		proc.on('exit', (code) => resolveExit(code ?? 1))
	})
	if (exitCode !== 0) throw new Error(`${bin} exited with ${exitCode}`)
}

async function openPlaywrightCli() {
	const { baseUrl, authState, session } = config()
	await run(['playwright-cli', `-s=${session}`, 'open', 'about:blank', '--headed', '--persistent'])
	await run(['playwright-cli', `-s=${session}`, 'state-load', authState])
	await run(['playwright-cli', `-s=${session}`, 'goto', baseUrl])
}

async function main() {
	await loadEnv()
	const command = process.argv[2]
	if (!command || command === 'help' || command === '--help') {
		console.log(`Usage: node scripts/frieren-auth.ts <token|seed|bootstrap|ui>

Commands:
  token      Print a fresh Clerk session JWT for the LLM test user.
  seed       Seed /system/user.md and /system/agents/main/soul.md through the local app.
  bootstrap  Create user, seed onboarding, and write Playwright auth state.
  ui         Run bootstrap, then open an authenticated playwright-cli session.

Env overrides:
  FRIEREN_TEST_EMAIL        default ${DEFAULT_EMAIL}
  FRIEREN_TEST_BASE_URL     default ${DEFAULT_BASE_URL}
  FRIEREN_TEST_AUTH_STATE   default ${DEFAULT_AUTH_STATE}
  FRIEREN_TEST_SESSION      default ${DEFAULT_SESSION}
  FRIEREN_TEST_HEADLESS=0   show browser during auth bootstrap
`)
		return
	}

	if (command === 'token') {
		console.log(await createSessionToken())
		return
	}

	if (command === 'seed') {
		await seedOnboarding(await createSessionToken())
		log('Seeded Frieren onboarding files')
		return
	}

	if (command === 'bootstrap') {
		const token = await createSessionToken()
		await seedOnboarding(token)
		await bootstrapBrowserAuth()
		return
	}

	if (command === 'ui') {
		const token = await createSessionToken()
		await seedOnboarding(token)
		await bootstrapBrowserAuth()
		await openPlaywrightCli()
		return
	}

	throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
