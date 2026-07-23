import { useEffect, useRef, useState } from 'react';
import { Button, Image, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import Svg, { Polygon } from 'react-native-svg';
import DocumentScannerModule from '../modules/document-scanner/src/DocumentScannerModule';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('detectRectangle');

const HISTORY_SIZE = 5;
const STABILITY_THRESHOLD = 0.035;
const MISS_TOLERANCE = 3;
const MIN_AREA = 0.15;
const MAX_CROP_RETRIES = 3;

type Corner = { x: number; y: number };
type Rectangle = {
  topLeft: Corner;
  topRight: Corner;
  bottomLeft: Corner;
  bottomRight: Corner;
  confidence: number;
};
type DetectedRectangle = Rectangle | null;

function quadArea(r: Rectangle): number {
  const pts = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft];
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const { x: x1, y: y1 } = pts[i];
    const { x: x2, y: y2 } = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function isStable(history: Rectangle[]): boolean {
  if (history.length < HISTORY_SIZE) return false;
  const corners: (keyof Rectangle)[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  for (const corner of corners) {
    const xs = history.map((r) => (r[corner] as Corner).x);
    const ys = history.map((r) => (r[corner] as Corner).y);
    const xRange = Math.max(...xs) - Math.min(...xs);
    const yRange = Math.max(...ys) - Math.min(...ys);
    if (xRange > STABILITY_THRESHOLD || yRange > STABILITY_THRESHOLD) {
      return false;
    }
  }
  return true;
}

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const cameraRef = useRef<Camera>(null);
  const [rectangle, setRectangle] = useState<DetectedRectangle>(null);
  const [stable, setStable] = useState(false);
  const [capturedPath, setCapturedPath] = useState<string | null>(null);
  const [cropFailed, setCropFailed] = useState(false);
  const historyRef = useRef<Rectangle[]>([]);
  const missCountRef = useRef(0);
  const capturingRef = useRef(false);
  const retryCountRef = useRef(0);

  const updateRectangle = Worklets.createRunOnJS((result: DetectedRectangle) => {
    const validResult = result != null && quadArea(result) >= MIN_AREA ? result : null;

    if (validResult == null) {
      missCountRef.current += 1;
      if (missCountRef.current > MISS_TOLERANCE) {
        setRectangle(null);
        historyRef.current = [];
        setStable(false);
      }
      return;
    }
    missCountRef.current = 0;
    setRectangle(validResult);
    historyRef.current = [...historyRef.current, validResult].slice(-HISTORY_SIZE);
    setStable(isStable(historyRef.current));
  });

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (plugin == null) return;
    const result = plugin.call(frame);
    updateRectangle(result);
  }, []);

  const startNewScan = () => {
    historyRef.current = [];
    missCountRef.current = 0;
    capturingRef.current = false;
    retryCountRef.current = 0;
    setRectangle(null);
    setStable(false);
    setCapturedPath(null);
    setCropFailed(false);
  };

  useEffect(() => {
    if (!stable || capturingRef.current || capturedPath != null || rectangle == null) return;
    capturingRef.current = true;
    cameraRef.current
      ?.takePhoto({ flash: 'off' })
      .then(async (photo) => {
        const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
        try {
          const croppedUri = await DocumentScannerModule.cropToDocument(uri);
          retryCountRef.current = 0;
          setCapturedPath(croppedUri);
        } catch (cropError) {
          retryCountRef.current += 1;
          console.log(`crop error, attempt ${retryCountRef.current} of ${MAX_CROP_RETRIES}`, cropError);

          if (retryCountRef.current <= MAX_CROP_RETRIES) {
            // Quietly retry: reset detection state so the live camera
            // re-detects and re-triggers capture on its own, rather than
            // showing the user a raw, uncropped photo they can't
            // meaningfully evaluate anyway.
            historyRef.current = [];
            missCountRef.current = 0;
            setStable(false);
          } else {
            // Genuine last resort after repeated failures, so the app
            // never gets stuck silently retrying forever.
            setCropFailed(true);
            setCapturedPath(uri);
            retryCountRef.current = 0;
          }
        }
      })
      .catch((error) => {
        console.log('capture error', error);
      })
      .finally(() => {
        capturingRef.current = false;
      });
  }, [stable, capturedPath, rectangle]);

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>
          This app needs camera access to scan documents.
        </Text>
        <Button title="Grant camera permission" onPress={requestPermission} />
      </View>
    );
  }

  if (device == null) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>No camera device found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={capturedPath == null}
        photo={true}
        frameProcessor={frameProcessor}
        frameProcessorFps={5}
      />
      {rectangle && capturedPath == null && <RectangleOverlay rectangle={rectangle} stable={stable} />}
      {capturedPath && (
        <View style={styles.previewOverlay}>
          <Text style={styles.message}>Captured!</Text>
          {cropFailed && (
            <Text style={styles.warning}>
              Couldn't detect edges clearly after several tries, showing full photo instead of a cropped one.
            </Text>
          )}
          <Image source={{ uri: capturedPath }} style={styles.preview} resizeMode="contain" />
          <Button title="Scan again" onPress={startNewScan} />
        </View>
      )}
    </View>
  );
}

function RectangleOverlay({ rectangle, stable }: { rectangle: Rectangle; stable: boolean }) {
  const points = [rectangle.topLeft, rectangle.topRight, rectangle.bottomRight, rectangle.bottomLeft]
    .map((corner) => `${corner.x * 100},${(1 - corner.y) * 100}`)
    .join(' ');

  const color = stable ? 'rgb(76, 217, 100)' : 'rgb(255, 181, 6)';

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <Polygon
        points={points}
        fill={stable ? 'rgba(76, 217, 100, 0.2)' : 'rgba(255, 181, 6, 0.15)'}
        stroke={color}
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  message: { textAlign: 'center', marginBottom: 12, fontSize: 20, fontWeight: '600' },
  warning: {
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
    color: '#b45309',
    paddingHorizontal: 24,
  },
  preview: {
    width: '90%',
    height: 500,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'white',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
});
