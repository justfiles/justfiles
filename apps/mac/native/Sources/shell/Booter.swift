import Cocoa
import WebKit

// The booter: a dumb window with an OS identity. It holds no app logic and no
// assets — it ensures daemon is running, then opens a WKWebView at
// http://127.0.0.1:PORT/app/<id>?token=… (Slice 7), where daemon serves the shell +
// the app's real gui.js and a token-scoped Cap'n Web berth. A `--url`/TargetURL
// override is kept for dev; without daemon it shows a placeholder.

final class BooterDelegate: NSObject, NSApplicationDelegate {
	private let appId: String
	private let name: String
	private let target: URL?
	private var window: NSWindow!
	private var webView: WKWebView!
	private var titleObservation: NSKeyValueObservation?
	// The window's downloads sink (also its navigation delegate). WKDownload holds
	// its delegate weakly, so this must live as long as the window.
	private let downloads = Downloads()

	init(appId: String, name: String, target: URL?) {
		self.appId = appId
		self.name = name
		self.target = target
	}

	func applicationDidFinishLaunching(_: Notification) {
		installMenu()

		let rect = NSRect(x: 0, y: 0, width: 1000, height: 700)
		window = NSWindow(
			contentRect: rect,
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		// Remember position + size across launches the native AppKit way: it autosaves
		// the frame to this app's defaults on every move/resize and restores it here.
		// Each mini-app is its own bundle (own CFBundleIdentifier ⟹ own defaults domain),
		// so one constant name never collides between apps. First launch (no saved frame)
		// falls back to a centred default-size window. Restoring before makeKeyAndOrderFront
		// means the early themed blank frame already appears at the remembered geometry.
		let autosaveName: NSWindow.FrameAutosaveName = "mainWindow"
		if !window.setFrameUsingName(autosaveName) { window.center() }
		_ = window.setFrameAutosaveName(autosaveName)
		window.title = name
		// Modern macOS chrome: the titlebar is transparent, not colour-matched. The
		// window backing shows through, and the separator is disabled, so the traffic
		// lights float over the same colour the web content lands on. The title stays
		// visible — it rides the traffic-light row and tracks the page's document.title
		// (see the observer below).
		window.backgroundColor = Self.windowBgColor
		window.titleVisibility = .visible
		window.titlebarAppearsTransparent = true
		window.isMovableByWindowBackground = true
		if #available(macOS 11.0, *) { window.titlebarSeparatorStyle = .none }

		// Show the window now — before the (comparatively heavy) WKWebView init — so a
		// themed blank frame appears as early as possible instead of waiting on WebKit.
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)

		webView = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
		webView.autoresizingMask = [.width, .height]
		// An app that hands the user a file (Draw's "Export image") needs the host to
		// accept the download; without a navigation delegate WebKit drops it silently.
		webView.navigationDelegate = downloads
		// Transparent until the page paints, so the themed window backing shows through
		// the load instead of WebKit's default opaque white.
		webView.setValue(false, forKey: "drawsBackground")
		if #available(macOS 13.3, *) { webView.isInspectable = true } // dev only
		window.contentView = webView

		// Mirror the page's document.title into the native titlebar (shown on the
		// traffic-light row). Apps that set it — e.g. Notes → the open note's filename —
		// surface it here; otherwise the shell's <title> is the reverse-DNS app id, so
		// fall back to the human app name.
		titleObservation = webView.observe(\.title, options: [.initial, .new]) { [weak self] view, _ in
			guard let self else { return }
			let pageTitle = view.title ?? ""
			self.window.title = pageTitle.isEmpty || pageTitle == self.appId ? self.name : pageTitle
		}

		if let target {
			webView.load(URLRequest(url: target))
		} else if let runtime = Daemon.read(), Daemon.alive(runtime) {
			// Warm daemon (the common case): navigate straight to the app URL — no
			// placeholder and no thread hop, so launch is a single navigation rather
			// than a throwaway paint followed by a redirect. read()/alive() are a tiny
			// file read + a kill(pid,0) probe, cheap enough for the main thread.
			webView.load(URLRequest(url: Self.appURL(runtime, appId: appId)))
		} else {
			// Cold: spawn daemon off the main thread, showing a neutral splash meanwhile.
			webView.loadHTMLString(Self.placeholderHTML(note: "Starting…"), baseURL: nil)
			loadFromDaemon()
		}
	}

	// The window backing, following the system appearance so the blank frame matches
	// the design system's `--window-bg` in both modes (#ffffff / #1e1e1e).
	private static let windowBgColor = NSColor(name: "windowBg") { appearance in
		appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
			? NSColor(srgbRed: 30 / 255, green: 30 / 255, blue: 30 / 255, alpha: 1)
			: .white
	}

	// Find-or-spawn daemon off the main thread, then load this app's window. The
	// shared Daemon discovery (Launcher.swift) reads runtime.json and, if it's
	// absent/dead, spawns the daemon — so launching from Spotlight with the launcher
	// closed still works.
	private func loadFromDaemon() {
		DispatchQueue.global().async { [weak self] in
			guard let self else { return }
			let runtime = Daemon.ensure()
			DispatchQueue.main.async {
				guard let runtime else {
					self.webView.loadHTMLString(
						Self.placeholderHTML(note: "daemon unavailable"), baseURL: nil
					)
					return
				}
				self.webView.load(URLRequest(url: Self.appURL(runtime, appId: self.appId)))
			}
		}
	}

	// The localhost shell URL for this app on a running daemon: token-scoped to one app.
	private static func appURL(_ runtime: Daemon.Runtime, appId: String) -> URL {
		var components = URLComponents()
		components.scheme = "http"
		components.host = "127.0.0.1"
		components.port = runtime.port
		components.path = "/app/\(appId)"
		components.queryItems = [URLQueryItem(name: "token", value: runtime.token)]
		return components.url!
	}

	func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }

	// A minimal menu so Cmd+W / Cmd+Q work and quit only this app's process.
	private func installMenu() {
		let main = NSMenu()
		let appItem = NSMenuItem()
		main.addItem(appItem)
		let appMenu = NSMenu()
		appMenu.addItem(
			withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"
		)
		appMenu.addItem(
			withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"
		)
		appItem.submenu = appMenu
		NSApp.mainMenu = main
	}

	// A neutral splash for the cold path (while daemon spawns). The `Canvas`/`GrayText`
	// system colours follow `color-scheme`, so it matches the themed window backing
	// and the app shell that replaces it — a cold launch transitions without a flash.
	private static func placeholderHTML(note: String) -> String {
		"""
		<!doctype html><html><head><meta charset="utf-8">
		<meta name="color-scheme" content="light dark">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
		  html,body{height:100%;margin:0;background:Canvas;color:GrayText;
		    font:13px -apple-system,system-ui,sans-serif;
		    -webkit-user-select:none;user-select:none}
		  body{display:flex;align-items:center;justify-content:center}
		</style></head><body>
		  <small>\(note)</small>
		</body></html>
		"""
	}
}
