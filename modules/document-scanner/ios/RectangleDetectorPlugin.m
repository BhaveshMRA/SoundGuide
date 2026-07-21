#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/Frame.h>
#import <Vision/Vision.h>

static CGImagePropertyOrientation CGImagePropertyOrientationFromUIImageOrientation(UIImageOrientation orientation) {
  switch (orientation) {
    case UIImageOrientationUp: return kCGImagePropertyOrientationUp;
    case UIImageOrientationDown: return kCGImagePropertyOrientationDown;
    case UIImageOrientationLeft: return kCGImagePropertyOrientationLeft;
    case UIImageOrientationRight: return kCGImagePropertyOrientationRight;
    case UIImageOrientationUpMirrored: return kCGImagePropertyOrientationUpMirrored;
    case UIImageOrientationDownMirrored: return kCGImagePropertyOrientationDownMirrored;
    case UIImageOrientationLeftMirrored: return kCGImagePropertyOrientationLeftMirrored;
    case UIImageOrientationRightMirrored: return kCGImagePropertyOrientationRightMirrored;
    default: return kCGImagePropertyOrientationUp;
  }
}

@interface RectangleDetectorPlugin : FrameProcessorPlugin
@end

@implementation RectangleDetectorPlugin

- (instancetype) initWithProxy:(VisionCameraProxyHolder*)proxy withOptions:(NSDictionary* _Nullable)options {
  self = [super initWithProxy:proxy withOptions:options];
  return self;
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary*)arguments {
  CMSampleBufferRef buffer = frame.buffer;
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(buffer);
  if (pixelBuffer == nil) {
    return [NSNull null];
  }

  CGImagePropertyOrientation cgOrientation = CGImagePropertyOrientationFromUIImageOrientation(frame.orientation);

  __block NSDictionary *result = nil;

  VNDetectRectanglesRequest *request = [[VNDetectRectanglesRequest alloc] initWithCompletionHandler:^(VNRequest * _Nonnull req, NSError * _Nullable error) {
    NSArray<VNRectangleObservation *> *observations = (NSArray<VNRectangleObservation *> *)req.results;
    if (observations.count == 0) {
      return;
    }

    // Multiple candidates can appear (e.g. a notebook sitting on a laptop
    // lid). Prefer whichever one is closest to the center of the frame,
    // since that's where we guide the user to hold the actual document.
    VNRectangleObservation *best = observations.firstObject;
    CGFloat bestDistance = CGFLOAT_MAX;
    for (VNRectangleObservation *observation in observations) {
      CGFloat centerX = (observation.topLeft.x + observation.topRight.x + observation.bottomLeft.x + observation.bottomRight.x) / 4.0;
      CGFloat centerY = (observation.topLeft.y + observation.topRight.y + observation.bottomLeft.y + observation.bottomRight.y) / 4.0;
      CGFloat distance = hypot(centerX - 0.5, centerY - 0.5);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = observation;
      }
    }

    result = @{
      @"topLeft": @{@"x": @(best.topLeft.x), @"y": @(best.topLeft.y)},
      @"topRight": @{@"x": @(best.topRight.x), @"y": @(best.topRight.y)},
      @"bottomLeft": @{@"x": @(best.bottomLeft.x), @"y": @(best.bottomLeft.y)},
      @"bottomRight": @{@"x": @(best.bottomRight.x), @"y": @(best.bottomRight.y)},
      @"confidence": @(best.confidence)
    };
  }];
  request.maximumObservations = 5;
  request.minimumConfidence = 0.7;
  request.minimumAspectRatio = 0.3;

  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:pixelBuffer orientation:cgOrientation options:@{}];
  NSError *error = nil;
  [handler performRequests:@[request] error:&error];

  return result ?: [NSNull null];
}

VISION_EXPORT_FRAME_PROCESSOR(RectangleDetectorPlugin, detectRectangle)

@end
