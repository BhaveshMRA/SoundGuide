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
    VNRectangleObservation *observation = req.results.firstObject;
    if (observation != nil) {
      result = @{
        @"topLeft": @{@"x": @(observation.topLeft.x), @"y": @(observation.topLeft.y)},
        @"topRight": @{@"x": @(observation.topRight.x), @"y": @(observation.topRight.y)},
        @"bottomLeft": @{@"x": @(observation.bottomLeft.x), @"y": @(observation.bottomLeft.y)},
        @"bottomRight": @{@"x": @(observation.bottomRight.x), @"y": @(observation.bottomRight.y)},
        @"confidence": @(observation.confidence)
      };
    }
  }];
  request.maximumObservations = 1;
  request.minimumConfidence = 0.7;
  request.minimumAspectRatio = 0.3;

  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:pixelBuffer orientation:cgOrientation options:@{}];
  NSError *error = nil;
  [handler performRequests:@[request] error:&error];

  return result ?: [NSNull null];
}

VISION_EXPORT_FRAME_PROCESSOR(RectangleDetectorPlugin, detectRectangle)

@end
