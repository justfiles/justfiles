import AppKit
import WebKit

// Downloads for an app window.
//
// WKWebView drops a download unless the host asks for it: a `<a download>` click
// (Draw's "Export image") arrives as a navigation with `shouldPerformDownload`,
// and a response WebKit cannot render arrives as a navigation response. Both must
// be answered with `.download`, and the resulting WKDownload needs a delegate to
// name a destination — with none of that, the click does nothing at all.
//
// One instance per window, owned by the booter: WKDownload holds its delegate
// weakly, so the sink must outlive every download it services.
final class Downloads: NSObject, WKNavigationDelegate, WKDownloadDelegate {
	// `<a download>` and `window.location` on a blob/data URL: WebKit has already
	// decided this navigation is a download, so honour it. Everything else loads.
	func webView(
		_: WKWebView,
		decidePolicyFor navigationAction: WKNavigationAction,
		preferences: WKWebpagePreferences,
		decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
	) {
		decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow, preferences)
	}

	// A response WebKit cannot display (an attachment, an unknown MIME type) is a
	// download rather than a blank window.
	func webView(
		_: WKWebView,
		decidePolicyFor navigationResponse: WKNavigationResponse,
		decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
	) {
		decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
	}

	func webView(_: WKWebView, navigationAction _: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(
		_: WKWebView, navigationResponse _: WKNavigationResponse, didBecome download: WKDownload
	) {
		download.delegate = self
	}

	// Where the bytes land. WebKit refuses a destination that already exists, so a
	// second export of the same drawing becomes `name-2.png` rather than a silent
	// failure. `~/Downloads` is where a mac user looks for a file a window gave them.
	func download(
		_: WKDownload,
		decideDestinationUsing _: URLResponse,
		suggestedFilename: String,
		completionHandler: @escaping (URL?) -> Void
	) {
		completionHandler(Self.freeURL(in: Self.downloadsDirectory, named: suggestedFilename))
	}

	// Bounce the Dock and select the file in Finder — the same "it arrived" signal a
	// browser gives, without a UI of our own.
	func downloadDidFinish(_ download: WKDownload) {
		guard let url = download.progress.fileURL else { return }
		NSWorkspace.shared.activateFileViewerSelecting([url])
	}

	private static var downloadsDirectory: URL {
		FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
			?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
	}

	// `name.png` → `name-2.png` → `name-3.png`, the first one that is free.
	private static func freeURL(in directory: URL, named filename: String) -> URL {
		let name = filename.isEmpty ? "download" : filename
		let first = directory.appendingPathComponent(name)
		if !FileManager.default.fileExists(atPath: first.path) { return first }
		let base = first.deletingPathExtension().lastPathComponent
		let ext = first.pathExtension
		for n in 2... {
			var candidate = directory.appendingPathComponent("\(base)-\(n)")
			if !ext.isEmpty { candidate.appendPathExtension(ext) }
			if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
		}
		return first
	}
}
