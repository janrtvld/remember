import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let background = (red: 0x14, green: 0x12, blue: 0x0B)
private let protectedEdgeFraction = 0.095
private let foregroundLuminanceStart = 32.0
private let foregroundLuminanceEnd = 96.0

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write(Data("Usage: swift remove-app-icon-rim.swift <png> [<png> ...]\n".utf8))
  exit(2)
}

func clamp(_ value: Double, minimum: Double = 0, maximum: Double = 1) -> Double {
  min(max(value, minimum), maximum)
}

func processIcon(at url: URL) throws {
  guard
    let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
  else {
    throw CocoaError(.fileReadCorruptFile)
  }

  let width = image.width
  let height = image.height
  let bytesPerRow = width * 4
  var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)

  guard
    let context = CGContext(
      data: &pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    )
  else {
    throw CocoaError(.fileWriteUnknown)
  }

  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

  let protectedInset = Int((Double(min(width, height)) * protectedEdgeFraction).rounded(.up))

  for y in 0..<height {
    for x in 0..<width {
      let offset = y * bytesPerRow + x * 4
      let alpha = Double(pixels[offset + 3])
      guard alpha > 0 else { continue }

      let red = Double(pixels[offset])
      let green = Double(pixels[offset + 1])
      let blue = Double(pixels[offset + 2])
      let unpremultiply = 255.0 / alpha
      let luminance =
        (red * unpremultiply * 0.2126) +
        (green * unpremultiply * 0.7152) +
        (blue * unpremultiply * 0.0722)

      let isInsideProtectedEdge =
        x < protectedInset ||
        y < protectedInset ||
        x >= width - protectedInset ||
        y >= height - protectedInset
      let foregroundMix = isInsideProtectedEdge
        ? 0
        : clamp(
          (luminance - foregroundLuminanceStart) /
            (foregroundLuminanceEnd - foregroundLuminanceStart)
        )

      let baseRed = Double(background.red) * alpha / 255.0
      let baseGreen = Double(background.green) * alpha / 255.0
      let baseBlue = Double(background.blue) * alpha / 255.0

      pixels[offset] = UInt8(clamp(red * foregroundMix + baseRed * (1 - foregroundMix), minimum: 0, maximum: 255).rounded())
      pixels[offset + 1] = UInt8(clamp(green * foregroundMix + baseGreen * (1 - foregroundMix), minimum: 0, maximum: 255).rounded())
      pixels[offset + 2] = UInt8(clamp(blue * foregroundMix + baseBlue * (1 - foregroundMix), minimum: 0, maximum: 255).rounded())
    }
  }

  guard
    let outputImage = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(
      url as CFURL,
      UTType.png.identifier as CFString,
      1,
      nil
    )
  else {
    throw CocoaError(.fileWriteUnknown)
  }

  CGImageDestinationAddImage(destination, outputImage, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw CocoaError(.fileWriteUnknown)
  }
}

for path in CommandLine.arguments.dropFirst() {
  try processIcon(at: URL(fileURLWithPath: path))
}
