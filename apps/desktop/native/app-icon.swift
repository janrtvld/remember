import AppKit
import Foundation

let iconSize = 64

guard CommandLine.arguments.count == 2 else {
  exit(2)
}

let bundleIdentifier = CommandLine.arguments[1]
guard
  let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier),
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: iconSize,
    pixelsHigh: iconSize,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ),
  let context = NSGraphicsContext(bitmapImageRep: bitmap)
else {
  exit(1)
}

let icon = NSWorkspace.shared.icon(forFile: applicationURL.path)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
icon.draw(in: NSRect(x: 0, y: 0, width: iconSize, height: iconSize))
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  exit(1)
}

FileHandle.standardOutput.write(Data(png.base64EncodedString().utf8))
