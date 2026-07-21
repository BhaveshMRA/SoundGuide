import { useState } from 'react';
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

type Corner = { x: number; y: number };
type DetectedRectangle = {
  topLeft: Corner;
  topRight: Corner;
  bottomLeft: Corner;
  bottomRight: Corner;
  confidence: number;
} | null;

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const [rectangle, setRectangle] = useState<DetectedRectangle>(null);

  const updateRectangle = Worklets.createRunOnJS((result: DetectedRectangle) => {
    setRectangle(result);
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
      {rectangle && <RectangleOverlay rectangle={rectangle} />}
    </View>
  );
}

function RectangleOverlay({ rectangle }: { rectangle: NonNullable<DetectedRectangle> }) {
  // Vision's y-axis increases upward from the bottom; screen y increases
  // downward from the top, so each point's y needs to be flipped (1 - y).
  const points = [rectangle.topLeft, rectangle.topRight, rectangle.bottomRight, rectangle.bottomLeft]
    .map((corner) => `${corner.x * 100},${(1 - corner.y) * 100}`)
    .join(' ');

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <Polygon
        points={points}
        fill="rgba(255, 181, 6, 0.15)"
        stroke="rgb(255, 181, 6)"
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
