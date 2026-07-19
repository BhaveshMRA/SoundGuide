# SoundGuide

An iOS app that helps blind and low-vision users capture clean photos of paper documents using real-time audio guidance, then reads the content aloud.

## Why this exists

Most camera-based assistive apps only tell a blind user whether a photo worked *after* it's taken, often as a binary "don't know" response when recognition fails. That leaves the user guessing how to fix the framing. SoundGuide instead gives continuous audio feedback while the camera is pointed at a document, guiding the user to align all four corners before capturing, then automatically crops, extracts the text, and reads it back.

## Status

Phase 1 in progress. Camera feed and permission handling are built and running on a physical device.

## Roadmap

**Phase 1: Detect and auto-capture, store it**
- [x] Camera feed setup with permission handling
- [ ] Real-time document edge detection
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
