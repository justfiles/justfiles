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

		webView = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
		webView.autoresizingMask = [.width, .height]
		if #available(macOS 13.3, *) { webView.isInspectable = true } // dev only
		window.contentView = webView

		if let target {
			webView.load(URLRequest(url: target))
		} else {
			webView.loadHTMLString(Self.placeholderHTML(name: name, note: "Connecting…"), baseURL: nil)
			loadFromDaemon()
		}

		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
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
						Self.placeholderHTML(name: self.name, note: "quayd unavailable"), baseURL: nil
					)
					return
				}
				var components = URLComponents()
				components.scheme = "http"
				components.host = "127.0.0.1"
				components.port = runtime.port
				components.path = "/app/\(self.appId)"
				components.queryItems = [URLQueryItem(name: "token", value: runtime.token)]
				if let url = components.url { self.webView.load(URLRequest(url: url)) }
			}
		}
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

	private static func placeholderHTML(name: String, note: String) -> String {
		"""
		<!doctype html><html><head><meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
		  html,body{height:100%;margin:0;font:14px -apple-system,system-ui,sans-serif;
		    -webkit-user-select:none;user-select:none}
		  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
		    gap:10px;color:#fff;background:linear-gradient(160deg,#0a84ff,#0040a0)}
		  h1{margin:0;font-size:34px;font-weight:700}
		  small{opacity:.8}
		</style></head><body>
		  <h1>\(name)</h1>
		  <small>\(note)</small>
		</body></html>
		"""
	}
}
