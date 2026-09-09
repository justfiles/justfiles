import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import {
	type AgentBackend,
	aiCapability,
	generateSoul,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import { BUILTIN_AVATARS } from '@justfiles/agent/avatars'
import { IDENTITY_DEFAULTS, IDENTITY_PATHS } from '@justfiles/agent/defaults'
import { type HostAccounts, hostAccounts, type SecretCodec } from '@justfiles/app/accounts/host'
import { googleProvider, icloudProvider } from '@justfiles/app/accounts/providers'
import { materialise, reconcile } from '@justfiles/app/appstore'
import { CapabilityError, capabilityRegistry } from '@justfiles/app/capabilities'
import { devkitCapability, type Runner } from '@justfiles/app/capabilities/devkit/host'
import { notifyHost } from '@justfiles/app/capabilities/notify/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { appBundleFromMemory, type Kernel, kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { createSettingsHost } from '@justfiles/ui/settings/host'
import { UPDATE_CHECK_INTERVAL_MS } from '../../shared/justapps'
import { migrateFirstPartyAppIds } from '../../shared/migrate-app-ids'
import { appAssets } from './app-assets'
import { builtinStore } from './builtins'
import { cloudAccounts } from './cloud-accounts'
import { coalesce } from './coalesce'
import { getStorage, getVolume, platformOrigin } from './fs'
import { googleClient, loopbackAuthFlow } from './google/oauth'
import { identity } from './identity'
import { accountsSecretCodec } from './keychain'
import { notificationChannel } from './notify'
import { createPlatformAi } from './platform-ai'
import { sandboxes } from './sandbox'
import { toolchain } from './toolchain'

let kernelOnce: Promise<Kernel> | undefined
let accountsOnce: Promise<DaemonAccounts> | undefined
let appBoot: Promise<void> | undefined
let appCheck: ReturnType<typeof setInterval> | undefined
let kernelClosed = false

const systemAllowlist = ['justfiles.files']

const accountProviders = () => [
	googleProvider({ flow: loopbackAuthFlow(), client: googleClient() }),
	icloudProvider()
]

interface DaemonAccounts extends HostAccounts {
	resolveBackend(): Promise<AgentBackend | null>
}

// One account module over a Volume. `getAccounts` memoises this for the daemon process;
// tests build a throwaway one over a temp Volume. `secretCodec` seals the creds lane at
// rest — the default stays the pre-A4 clear codec, so a test that never opts in is hermetic
// (it mints no Keychain item on the machine running it).
export function daemonAccounts(
	fs: Volume,
	opts: {
		secretCodec?: SecretCodec
		getToken?: () => Promise<string | null>
		origin?: string
	} = {}
): DaemonAccounts {
	const cloud = {
		origin: opts.origin ?? platformOrigin(),
		getToken: opts.getToken ?? (() => identity.getToken())
	}
	const accounts = hostAccounts(accountProviders(), fs, {
		// Every account this daemon holds was connected directly on this Mac (D1) — the
		// `device` lane in the "one account, many hosts" design (#296). Labelled by
		// hostname so Settings can tell two Macs apart once E1/E2 land.
		origin: { kind: 'device', label: hostname() },
		...(opts.secretCodec && { secretCodec: opts.secretCodec })
	})
	return {
		...accounts,
		admin: cloudAccounts(accounts.admin, cloud),
		resolveBackend: createPlatformAi(cloud)
	}
}

// The daemon's ONE account module. Settings, the `ai` capability, soul generation and the
// agent's own backend all resolve through this instance, so a credential write can never
// race a read taken from a second store over the same files.
export function getAccounts(): Promise<DaemonAccounts> {
	// The Keychain key lives behind `accountsSecretCodec`, which resolves it on first USE — so
	// boot never touches the Keychain, and a Keychain this daemon cannot read costs the
	// credential lane (A2 lists the record as "re-connect") rather than the whole daemon.
	accountsOnce ??= getVolume().then((fs) =>
		daemonAccounts(fs, { secretCodec: accountsSecretCodec })
	)
	return accountsOnce
}

let settingsOnce: Promise<ReturnType<typeof createSettingsHost>> | undefined
export function getSettings() {
	settingsOnce ??= Promise.all([getVolume(), getAccounts()]).then(([fs, accounts]) =>
		daemonSettings(fs, accounts)
	)
	return settingsOnce
}

export function daemonSettings(fs: Volume, accounts: DaemonAccounts) {
	return createSettingsHost({
		accounts: accounts.admin,
		openUrl: (url) =>
			new Promise<void>((resolve, reject) =>
				execFile('open', [url], (error) => (error ? reject(error) : resolve()))
			),
		user: () => identity.currentUser(),
		agent: {
			volume: fs,
			paths: IDENTITY_PATHS,
			defaults: IDENTITY_DEFAULTS,
			// This Mac serves its own avatar list, built-ins included — the art is in the
			// daemon's own bundle, so a picker here needs nothing from the cloud.
			builtins: BUILTIN_AVATARS,
			generateSoul: async ({ name, gender, archetype, userAge, userGender }) => {
				const backend = await accounts.resolveBackend()
				if (!backend) throw new Error('SETTINGS_UNAVAILABLE')
				return generateSoul(backend, {
					agentName: name,
					agentGender: gender,
					archetype: archetype as SoulGenerationInput['archetype'],
					userAge,
					userGender
				})
			}
		}
	})
}

export function getKernel(): Promise<Kernel> {
	kernelOnce ??= Promise.all([getStorage(), getAccounts()]).then(async ([storage, accounts]) => {
		const fs = storage.volume
		const k = await makeKernel(fs, accounts)
		const boot = async (): Promise<void> => {
			if (kernelClosed) return
			await bootKernel(k, fs)
			if (kernelClosed) return
			const check = coalesce(() =>
				refreshApps(k, fs, false).catch((error) =>
					console.warn('appstore: update check failed', error)
				)
			)
			appCheck = setInterval(check, UPDATE_CHECK_INTERVAL_MS)
			appCheck.unref()
		}
		if (storage.ownerId === null) await boot()
		else {
			// Existing local apps can run at once. Generated writes wait until the remote tree is here.
			appBoot = storage.firstSync
				.then((synced) => (synced ? boot() : undefined))
				.catch((error) => console.warn('appstore: boot failed', error))
		}
		return k
	})
	return kernelOnce
}

export async function closeKernel(): Promise<void> {
	kernelClosed = true
	if (appCheck) clearInterval(appCheck)
	appCheck = undefined
	await appBoot
	const active = await kernelOnce?.catch(() => undefined)
	active?.dispose()
}

// Build the kernel over a given Volume + that Volume's account module: the capability
// registry (volume/devkit/email/calendar/ai/notify), the reducer sandbox pool, and
// the seeded builtin catalog. `getKernel` memoises this over the process Volume; tests build
// a throwaway kernel over a temp Volume (so they never touch the real support tree or share
// the daemon's singleton).
export async function buildKernel(fs: Volume, accounts: DaemonAccounts): Promise<Kernel> {
	const k = await makeKernel(fs, accounts)
	await bootKernel(k, fs)
	return k
}

async function makeKernel(fs: Volume, accounts: DaemonAccounts): Promise<Kernel> {
	const fetchAsset = await appAssets(fs)
	// The text `ai` capability is host-owned (not an accounts concern): it generates
	// over the active AI account's model — resolved lazily per call, so a signed-out
	// user gets CAPABILITY_UNAVAILABLE and a re-sign-in takes effect next call — and
	// composes purpose-scoped context (learning) from the Volume internally.
	const ai = aiCapability({
		volume: fs,
		generate: async ({ system, prompt }) => {
			const backend = await accounts.resolveBackend()
			if (!backend) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai')
			return text(backend).gen(system, prompt)
		}
	})

	return kernel({
		fs,
		fetchAsset,
		sandbox: sandboxes.get,
		capabilities: capabilityRegistry({
			volume: volumeCapability(fs, { systemAllowlist }),
			devkit: (k) => {
				// Compile + typecheck run in a warm worker thread (see ./toolchain.ts),
				// not on the daemon's event loop — so tsc's multi-second synchronous
				// pass never freezes UI requests or app sockets. The client presents the
				// same `(input, runtime)` / `(input, types, paths)` backend signatures
				// the factory expects, so this is a drop-in for the in-process backends.
				const tc = toolchain()
				return devkitCapability({
					fs,
					kernel: k,
					compile: tc.compile,
					typecheck: tc.typecheck,
					runner: makeRunner(fs, k),
					overwrite: true
				})
			},
			email: accounts.email,
			calendar: accounts.calendar,
			ai,
			// Sandboxed apps reach the host's notification channel here; the kernel stamps
			// `source = appId` so a banner routes back to the app that raised it.
			notify: notifyHost(notificationChannel)
		}),
		clock: {}
	})
}

async function bootKernel(k: Kernel, fs: Volume): Promise<void> {
	await migrateFirstPartyAppIds(fs)
	await refreshApps(k, fs, true)
}

async function refreshApps(k: Kernel, fs: Volume, installMissing: boolean): Promise<void> {
	const store = await builtinStore()
	if (installMissing) await materialise(k, store)
	await reconcile(k, fs, store)
}

function makeRunner(fs: Volume, kernel: Kernel): Runner {
	return {
		mount: async (draft, { previewId, reset }) => {
			// ⟳ Run/Restart: wipe persisted draft state for a clean boot.
			if (reset) await fs.rm(`/state/${previewId}.json`, { force: true })
			await kernel.install(
				appBundleFromMemory({
					id: previewId,
					name: draft.manifest.name,
					app: draft.app,
					gui: draft.gui
				})
			)
			return { kind: 'url', src: `/app/${encodeURIComponent(previewId)}` }
		},
		stop: async ({ previewId }) => {
			await kernel.uninstall(previewId).catch(() => {})
		}
	}
}
