import AppKit

// Render an app icon PNG. If a source image is supplied, fit it into the square;
// otherwise draw the legacy rounded letter fallback.
// usage: makeicon <size> <out.png> [letter] [source-image]

let args = CommandLine.arguments
guard args.count >= 3, let size = Int(args[1]) else { exit(2) }
let out = args[2]
let letter = String((args.count > 3 ? args[3] : "Q").uppercased().prefix(1))
let source = args.count > 4 ? image(at: args[4]) : nil

let rep = NSBitmapImageRep(
	bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
	bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
	colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let s = CGFloat(size)
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: s, height: s).fill()
if let source {
	NSGraphicsContext.current?.imageInterpolation = .high
	draw(image: source, size: s)
} else {
	drawGlyph(letter, size: s)
}
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: out))

func image(at path: String) -> NSImage? {
	guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
	return NSImage(data: data)
}

func draw(image: NSImage, size s: CGFloat) {
	let natural = image.size.width > 0 && image.size.height > 0
		? image.size
		: NSSize(width: s, height: s)
	let scale = min(s / natural.width, s / natural.height)
	let w = natural.width * scale
	let h = natural.height * scale
	let rect = NSRect(x: (s - w) / 2, y: (s - h) / 2, width: w, height: h)
	image.draw(in: rect, from: NSRect(origin: .zero, size: natural), operation: .sourceOver, fraction: 1)
}

func drawGlyph(_ letter: String, size s: CGFloat) {
	let hue = CGFloat((letter.unicodeScalars.first?.value ?? 81) % 12) / 12.0
	let bg = NSColor(calibratedHue: hue, saturation: 0.62, brightness: 0.96, alpha: 1)
	bg.setFill()
	NSBezierPath(
		roundedRect: NSRect(x: 0, y: 0, width: s, height: s),
		xRadius: s * 0.22,
		yRadius: s * 0.22
	).fill()
	let str = letter as NSString
	let attrs: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: s * 0.58, weight: .bold),
		.foregroundColor: NSColor.white
	]
	let sz = str.size(withAttributes: attrs)
	str.draw(at: NSPoint(x: (s - sz.width) / 2, y: (s - sz.height) / 2), withAttributes: attrs)
}
