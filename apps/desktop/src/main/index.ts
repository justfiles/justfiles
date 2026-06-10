import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { reconcileBuiltins } from '@justfiles/app/builtins'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { type Kernel, kernel } from '@justfiles/app/runtime'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { app, BrowserWindow, globalShortcut, ipcMain, protocol, screen, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { createDesktopAgent, type DesktopAgent } from './agent'
import { desktopBuiltinCatalog, readDesktopBuiltin } from './builtins'
import { nodeSandbox } from './nodeSandbox'

const LAUNCHER_WIDTH = 600

protocol.registerSchemesAsPrivileged([
	{
		scheme: 'app',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
	}
])

let launcherWin: BrowserWindow | null = null
let focusedAppId: string | null = null
const appWindows = new Map<number, { appId: string; win: BrowserWindow }>()
const agentWindows = new Set<BrowserWindow>()
let hostPromise: Promise<{ fs: Volume; kernel: Kernel; agent: DesktopAgent }> | null = null

async function getHost(): Promise<{ fs: Volume; kernel: Kernel; agent: DesktopAgent }> {
	if (!hostPromise) {
		hostPromise = (async () => {
			const root = join(app.getPath('userData'), 'volume')
			await mkdir(root, { recursive: true })
			const fs = volume(await nativeStorage(root))
			const capabilities = capabilityRegistry({
				volume: volumeCapability(fs, { systemAllowlist: ['app.frieren.finder'] })
			})
			const k = kernel({ fs, sandbox: nodeSandbox(), capabilities, clock: {} })
			k.subscribe((event) => {
				if (event.type !== 'app.update') return
				for (const { appId, win } of appWindows.values()) {
					if (appId === event.appId) win.webContents.send('app.update', event.appId, event.state)
				}
			})
			await reconcileBuiltins(k, fs, desktopBuiltinCatalog, readDesktopBuiltin)
			const entries = await fs.readdir('/')
			const apps = await k.list()
			console.info(`Volume root: ${root}`)
			console.info(`Volume /: ${entries.map((entry) => entry.name).join(', ') || '(empty)'}`)
			console.info(`Kernel apps: ${apps.map((entry) => entry.id).join(', ') || '(none)'}`)
			const agent = await createDesktopAgent(fs, k, {
				openApp: openAppWindow,
				closeApp: closeAppWindow,
				currentAppId: () => focusedAppId
			})
			return { fs, kernel: k, agent }
		})()
	}
	return hostPromise
}

function createLauncher(): BrowserWindow {
	const win = new BrowserWindow({
		width: LAUNCHER_WIDTH,
		height: 64,
		useContentSize: true,
		show: false,
		frame: false,
		transparent: true,
		vibrancy: 'under-window',
		visualEffectState: 'active',
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		roundedCorners: true,
		// macOS nonactivating NSPanel: takes keystrokes without activating our
		// agent, so summoning shows on the *current* Space instead of yanking
		// focus to the launcher's home Space (Sol/Raycast/Spotlight behaviour).
		...(process.platform === 'darwin' ? { type: 'panel' } : {}),
		...(process.platform === 'linux' ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		}
	})

	win.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url)
		return { action: 'deny' }
	})

	// Sol-style panel behaviour: dismiss the moment it loses focus or on Escape
	// (Spotlight UX). Cross-Space visibility is (re-)applied in showLauncher.
	win.on('blur', () => {
		if (!win.webContents.isDevToolsOpened()) win.hide()
	})
	win.webContents.on('before-input-event', (_e, input) => {
		if (input.key === 'Escape') win.hide()
	})

	// HMR for renderer based on electron-vite cli.
	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL)
	} else {
		win.loadFile(join(__dirname, '../renderer/index.html'))
	}

	return win
}

