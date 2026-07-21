import { registerWebModule, NativeModule } from 'expo';

class DocumentScannerModule extends NativeModule<{}> {}

export default registerWebModule(DocumentScannerModule, 'DocumentScannerModule');
