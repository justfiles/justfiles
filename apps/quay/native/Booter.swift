import Cocoa
import WebKit

// The booter: a dumb window with an OS identity. It holds no app logic and no
// assets — it ensures quayd is running, then opens a WKWebView at
// http://127.0.0.1:PORT/app/<id>?token=… (Slice 7), where quayd serves the shell +
// the app's real gui.js and a token-scoped Cap'n Web berth. A `--url`/QuayTargetURL
// override is kept for dev; without quayd it shows a placeholder.

final class BooterDelegate: NSObject, NSApplicationDelegate {
	private let appId: String
	private let name: String
	private let target: URL?
	private var window: NSWindow!
	private var webView: WKWebView!

	init(appId: String, name: String, target: URL?) {
		self.appId = appId
		self.name = name
		self.target = target
	}

	func applicationDidFinishLaunching(_: Notification) {
		installMenu()

		let rect = NSRect(x: 0, y: 0, width: 480, height: 360)
		window = NSWindow(
			contentRect: rect,
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		window.center()
		window.title = name
		// Match the system theme: the design system carries both palettes now, so the
		// window backing is the app's content colour in either mode. Setting it to the
		// exact --window-bg (not the slightly-off system window grey) means the blank
		// pre-paint frame is the same colour the web content lands on — no flash.
		window.backgroundColor = Self.windowBgColor

		// Show the window now — before the (comparatively heavy) WKWebView init — so a
		// themed blank frame appears as early as possible instead of waiting on WebKit.
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)

		webView = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
		webView.autoresizingMask = [.width, .height]
		// Transparent until the page paints, so the themed window backing shows through
		// the load instead of WebKit's default opaque white.
		webView.setValue(false, forKey: "drawsBackground")
		if #available(macOS 13.3, *) { webView.isInspectable = true } // dev only
		window.contentView = webView

		if let target {
			webView.load(URLRequest(url: target))
		} else if let runtime = Quayd.read(), Quayd.alive(runtime) {
			// Warm daemon (the common case): navigate straight to the app URL — no
			// placeholder and no thread hop, so launch is a single navigation rather
			// than a throwaway paint followed by a redirect. read()/alive() are a tiny
			// file read + a kill(pid,0) probe, cheap enough for the main thread.
			webView.load(URLRequest(url: Self.appURL(runtime, appId: appId)))
		} else {
			// Cold: spawn quayd off the main thread, showing a neutral splash meanwhile.
			webView.loadHTMLString(Self.placeholderHTML(note: "Starting…"), baseURL: nil)
			loadFromDaemon()
		}
	}

	// The window backing, following the system appearance so the blank frame matches
	// the design system's `--window-bg` in both modes (#ffffff / #1e1e1e).
	private static let windowBgColor = NSColor(name: "quayWindowBg") { appearance in
		appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
			? NSColor(srgbRed: 30 / 255, green: 30 / 255, blue: 30 / 255, alpha: 1)
			: .white
	}

	// Find-or-spawn quayd off the main thread, then load this app's window. The
	// shared Quayd discovery (Launcher.swift) reads runtime.json and, if it's
	// absent/dead, spawns the daemon — so launching from Spotlight with the launcher
	// closed still works.
	private func loadFromDaemon() {
		DispatchQueue.global().async { [weak self] in
			guard let self else { return }
			let runtime = Quayd.ensure()
			DispatchQueue.main.async {
				guard let runtime else {
					self.webView.loadHTMLString(
						Self.placeholderHTML(note: "quayd unavailable"), baseURL: nil
					)
					return
				}
				self.webView.load(URLRequest(url: Self.appURL(runtime, appId: self.appId)))
			}
		}
	}

	// The localhost shell URL for this app on a running daemon: token-scoped to one app.
	private static func appURL(_ runtime: Quayd.Runtime, appId: String) -> URL {
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

	// A neutral splash for the cold path (while quayd spawns). The `Canvas`/`GrayText`
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
