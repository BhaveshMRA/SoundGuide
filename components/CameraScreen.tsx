import { useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import Svg, { Polygon } from 'react-native-svg';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('detectRectangle');

const HISTORY_SIZE = 5;
const STABILITY_THRESHOLD = 0.035;
const MISS_TOLERANCE = 3;

type Corner = { x: number; y: number };
type Rectangle = {
  topLeft: Corner;
  topRight: Corner;
  bottomLeft: Corner;
  bottomRight: Corner;
  confidence: number;
};
type DetectedRectangle = Rectangle | null;

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
  const [rectangle, setRectangle] = useState<DetectedRectangle>(null);
  const [stable, setStable] = useState(false);
  const historyRef = useRef<Rectangle[]>([]);
  const missCountRef = useRef(0);

  const updateRectangle = Worklets.createRunOnJS((result: DetectedRectangle) => {
    if (result == null) {
      missCountRef.current += 1;
      if (missCountRef.current > MISS_TOLERANCE) {
        setRectangle(null);
        historyRef.current = [];
        setStable(false);
      }
      return;
    }
    missCountRef.current = 0;
    setRectangle(result);
    historyRef.current = [...historyRef.current, result].slice(-HISTORY_SIZE);
    setStable(isStable(historyRef.current));
  });

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (plugin == null) return;
    const result = plugin.call(frame);
    updateRectangle(result);
  }, []);

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
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        frameProcessor={frameProcessor}
        frameProcessorFps={5}
      />
      {rectangle && <RectangleOverlay rectangle={rectangle} stable={stable} />}
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
  message: { textAlign: 'center', marginBottom: 12 },
});
