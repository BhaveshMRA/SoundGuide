import { useEffect, useRef, useState } from 'react';
import { Button, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import Svg, { Polygon } from 'react-native-svg';
import DocumentScannerModule from '../modules/document-scanner/src/DocumentScannerModule';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('detectRectangle');

const HISTORY_SIZE = 4;
const STABILITY_THRESHOLD = 0.05;
const MISS_TOLERANCE = 2;
const MIN_AREA = 0.15;
const MAX_CROP_RETRIES = 3;
const RECHECK_POLL_MS = 150;
const RECHECK_MAX_WAIT_MS = 2000;
const RETRY_COOLDOWN_MS = 300;

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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [
    { photoAspectRatio: 16 / 9 },
    { photoResolution: 'max' },
    { videoAspectRatio: 16 / 9 },
    { videoResolution: { width: 1920, height: 1080 } },
  ]);
  const cameraRef = useRef<Camera>(null);
  const [rectangle, setRectangle] = useState<DetectedRectangle>(null);
  const [stable, setStable] = useState(false);
  const [capturedPath, setCapturedPath] = useState<string | null>(null);
  const [cropFailed, setCropFailed] = useState(false);
  const [debugInfo, setDebugInfo] = useState<string>('');
  const [savedCount, setSavedCount] = useState<number>(0);
  const [recognizedText, setRecognizedText] = useState<string>('');
  const [ocrRunning, setOcrRunning] = useState(false);
  const historyRef = useRef<Rectangle[]>([]);
  const missCountRef = useRef(0);
  const capturingRef = useRef(false);
  const retryCountRef = useRef(0);
  const stableRef = useRef(false);

  const updateRectangle = Worklets.createRunOnJS((result: DetectedRectangle) => {
    const validResult = result != null && quadArea(result) >= MIN_AREA ? result : null;

    if (validResult == null) {
      missCountRef.current += 1;
      if (missCountRef.current > MISS_TOLERANCE) {
        setRectangle(null);
        historyRef.current = [];
        setStable(false);
        stableRef.current = false;
      }
      return;
    }
    missCountRef.current = 0;
    setRectangle(validResult);
    historyRef.current = [...historyRef.current, validResult].slice(-HISTORY_SIZE);
    const nowStable = isStable(historyRef.current);
    setStable(nowStable);
    stableRef.current = nowStable;
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
    stableRef.current = false;
    setRectangle(null);
    setStable(false);
    setCapturedPath(null);
    setCropFailed(false);
    setDebugInfo('');
    setRecognizedText('');
    setOcrRunning(false);
  };

  const runOcr = async (imageUri: string) => {
    setOcrRunning(true);
    try {
      const text = await DocumentScannerModule.recognizeText(imageUri);
      setRecognizedText(text);
    } catch (ocrError) {
      setRecognizedText('OCR failed: ' + String(ocrError));
    } finally {
      setOcrRunning(false);
    }
  };

  useEffect(() => {
    if (!stable || capturingRef.current || capturedPath != null || rectangle == null) return;
    capturingRef.current = true;

    const runCapture = async () => {
      let waited = 0;
      while (!stableRef.current && waited < RECHECK_MAX_WAIT_MS) {
        await wait(RECHECK_POLL_MS);
        waited += RECHECK_POLL_MS;
      }
      if (!stableRef.current) {
        return;
      }

      const photo = await cameraRef.current?.takePhoto({
        flash: 'off',
        qualityPrioritization: 'quality',
      });
      if (!photo) return;

      const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;

      try {
        const info = await DocumentScannerModule.debugImageInfo(uri);
        setDebugInfo(info);
      } catch (e) {
        setDebugInfo('debug call itself failed: ' + String(e));
      }

      try {
        const croppedUri = await DocumentScannerModule.cropToDocument(uri);
        retryCountRef.current = 0;
        setCapturedPath(croppedUri);
        const savedScans = await DocumentScannerModule.listSavedScans();
        setSavedCount(savedScans.length);
        runOcr(croppedUri);
      } catch (cropError) {
        retryCountRef.current += 1;
        console.log(`crop error, attempt ${retryCountRef.current} of ${MAX_CROP_RETRIES}`, cropError);

        if (retryCountRef.current < MAX_CROP_RETRIES) {
          await wait(RETRY_COOLDOWN_MS);
          historyRef.current = [];
          missCountRef.current = 0;
          setStable(false);
          stableRef.current = false;
        } else {
          setCropFailed(true);
          let finalUri = uri;
          try {
            finalUri = await DocumentScannerModule.correctOrientation(uri);
          } catch {
            // fall through with the original uri
          }
          setCapturedPath(finalUri);
          runOcr(finalUri);
          retryCountRef.current = 0;
        }
      }
    };

    runCapture()
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
        format={format}
        isActive={capturedPath == null}
        photo={true}
        frameProcessor={frameProcessor}
        frameProcessorFps={10}
        resizeMode="contain"
      />
      {rectangle && capturedPath == null && <RectangleOverlay rectangle={rectangle} stable={stable} />}
      {capturedPath && (
        <View style={styles.previewOverlay}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Text style={styles.message}>Captured!</Text>
            <Text selectable style={styles.debug}>{debugInfo}</Text>
            <Text style={styles.debug}>{savedCount} scan(s) saved on device</Text>
            {cropFailed && (
              <Text style={styles.warning}>
                Couldn't detect edges clearly after several tries, showing full photo instead of a cropped one.
              </Text>
            )}
            <Image source={{ uri: capturedPath }} style={styles.preview} resizeMode="contain" />
            <Text style={styles.sectionLabel}>Extracted text (on-device OCR, no LLM)</Text>
            {ocrRunning ? (
              <Text style={styles.ocrText}>Reading text...</Text>
            ) : (
              <Text selectable style={styles.ocrText}>{recognizedText || '(no text found)'}</Text>
            )}
            <Button title="Scan again" onPress={startNewScan} />
          </ScrollView>
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
  debug: {
    textAlign: 'center',
    marginBottom: 8,
    fontSize: 13,
    color: '#1d4ed8',
    paddingHorizontal: 16,
    fontFamily: 'Courier',
  },
  warning: {
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 14,
    color: '#b45309',
    paddingHorizontal: 24,
  },
  preview: {
    width: '100%',
    height: 400,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 6,
    color: '#111',
    alignSelf: 'flex-start',
  },
  ocrText: {
    fontSize: 15,
    lineHeight: 21,
    color: '#222',
    marginBottom: 16,
  },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'white',
  },
  scrollContent: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 40,
    alignItems: 'stretch',
  },
});
