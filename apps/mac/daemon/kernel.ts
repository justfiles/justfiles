import { hostname } from 'node:os'
import { aiCapability, SOUL_GENERATION_PROMPT, text } from '@justfiles/agent'
import { BUILTIN_AVATARS } from '@justfiles/agent/avatars'
import { IDENTITY_PATHS } from '@justfiles/agent/defaults'
import { materialise, reconcile } from '@justfiles/app/appstore'
import { CapabilityError, capabilityRegistry } from '@justfiles/app/capabilities'
import {
	accountsCapabilities,
	type SecretCodec,
	sealAccounts
} from '@justfiles/app/capabilities/accounts/host'
import { googleProvider, icloudProvider } from '@justfiles/app/capabilities/accounts/providers'
import { devkitCapability, type Runner } from '@justfiles/app/capabilities/devkit/host'
import { notifyHost } from '@justfiles/app/capabilities/notify/host'
import { settingsHost } from '@justfiles/app/capabilities/settings/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { appBundleFromMemory, type Kernel, kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { builtinStore } from './builtins'
import { chatgptProvider, resolveAgentBackend } from './chatgpt'
import { getVolume } from './fs'
import { googleClient, loopbackAuthFlow } from './google/oauth'
import { identity } from './identity'
import { accountsSecretCodec } from './keychain'
import { notificationChannel } from './notify'
import { sandboxes } from './sandbox'
import { toolchain } from './toolchain'

let kernelOnce: Promise<Kernel> | undefined

const systemAllowlist = ['app.justfiles.frieren.files']

// The daemon's account providers: the shared Google/iCloud modules wired to the
// loopback auth flow + env OAuth client, plus the daemon-local ChatGPT provider
// (which rides pi-ai's Codex runtime).
const accountsProviders = () => [
	googleProvider({ flow: loopbackAuthFlow(), client: googleClient() }),
	icloudProvider(),
	chatgptProvider()
]

export function getKernel(): Promise<Kernel> {
	// The Keychain key lives behind `accountsSecretCodec`, which resolves it on first USE — so
	// boot never touches the Keychain, and a Keychain this daemon cannot read costs the
	// credential lane (A2 lists the record as "re-connect") rather than the whole daemon.
	kernelOnce ??= getVolume().then((fs) => buildKernel(fs, { secretCodec: accountsSecretCodec }))
	return kernelOnce
}

// Build the kernel over a given Volume: the capability registry (volume/devkit/settings/
// email/calendar/ai/notify), the reducer sandbox pool, and the seeded builtin catalog.
// `getKernel` memoises this over the process Volume; tests build a throwaway kernel over a
// temp Volume (so they never touch the real support tree or share the daemon's singleton).
// `secretCodec` seals the accounts store at rest. `getKernel` — the only production caller —
// supplies the real Keychain-backed one; the default stays the pre-A4 clear codec so a test
// that never opts in is hermetic (it mints no Keychain item on the machine running it).
export async function buildKernel(
	fs: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): Promise<Kernel> {
	const { secretCodec } = opts
	// Anything already on disk in the clear (an account connected before the Keychain key
	// existed, or while it was unreadable) gets sealed now: `decode` deliberately passes a
	// non-envelope through unchanged (that's what makes turning encryption on a no-flag-day
	// change), so nothing else would ever rewrite a credential that doesn't rotate — iCloud's
	// app-specific password is written once, at connect, and never again. Best-effort: a boot
	// must succeed even if this fails.
	await sealAccounts(fs, { secretCodec })
	// The text `ai` capability is host-owned (not an accounts concern): it generates
	// over the active AI account's model — resolved lazily per call, so a signed-out
	// user gets CAPABILITY_UNAVAILABLE and a re-sign-in takes effect next call — and
	// composes purpose-scoped context (learning) from the Volume internally.
	const ai = aiCapability({
		volume: fs,
		generate: async ({ system, prompt }) => {
			const backend = await resolveAgentBackend(fs, { secretCodec })
			if (!backend) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai')
			return text(backend).gen(system, prompt)
		}
	})
	const { email, calendar, accounts } = accountsCapabilities(accountsProviders(), fs, {
		// Every account this daemon holds was connected directly on this Mac (D1) — the
		// `device` lane in the "one account, many hosts" design (#296). Labelled by
		// hostname so Settings can tell two Macs apart once E1/E2 land.
		origin: { kind: 'device', label: hostname() },
		secretCodec
	})

	const k = kernel({
		fs,
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
			// The host admin surface, reachable only by the first-party Settings app. No
			// usage meter here (its pane hides itself); `host.user` answers the daemon's own
			// Kodama identity (E1) — null, i.e. "Local user", until someone runs `/sign-in`.
			// `agent.*` is where this Mac finally gets personalization: the identity files are
			// on the native Volume, and the soul generator is the active AI account's model —
			// absent (signed out, or nothing turned on) makes only Rewrite UNAVAILABLE, so the
			// pane still works and you write the soul yourself.
			settings: settingsHost({
				accounts,
				user: () => identity.currentUser(),
				agent: {
					volume: fs,
					paths: IDENTITY_PATHS,
					// This Mac serves its own avatar list, built-ins included — the art is in the
					// daemon's own bundle, so a picker here needs nothing from the cloud.
					builtins: BUILTIN_AVATARS,
					generateSoul: async ({ name, gender, archetype, userAge, userGender }) => {
						const backend = await resolveAgentBackend(fs, { secretCodec })
						if (!backend) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'settings')
						const facts = [`agent name: ${name}`, `agent gender: ${gender}`]
						// Only the summoning has a nature to send — nothing records one.
						if (archetype) facts.push(`archetype: ${archetype}`)
						if (userAge !== undefined) facts.push(`user age: ${userAge}`)
						if (userGender) facts.push(`user gender: ${userGender}`)
						return { body: await text(backend).gen(SOUL_GENERATION_PROMPT, facts.join('\n')) }
					}
				}
			}),
			email,
			calendar,
			ai,
			// Sandboxed apps reach the host's notification channel here; the kernel stamps
			// `source = appId` so a banner routes back to the app that raised it.
			notify: notifyHost(notificationChannel)
		}),
		clock: {}
	})
	const builtins = await builtinStore()
	// Install any missing built-in (first run), then update whatever is installed.
	await materialise(k, builtins)
	await reconcile(k, fs, builtins)
	return k
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
