import { implementCapability } from '@justfiles/app/capabilities'
import { devkit } from '@justfiles/app/capabilities/devkit'
import { buildDraft, installDraft, packDraft, type Toolchain } from '@justfiles/app/devkit'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Kernel } from '@justfiles/app/runtime'
import { chroot, type Volume } from '@justfiles/fs'
import { build } from 'esbuild'

let runtimePromise: Promise<Record<string, string>> | null = null

export function devkitCapability(fs: Volume, getKernel: () => Kernel, onInstalled: () => void) {
	return implementCapability(devkit, {
		install: async (ctx, { slug }) =>
			installDraft(fs, ctx.appId, slug, getKernel(), await toolchain(), { onInstalled }),
		pack: async (ctx, { slug }) =>
			packDraft(chroot(fs, `/data/${ctx.appId}`), slug, await toolchain()),
		run: async (ctx, { slug }) => {
			const draft = await buildDraft(chroot(fs, `/data/${ctx.appId}`), slug, await toolchain())
			return { previewId: `${ctx.appId}:${slug}`, diagnostics: draft.diagnostics }
		},
		stop: async () => {},
		menu: async () => [],
		selectMenu: async () => {}
	})
}

async function toolchain(): Promise<Toolchain> {
	if (!runtimePromise) runtimePromise = buildRuntime()
	return { build, runtime: await runtimePromise }
}
