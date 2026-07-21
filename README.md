# SoundGuide

An iOS app that helps blind and low-vision users capture clean photos of paper documents using real-time audio guidance, then reads the content aloud.

## Why this exists

Most camera-based assistive apps only tell a blind user whether a photo worked *after* it's taken, often as a binary "don't know" response when recognition fails. That leaves the user guessing how to fix the framing. SoundGuide instead gives continuous audio feedback while the camera is pointed at a document, guiding the user to align all four corners before capturing, then automatically crops, extracts the text, and reads it back.

## Status

Phase 1 in progress. Camera feed and permission handling are built and running on a physical device.

## Roadmap

**Phase 1: Detect and auto-capture, store it**
- [x] Camera feed setup with permission handling
- [x] Real-time document edge detection
- [ ] Stability check across frames
- [ ] Auto-capture trigger
- [ ] Perspective crop to border-to-border
- [ ] Local storage of captured images

**Phase 2: OCR and reasoning**
- [ ] Gemini Vision integration for text extraction
- [ ] On-screen output for validation, no audio yet

**Phase 3: Audio guidance**
- [ ] Real-time alignment cues (move, tilt, hold steady)
- [ ] Text-to-speech readout of extracted content

## Tech stack

- Expo (custom dev client)
- TypeScript / React Native
- expo-camera
- react-native-rectangle-scanner (planned, for live corner detection)
- Gemini Vision API (planned, for OCR and reasoning)
- expo-speech (planned, for audio guidance and readout)

## Getting started

### Prerequisites

- macOS with Xcode installed
- Node.js and npm
- A physical iPhone (camera preview does not work in the simulator)

### Installation

git clone https://github.com/BhaveshMRA/SoundGuide.git
cd SoundGuide
npm install
npx expo prebuild
npx expo run:ios --device

On first install, iOS will show an "Untrusted Developer" prompt. Go to Settings > General > VPN & Device Management, trust the developer profile, then relaunch the app from the home screen.

## Project structure

SoundGuide/
  components/
    CameraScreen.tsx
  App.tsx
  app.json

## License

See LICENSE.

## Update: switched camera libraries

Moved from \`react-native-rectangle-scanner\` (archived, hit unresolved native build errors even after clean rebuilds) to \`react-native-vision-camera@4\`, which is actively maintained and gives frame-level access needed for real-time audio guidance. Basic camera preview confirmed working on device. Next: a custom native frame processor plugin (Swift, VNDetectRectangleObservation) built as a local Expo Module so it survives \`expo prebuild --clean\`.

## Update: accurate real-time edge tracking confirmed

Fixed a camera sensor orientation mismatch — the raw pixel buffer VisionCamera provides is landscape regardless of phone orientation, and the native plugin wasn't telling Vision framework about the actual portrait orientation, causing skewed results (three correct corners, one wildly off). Fixed by passing `frame.orientation` through to `VNImageRequestHandler`. Confirmed accurate quadrilateral tracking on angled documents, matching real edges including perspective skew, using a live SVG polygon overlay rather than an axis-aligned bounding box.

## Design finding: hand occlusion breaks corner-based detection

Testing surfaced a fundamental gap between our test methodology (document flat on a table, fully unoccluded) and realistic usage (a blind user holding the document in one hand while holding the phone in the other). VNDetectRectanglesRequest requires all four corners to be visible to register a candidate at all, not degraded accuracy but zero detection, so any hand occlusion of a corner means the document simply isn't found. This is a structural limitation of corner-based quadrilateral detection, not something parameter tuning resolves. Needs further investigation: whether guiding users toward a minimal-contact grip (pinching one corner/edge) is sufficient, or whether hand-held scanning needs a fundamentally different detection approach (e.g. tolerant of partial occlusion, or guided propping against a surface) as a distinct design requirement for Phase 3 audio guidance.

## Design finding: hand occlusion breaks corner-based detection

Testing surfaced a fundamental gap between our test methodology (document flat on a table, fully unoccluded) and realistic usage (a blind user holding the document in one hand while holding the phone in the other). VNDetectRectanglesRequest requires all four corners to be visible to register a candidate at all, not degraded accuracy but zero detection, so any hand occlusion of a corner means the document simply isn't found. This is a structural limitation of corner-based quadrilateral detection, not something parameter tuning resolves. Needs further investigation: whether guiding users toward a minimal-contact grip (pinching one corner/edge) is sufficient, or whether hand-held scanning needs a fundamentally different detection approach (e.g. tolerant of partial occlusion, or guided propping against a surface) as a distinct design requirement for Phase 3 audio guidance.

## Scope decision: hand-held detection deferred

Decided to accept the corner-occlusion limitation for now rather than pursue an alternate detection strategy. Phase 1 detection assumes the document is fully visible with all four corners unoccluded, meaning propped against a surface (book, wall, table edge) or laid flat, not held entirely by hand. This should carry through into Phase 3 audio guidance design: initial instructions should guide the user to prop or lay down the document rather than assume hand-held framing. Revisit if propped-only use proves too limiting in practice; a text-region-based detection approach (not requiring a closed quadrilateral) was identified as a possible future direction if full hand-held support becomes a requirement.