// Center the launcher on the display under the cursor, biased toward the top
// third (Spotlight/Raycast placement), then reveal it.
function showLauncher(): void {
	if (!launcherWin) launcherWin = createLauncher()
	const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
	const [w, h] = launcherWin.getSize()
	launcherWin.setPosition(
		Math.round(workArea.x + (workArea.width - w) / 2),
		Math.round(workArea.y + (workArea.height - h) / 3)
	)
	// Re-stamp collectionBehavior on every show: macOS drops it after some
	// Space/display transitions, which otherwise pins the panel to one Space and
	// yanks focus back to it on summon (electron#8734).
	launcherWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	// show() makes the nonactivating panel key (renderer autofocuses its input on
	// the DOM focus event) WITHOUT calling focus(): focus() runs
	// activateIgnoringOtherApps, which activates the whole app and yanks macOS to
	// the Space of the app's frontmost ordinary window — the actual Space jump.
	launcherWin.show()
}

function toggleLauncher(): void {
	if (launcherWin?.isVisible()) {
		launcherWin.hide()
	} else {
		showLauncher()
	}
}

// Open a chosen app in its own normal window. Closing it doesn't affect the
// launcher or other app windows. The renderer branches on ?app=<name>.
async function openAppWindow(id: string): Promise<void> {
	const { kernel } = await getHost()
	const installed = await kernel.app(id)
	const name = installed.manifest.name
	const win = new BrowserWindow({
		width: 800,
		height: 600,
		title: name,
		show: false,
		...(process.platform === 'linux' ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		}
	})

	const webContentsId = win.webContents.id
	appWindows.set(webContentsId, { appId: id, win })
	win.on('focus', () => {
		focusedAppId = id
	})
	win.on('closed', () => {
		appWindows.delete(webContentsId)
		if (focusedAppId === id) focusedAppId = null
	})
	win.on('ready-to-show', () => win.show())

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?appId=${encodeURIComponent(id)}`)
	} else {
		win.loadFile(join(__dirname, '../renderer/index.html'), { query: { appId: id } })
	}
}

function closeAppWindow(id?: string): void {
	for (const { appId, win } of appWindows.values()) {
		if (id ? appId === id : win.isFocused() || appId === focusedAppId) win.close()
	}
}

function openAgentWindow(): void {
	const win = new BrowserWindow({
		width: 460,
		height: 640,
		title: 'Agent',
		show: false,
		...(process.platform === 'linux' ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		}
	})
	agentWindows.add(win)
	win.on('closed', () => agentWindows.delete(win))
	win.on('ready-to-show', () => win.show())

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?agent=1`)
	} else {
		win.loadFile(join(__dirname, '../renderer/index.html'), { query: { agent: '1' } })
	}
}

function notifyAgentWindows(): void {
	for (const win of agentWindows) win.webContents.send('agent:changed')
}

function registerAppProtocol(): void {
	protocol.handle('app', async (request) => {
		try {
			const url = new URL(request.url)
			if (url.host === 'shared') return moduleResponse(sharedModule(url.pathname))
			const { kernel } = await getHost()
			const installed = await kernel.app(url.host)
			const path = url.pathname.slice(1)
			const bytes = await installed.read(path)
			const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			return new Response(body as ArrayBuffer, { headers: headersFor(path) })
		} catch (error) {
			return new Response(String(error), { status: 404 })
		}
	})
}

function moduleResponse(source: string): Response {
	return new Response(source, { headers: headersFor('module.js') })
}

function headersFor(path: string): Record<string, string> {
	return {
		'content-type': contentType(path),
		'access-control-allow-origin': '*'
	}
}

function contentType(path: string): string {
	if (path.endsWith('.js')) return 'text/javascript'
	if (path.endsWith('.json')) return 'application/json'
	if (path.endsWith('.svg')) return 'image/svg+xml'
	if (path.endsWith('.css')) return 'text/css'
	if (path.endsWith('.wasm')) return 'application/wasm'
	if (path.endsWith('.png')) return 'image/png'
	return 'application/octet-stream'
}

