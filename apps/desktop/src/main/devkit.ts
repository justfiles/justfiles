import { implementCapability } from '@justfiles/app/capabilities'
import { devkit } from '@justfiles/app/capabilities/devkit'
import {
	buildDraft,
	type DraftBuild,
	installDraft,
	packDraft,
	type Toolchain
} from '@justfiles/app/devkit'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Kernel } from '@justfiles/app/runtime'
import { chroot, type Volume } from '@justfiles/fs'
import { build } from 'esbuild'

type Preview = {
	run: (
		ownerAppId: string,
		slug: string,
		draft: DraftBuild,
		reset?: boolean
	) => Promise<{ previewId: string; diagnostics: string[] }>
	stop: (input: { previewId: string }) => Promise<void>
	menu: (input: { previewId: string }) => Promise<[]>
	selectMenu: (input: { previewId: string; menu: number; item: number }) => Promise<void>
}

let runtimePromise: Promise<Record<string, string>> | null = null

export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void,
	preview?: Preview
) {
	return implementCapability(devkit, {
		install: async (ctx, { slug }) =>
			installDraft(fs, ctx.appId, slug, getKernel(), await toolchain(), { onInstalled }),
		pack: async (ctx, { slug }) =>
			packDraft(chroot(fs, `/data/${ctx.appId}`), slug, await toolchain()),
		run: async (ctx, { slug, reset }) => {
			const draft = await buildDraft(chroot(fs, `/data/${ctx.appId}`), slug, await toolchain())
			return preview?.run(ctx.appId, slug, draft, reset) ?? fallbackRun(slug, draft)
		},
		stop: async (_ctx, input) => preview?.stop(input),
		menu: async (_ctx, input) => (preview ? preview.menu(input) : []),
		selectMenu: async (_ctx, input) => preview?.selectMenu(input)
	})
}

function fallbackRun(
	slug: string,
	draft: DraftBuild
): { previewId: string; diagnostics: string[] } {
	return { previewId: `preview.${slug}`, diagnostics: draft.diagnostics }
}

async function toolchain(): Promise<Toolchain> {
	if (!runtimePromise) runtimePromise = buildRuntime()
	return { build, runtime: await runtimePromise }
}
