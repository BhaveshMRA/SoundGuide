import { useEffect, useRef, useState } from 'react';
import { Button, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
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

const OLLAMA_API_KEY = process.env.EXPO_PUBLIC_OLLAMA_API_KEY;
const OLLAMA_VERIFY_MODEL = 'gemma4:cloud';
const OLLAMA_REASONING_MODEL = 'gemma4:31b-cloud';

type Corner = { x: number; y: number };
type Rectangle = {
  topLeft: Corner;
  topRight: Corner;
  bottomLeft: Corner;
  bottomRight: Corner;
  confidence: number;
};
type DetectedRectangle = Rectangle | null;
type Correction = { wrong: string; correct: string };

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
  return corners.every((corner) => {
    const xs = history.map((r) => (r[corner] as Corner).x);
    const ys = history.map((r) => (r[corner] as Corner).y);
    return Math.max(...xs) - Math.min(...xs) <= STABILITY_THRESHOLD &&
      Math.max(...ys) - Math.min(...ys) <= STABILITY_THRESHOLD;
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOllama(content: string, model: string, images?: string[]): Promise<string> {
  if (!OLLAMA_API_KEY) {
    throw new Error('EXPO_PUBLIC_OLLAMA_API_KEY is not set. Check your .env file.');
  }

  const message: Record<string, unknown> = { role: 'user', content };
  if (images && images.length > 0) {
    message.images = images;
  }

  const response = await fetch('https://ollama.com/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OLLAMA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [message],
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.message?.content ?? '(no response content)';
}

// Asks for a short list of corrections rather than the entire corrected
// document. Generation time scales with output length, reproducing a
// whole page is a much bigger, slower ask than reporting a handful of
// specific fixes, which we then apply ourselves in plain JS.
async function verifyOcrWithImage(
  imageUri: string,
  ocrText: string
): Promise<{ text: string; corrections: Correction[] }> {
  const resized = await ImageManipulator.manipulateAsync(
    imageUri,
    [{ resize: { width: 1200 } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );
  const base64Image = resized.base64;
  if (!base64Image) {
    throw new Error('Failed to downscale image for verification');
  }

  const prompt =
    'Here is a photo of a scanned document, and text an on-device OCR system extracted from it. ' +
    'The OCR text may contain mistakes, especially in names, addresses, abbreviations, and numbers, ' +
    'often caused by blur or unclear handwriting.\n\n' +
    'OCR text:\n' +
    ocrText +
    '\n\n' +
    'Compare the OCR text against the image. List ONLY the specific mistakes you find, as a JSON array ' +
    'of objects with "wrong" and "correct" fields, for example: ' +
    '[{"wrong": "Jersey City, ND", "correct": "Jersey City, NJ"}]. ' +
    'If there are no mistakes, return an empty array []. Return only the JSON array, nothing else, no markdown formatting.';

  const responseText = await callOllama(prompt, OLLAMA_VERIFY_MODEL, [base64Image]);

  let corrections: Correction[] = [];
  try {
    const cleaned = responseText.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    corrections = JSON.parse(cleaned);
  } catch (parseError) {
    console.log('Could not parse corrections JSON, keeping raw OCR text', parseError, responseText);
    return { text: ocrText, corrections: [] };
  }

  let corrected = ocrText;
  for (const { wrong, correct } of corrections) {
    if (wrong && correct && corrected.includes(wrong)) {
      corrected = corrected.replaceAll(wrong, correct);
    }
  }
  return { text: corrected, corrections };
}

async function askOllama(documentText: string): Promise<string> {
  const prompt =
    'You are helping a blind user understand a document that was just scanned. ' +
    'Here is the text extracted from it:\n\n' +
    documentText +
    '\n\nIn clear, spoken-friendly language, describe what kind of document this is and summarize its key points.';
  return callOllama(prompt, OLLAMA_REASONING_MODEL);
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
  const [verifying, setVerifying] = useState(false);
  const [verifyElapsedMs, setVerifyElapsedMs] = useState(0);
  const [ocrCorrected, setOcrCorrected] = useState(false);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [aiSummary, setAiSummary] = useState<string>('');
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState<string>('');
  const historyRef = useRef<Rectangle[]>([]);
  const missCountRef = useRef(0);
  const capturingRef = useRef(false);
  const retryCountRef = useRef(0);
  const stableRef = useRef(false);
  const scanTokenRef = useRef(0);

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
    scanTokenRef.current += 1;
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
    setVerifying(false);
    setVerifyElapsedMs(0);
    setOcrCorrected(false);
    setCorrections([]);
    setAiSummary('');
    setAiRunning(false);
    setAiError('');
  };

  const runOcrAndVerify = async (imageUri: string) => {
    const token = ++scanTokenRef.current;
    const isCurrent = () => scanTokenRef.current === token;

    setOcrRunning(true);
    setOcrCorrected(false);
    setCorrections([]);
    let rawText = '';
    try {
      rawText = await DocumentScannerModule.recognizeText(imageUri);
      if (!isCurrent()) return;
      setRecognizedText(rawText);
    } catch (ocrError) {
      if (!isCurrent()) return;
      setRecognizedText('OCR failed: ' + String(ocrError));
      setOcrRunning(false);
      return;
    }
    setOcrRunning(false);

    if (!rawText.trim()) return;

    setVerifying(true);
    const verifyStart = Date.now();
    const timer = setInterval(() => {
      if (!isCurrent()) return clearInterval(timer);
      setVerifyElapsedMs(Date.now() - verifyStart);
    }, 250);
    try {
      const result = await verifyOcrWithImage(imageUri, rawText);
      if (!isCurrent()) return;
      setRecognizedText(result.text);
      setCorrections(result.corrections);
      setOcrCorrected(true);
    } catch (verifyError) {
      console.log('OCR verification failed, keeping raw OCR text', verifyError);
    } finally {
      clearInterval(timer);
      if (isCurrent()) setVerifying(false);
    }
  };

  const handleAskAi = async () => {
    if (!recognizedText) return;
    setAiRunning(true);
    setAiError('');
    setAiSummary('');
    try {
      const summary = await askOllama(recognizedText);
      setAiSummary(summary);
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiRunning(false);
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

      setDebugInfo(
        await DocumentScannerModule.debugImageInfo(uri).catch(
          (e: unknown) => 'debug call itself failed: ' + String(e)
        )
      );

      try {
        const croppedUri = await DocumentScannerModule.cropToDocument(uri);
        retryCountRef.current = 0;
        setCapturedPath(croppedUri);
        const savedScans = await DocumentScannerModule.listSavedScans();
        setSavedCount(savedScans.length);
        runOcrAndVerify(croppedUri);
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
          const finalUri = await DocumentScannerModule.correctOrientation(uri).catch(() => uri);
          setCapturedPath(finalUri);
          runOcrAndVerify(finalUri);
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

            <Text style={styles.sectionLabel}>
              {ocrCorrected ? 'Extracted text (verified against image by AI)' : 'Extracted text (on-device OCR)'}
            </Text>
            {ocrRunning ? (
              <Text style={styles.ocrText}>Reading text...</Text>
            ) : (
              <Text selectable style={styles.ocrText}>{recognizedText || '(no text found)'}</Text>
            )}
            {verifying && (
              <Text style={styles.debug}>
                Checking text against image with AI... ({(verifyElapsedMs / 1000).toFixed(1)}s)
              </Text>
            )}
            {ocrCorrected && corrections.length > 0 && (
              <Text style={styles.debug}>
                {corrections.length} correction(s) applied: {corrections.map((c) => `"${c.wrong}" -> "${c.correct}"`).join(', ')}
              </Text>
            )}
            {ocrCorrected && corrections.length === 0 && (
              <Text style={styles.debug}>No corrections needed.</Text>
            )}

            {!ocrRunning && recognizedText ? (
              <View style={styles.aiSection}>
                <Button
                  title="Ask AI about this document"
                  onPress={handleAskAi}
                  disabled={aiRunning || verifying}
                />
                {aiRunning && <Text style={styles.ocrText}>Asking Gemma...</Text>}
                {aiError ? <Text style={styles.warning}>{aiError}</Text> : null}
                {aiSummary ? (
                  <>
                    <Text style={styles.sectionLabel}>AI summary (Gemma, via Ollama Cloud)</Text>
                    <Text selectable style={styles.ocrText}>{aiSummary}</Text>
                  </>
                ) : null}
              </View>
            ) : null}

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
    marginTop: 16,
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
  aiSection: {
    width: '100%',
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
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