function sharedModule(path: string): string {
	if (path === '/react-dom-client.js') {
		return `const m = window.__desktopShared.reactDomClient; export const createRoot = m.createRoot; export const hydrateRoot = m.hydrateRoot; export default m`
	}
	if (path === '/react-jsx-runtime.js') {
		return `const m = window.__desktopShared.jsxRuntime; export const jsx = m.jsx; export const jsxs = m.jsxs; export const Fragment = m.Fragment`
	}
	if (path === '/react-jsx-dev-runtime.js') {
		return `const m = window.__desktopShared.jsxRuntime; export const jsxDEV = m.jsx; export const Fragment = m.Fragment`
	}
	return `const m = window.__desktopShared.react;
export default m;
export const Children = m.Children, Component = m.Component, Fragment = m.Fragment, Profiler = m.Profiler, PureComponent = m.PureComponent, StrictMode = m.StrictMode, Suspense = m.Suspense;
export const cloneElement = m.cloneElement, createContext = m.createContext, createElement = m.createElement, createRef = m.createRef, forwardRef = m.forwardRef, isValidElement = m.isValidElement, lazy = m.lazy, memo = m.memo, startTransition = m.startTransition;
export const useActionState = m.useActionState, useCallback = m.useCallback, useContext = m.useContext, useDebugValue = m.useDebugValue, useDeferredValue = m.useDeferredValue, useEffect = m.useEffect, useId = m.useId, useImperativeHandle = m.useImperativeHandle, useInsertionEffect = m.useInsertionEffect, useLayoutEffect = m.useLayoutEffect, useMemo = m.useMemo, useOptimistic = m.useOptimistic, useReducer = m.useReducer, useRef = m.useRef, useState = m.useState, useSyncExternalStore = m.useSyncExternalStore, useTransition = m.useTransition;`
}

app.whenReady().then(async () => {
	electronApp.setAppUserModelId('com.electron')
	await getHost()
	registerAppProtocol()

	// Run as a background agent: no Dock icon, no window on launch.
	app.dock?.hide()

	app.on('browser-window-created', (_, window) => {
		optimizer.watchWindowShortcuts(window)
	})

	ipcMain.on('launcher:open-app', (_e, id: string) => {
		void openAppWindow(id)
		// Dismiss the launcher once an app is chosen, like Spotlight.
		launcherWin?.hide()
	})

	ipcMain.on('launcher:open-agent', () => {
		openAgentWindow()
		launcherWin?.hide()
	})

	ipcMain.handle('kernel:list', async () => {
		const { kernel } = await getHost()
		return kernel.list()
	})

	ipcMain.handle('kernel:state', async (_e, id: string) => {
		const { kernel } = await getHost()
		return kernel.state(id)
	})

	ipcMain.handle('kernel:dispatch', async (_e, id: string, message: unknown) => {
		const { kernel } = await getHost()
		return kernel.dispatch(id, message as never)
	})

	ipcMain.handle('kernel:ls', async (_e, path = '/') => {
		const { fs } = await getHost()
		return fs.readdir(path)
	})

	ipcMain.handle('agent:history', async () => {
		const { agent } = await getHost()
		return agent.history()
	})

	ipcMain.handle('agent:prompt', async (_e, input: string) => {
		const { agent } = await getHost()
		const answer = await agent.prompt(input)
		notifyAgentWindows()
		return answer
	})

	ipcMain.handle('agent:abort', async () => {
		const { agent } = await getHost()
		await agent.abort()
		notifyAgentWindows()
	})

	// The renderer reports its content height so the window fits like Raycast.
	ipcMain.on('launcher:resize', (e, height: number) => {
		if (!launcherWin || e.sender !== launcherWin.webContents) return
		launcherWin.setContentSize(LAUNCHER_WIDTH, Math.max(1, Math.ceil(height)))
	})

	if (!globalShortcut.register('Alt+Space', toggleLauncher)) {
		console.warn('Failed to register Alt+Space global shortcut')
	}

	// Keep the launcher visible while iterating in dev.
	if (!app.isPackaged) showLauncher()
})

app.on('will-quit', () => {
	globalShortcut.unregisterAll()
})

// No quit on window-all-closed: the launcher only hides, and the agent must
// keep running with no windows open so the hotkey can summon it again.
