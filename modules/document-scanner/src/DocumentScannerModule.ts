import { NativeModule, requireNativeModule } from 'expo';

declare class DocumentScannerModule extends NativeModule<{}> {}

export default requireNativeModule<DocumentScannerModule>('DocumentScanner');
