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

public class DocumentScannerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DocumentScanner")

    AsyncFunction("cropToDocument") { (imagePath: String) -> String in
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

      let extent = ciImage.extent

      // Detect the document directly on the final photo rather than
      // reusing corner points from the separate live-preview stream.
      // Guarantees corners and pixels are always in the same coordinate
      // space, no resolution or aspect-ratio mismatch to account for.
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

      let context = CIContext()
      guard let cgImage = context.createCGImage(outputImage, from: outputImage.extent) else {
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
  }
}
