import ExpoModulesCore
import CoreImage
import Vision
import UIKit

enum DocumentScannerError: Error {
  case imageLoadFailed
  case documentNotFound
  case filterUnavailable
  case cropFailed
  case encodeFailed
}

func loadOrientedImage(from imagePath: String) throws -> CIImage {
  let cleanPath = imagePath.replacingOccurrences(of: "file://", with: "")
  let url = URL(fileURLWithPath: cleanPath)

  guard let rawImage = CIImage(contentsOf: url) else {
    throw DocumentScannerError.imageLoadFailed
  }

  var ciImage = rawImage
  if let orientationNumber = rawImage.properties[kCGImagePropertyOrientation as String] as? NSNumber,
     let orientation = CGImagePropertyOrientation(rawValue: orientationNumber.uint32Value) {
    ciImage = rawImage.oriented(orientation)
  }
  return ciImage
}

func saveJpeg(from ciImage: CIImage) throws -> String {
  let context = CIContext()
  guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
    throw DocumentScannerError.cropFailed
  }
  let uiImage = UIImage(cgImage: cgImage)
  guard let jpegData = uiImage.jpegData(compressionQuality: 0.92) else {
    throw DocumentScannerError.encodeFailed
  }
  let outputURL = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString)
    .appendingPathExtension("jpg")
  try jpegData.write(to: outputURL)
  return outputURL.absoluteString
}

public class DocumentScannerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DocumentScanner")

    AsyncFunction("cropToDocument") { (imagePath: String) -> String in
      // loadOrientedImage already applies the correct rotation based on
      // the file's real EXIF orientation tag (confirmed via debugImageInfo:
      // consistently tag 6, i.e. "rotate right", a completely standard
      // value). Detection below runs on this already-correctly-oriented
      // image, so the corner points it returns are already correct too.
      // No further rotation belongs anywhere after this.
      let ciImage = try loadOrientedImage(from: imagePath)
      let extent = ciImage.extent

      var observation: VNRectangleObservation?
      let request = VNDetectRectanglesRequest { req, _ in
        observation = (req.results as? [VNRectangleObservation])?.first
      }
      request.maximumObservations = 5
      request.minimumConfidence = 0.7
      request.minimumAspectRatio = 0.3

      let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
      try? handler.perform([request])

      guard let doc = observation else {
        throw DocumentScannerError.documentNotFound
      }

      let topLeft = CGPoint(x: doc.topLeft.x * extent.width, y: doc.topLeft.y * extent.height)
      let topRight = CGPoint(x: doc.topRight.x * extent.width, y: doc.topRight.y * extent.height)
      let bottomLeft = CGPoint(x: doc.bottomLeft.x * extent.width, y: doc.bottomLeft.y * extent.height)
      let bottomRight = CGPoint(x: doc.bottomRight.x * extent.width, y: doc.bottomRight.y * extent.height)

      guard let filter = CIFilter(name: "CIPerspectiveCorrection") else {
        throw DocumentScannerError.filterUnavailable
      }
      filter.setValue(ciImage, forKey: kCIInputImageKey)
      filter.setValue(CIVector(cgPoint: topLeft), forKey: "inputTopLeft")
      filter.setValue(CIVector(cgPoint: topRight), forKey: "inputTopRight")
      filter.setValue(CIVector(cgPoint: bottomLeft), forKey: "inputBottomLeft")
      filter.setValue(CIVector(cgPoint: bottomRight), forKey: "inputBottomRight")

      guard let outputImage = filter.outputImage else {
        throw DocumentScannerError.cropFailed
      }

      return try saveJpeg(from: outputImage)
    }

    AsyncFunction("correctOrientation") { (imagePath: String) -> String in
      let ciImage = try loadOrientedImage(from: imagePath)
      return try saveJpeg(from: ciImage)
    }

    AsyncFunction("debugImageInfo") { (imagePath: String) -> String in
      let cleanPath = imagePath.replacingOccurrences(of: "file://", with: "")
      let url = URL(fileURLWithPath: cleanPath)
      guard let rawImage = CIImage(contentsOf: url) else {
        return "failed to load image at all"
      }
      let orientationValue = rawImage.properties[kCGImagePropertyOrientation as String]
      let extent = rawImage.extent
      return "orientationTag=\(String(describing: orientationValue)) rawWidth=\(extent.width) rawHeight=\(extent.height)"
    }
  }
}
