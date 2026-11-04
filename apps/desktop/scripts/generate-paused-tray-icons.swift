import AppKit
import ImageIO
import UniformTypeIdentifiers

let desktopDirectory = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
let resourcesDirectory = desktopDirectory
  .appendingPathComponent("resources")
let logoURL = desktopDirectory
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .appendingPathComponent("logo.svg")

func makeContext(scale: Int) -> CGContext {
  let width = 16 * scale
  let height = 16 * scale
  guard
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
  else {
    fatalError("Could not create icon context")
  }
  context.interpolationQuality = .high
  return context
}

func writePNG(_ image: CGImage, to destinationURL: URL, scale: Int) throws {
  guard
    let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, UTType.png.identifier as CFString, 1, nil)
  else {
    fatalError("Could not create \(destinationURL.path)")
  }

  let dpi = scale == 1 ? 72 : 144
  let properties: CFDictionary = [
    kCGImagePropertyDPIWidth: dpi,
    kCGImagePropertyDPIHeight: dpi,
  ] as CFDictionary
  CGImageDestinationAddImage(destination, image, properties)
  guard CGImageDestinationFinalize(destination) else {
    fatalError("Could not write \(destinationURL.path)")
  }
}

func generateTemplateIcon(scale: Int) throws {
  let suffix = scale == 1 ? "" : "@2x"
  let destinationURL = resourcesDirectory.appendingPathComponent("trayTemplate\(suffix).png")
  guard
    let source = NSImage(contentsOf: logoURL),
    let sourceImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else {
    fatalError("Could not load \(logoURL.path)")
  }

  let context = makeContext(scale: scale)
  let fullBounds = CGRect(x: 0, y: 0, width: 16 * scale, height: 16 * scale)
  context.draw(sourceImage, in: fullBounds)
  guard let templateImage = context.makeImage() else {
    fatalError("Could not render \(destinationURL.path)")
  }
  try writePNG(templateImage, to: destinationURL, scale: scale)
}

func generatePausedIcon(scale: Int) throws {
  let suffix = scale == 1 ? "" : "@2x"
  let sourceURL = resourcesDirectory.appendingPathComponent("trayTemplate\(suffix).png")
  let destinationURL = resourcesDirectory.appendingPathComponent("trayPausedTemplate\(suffix).png")
  guard
    let source = NSImage(contentsOf: sourceURL),
    let sourceImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else {
    fatalError("Could not load \(sourceURL.path)")
  }

  let context = makeContext(scale: scale)

  let fullBounds = CGRect(x: 0, y: 0, width: 16 * scale, height: 16 * scale)
  context.draw(sourceImage, in: fullBounds)

  let badgeClearance = CGRect(x: 7 * scale, y: 0, width: 9 * scale, height: 9 * scale)
  let badge = CGRect(x: 8 * scale, y: 1 * scale, width: 7 * scale, height: 7 * scale)
  context.setBlendMode(.clear)
  context.fillEllipse(in: badgeClearance)
  context.setBlendMode(.normal)
  context.setFillColor(NSColor.black.cgColor)
  context.fillEllipse(in: badge)

  context.setBlendMode(.clear)
  context.fill(CGRect(x: 10 * scale, y: 3 * scale, width: scale, height: 3 * scale))
  context.fill(CGRect(x: 12 * scale, y: 3 * scale, width: scale, height: 3 * scale))

  guard let pausedImage = context.makeImage() else {
    fatalError("Could not create \(destinationURL.path)")
  }
  try writePNG(pausedImage, to: destinationURL, scale: scale)
}

try generateTemplateIcon(scale: 1)
try generateTemplateIcon(scale: 2)
try generatePausedIcon(scale: 1)
try generatePausedIcon(scale: 2)
