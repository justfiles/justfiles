import { defineGUI } from '@justfiles/app/kernel/sdk'
import type { DoomApp } from './app'
import { css } from './style'

const COMMON_ARGS = [
	'-iwad',
	'doom1.wad',
	'-window',
	'-nogui',
	'-nomusic',
	'-config',
	'default.cfg',
	'-servername',
	'doomflare',
	'-nodes',
	'4'
]

type EmscriptenFs = {
	createPreloadedFile(
		parent: string,
		name: string,
		url: string,
		canRead: boolean,
		canWrite: boolean
	): void
}

type DoomModule = {
	FS?: EmscriptenFs
	SDL2?: {
		audioContext?: AudioContext
	}
	canvas: HTMLCanvasElement
	noInitialRun: boolean
	wasmBinary: ArrayBuffer
	onRuntimeInitialized(): void
	preRun(): void
	print(text: string): void
	printErr(text: string): void
	setStatus(text: string): void
	monitorRunDependencies(left: number): void
	totalDependencies: number
}

type DoomWindow = Window &
	typeof globalThis & {
		Module?: DoomModule
		callMain?: (args: string[]) => void
	}

export const gui = defineGUI<DoomApp>({
	mount(root, _state, _ctx) {
		const style = document.createElement('style')
		style.textContent = css
		document.head.append(style)
		root.classList.add('doom-app')
		void mountDoom(root)

		return {
			update() {},
			unmount() {
				style.remove()
				root.classList.remove('doom-app')
				root.replaceChildren()
			}
		}
	}
})

async function mountDoom(root: HTMLElement) {
	const canvas = document.createElement('canvas')
	const start = document.createElement('button')
	const bindings = document.createElement('div')
	const monitor = document.createElement('output')

	canvas.id = 'canvas'
	canvas.className = 'screen'
	canvas.tabIndex = -1
	canvas.addEventListener('contextmenu', (event) => event.preventDefault())

	start.type = 'button'
	start.className = 'start'
	start.disabled = true
	start.textContent = 'Loading'

	bindings.className = 'bindings'
	bindings.textContent =
		'W/S move | A/D strafe | E or Space use | Shift run | Click fire | Mouse turn'

	monitor.className = 'monitor'
	root.replaceChildren(canvas, start, bindings, monitor)

	const setStatus = (text: string) => {
		monitor.value = text
	}

	try {
		const wasmBinary = await fetchBinary(assetUrl('doom.wasm'))

		const win = window as DoomWindow
		win.Module = {
			canvas,
			noInitialRun: true,
			wasmBinary,
			totalDependencies: 0,
			onRuntimeInitialized() {
				start.disabled = false
				start.textContent = 'Start'
				setStatus('ready')
			},
			preRun() {
				const fs = win.Module?.FS
				fs?.createPreloadedFile('', 'doom1.wad', assetUrl('doom1.wad'), true, true)
				fs?.createPreloadedFile('', 'default.cfg', assetUrl('default.cfg'), true, true)
			},
			print(text) {
				console.log(text)
				if (text.includes('doom: 10,')) setStatus('running')
			},
			printErr(text) {
				console.error(text)
				setStatus(text)
			},
			setStatus,
			monitorRunDependencies(left) {
				this.totalDependencies = Math.max(this.totalDependencies, left)
				setStatus(
					left ? `loading ${this.totalDependencies - left}/${this.totalDependencies}` : 'ready'
				)
			}
		}

		start.addEventListener('click', () => {
			start.hidden = true
			canvas.focus()
			void win.Module?.SDL2?.audioContext?.resume()
			setStatus('starting')
			win.callMain?.(COMMON_ARGS)
		})

		await loadRuntime(assetUrl('doom-runtime.js'))
	} catch (error) {
		start.disabled = true
		start.textContent = 'Error'
		setStatus(error instanceof Error ? error.message : String(error))
	}
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`)
	return res.arrayBuffer()
}

function loadRuntime(url: string): Promise<void> {
	const script = document.createElement('script')
	return new Promise((resolve, reject) => {
		script.src = url
		script.onload = () => resolve()
		script.onerror = () => reject(new Error(`failed to load ${url}`))
		document.body.append(script)
	})
}

function assetUrl(path: string): string {
	const base = new URL(import.meta.url)
	const url = new URL(path, base)
	url.search = base.search
	return url.href
}
