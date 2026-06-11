import Cocoa
import WebKit

// The booter: a dumb window with an OS identity. It holds no app logic and no
// assets — it just opens a WKWebView at its target. In Phase 0 there is no quayd
// yet, so with no target it renders a mock page keyed by its app id.

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
			webView.loadHTMLString(Self.mockHTML(name: name, id: appId), baseURL: nil)
		}

		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
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

	private static func mockHTML(name: String, id: String) -> String {
		"""
		<!doctype html><html><head><meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<style>
		  html,body{height:100%;margin:0;font:14px -apple-system,system-ui,sans-serif;
		    -webkit-user-select:none;user-select:none}
		  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
		    gap:10px;color:#fff;background:linear-gradient(160deg,#0a84ff,#0040a0)}
		  h1{margin:0;font-size:34px;font-weight:700}
		  code{font:12px ui-monospace,monospace;background:rgba(255,255,255,.18);
		    padding:2px 8px;border-radius:6px}
		  small{opacity:.8}
		</style></head><body>
		  <h1>\(name)</h1>
		  <code>\(id)</code>
		  <small>WKWebView · system WebKit · mock (no backend yet)</small>
		</body></html>
		"""
	}
}
