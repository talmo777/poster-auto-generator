/**
 * Shared Package - Public API
 */

// Types
export type {
    AppConfig,
    WorkerState,
    DbSemanticSlot,
    ResultSemanticSlot,
    SemanticMapping,
    ResultMapping,
    ResultSaveStrategy,
    ResultMappingConfig,
    PosterCopy,
    PosterMaterials,
    TemplateLayout,
    PosterTemplate,
    PosterResult,
    RunLog,
    RowLog,
    ErrorLog,
} from './types.js';

// Sheets Client
export {
    createSheetsClient,
    readHeaders,
    readRows,
    getLastDataRow,
    appendRow,
    writeCell,
    writeCells,
    readConfigMap,
    writeConfigValue,
    configMapToAppConfig,
    readState,
    writeState,
    columnLetter,
} from './sheets-client.js';

// Drive Uploader
export {
    createDriveClient,
    uploadImage,
    setPublicReadable,
} from './drive-uploader.js';
export type { UploadResult } from './drive-uploader.js';

// State Manager
export { StateManager } from './state-manager.js';

// Crypto
export {
    getEncryptionKey,
    encrypt,
    decrypt,
    generateEncryptionKey,
} from './crypto-utils.js';

// Header Inference
export {
    DB_SEMANTIC_SLOTS,
    RESULT_SEMANTIC_SLOTS,
    computeHeaderHash,
    detectHeaderChange,
    inferDbMapping,
    inferResultMapping,
    findColumnBySlot,
    findResultColumnBySlot,
    extractPosterMaterials,
} from './header-inference.js';

// Poster Templates
export {
    POSTER_TEMPLATES,
    selectTemplate,
    getTemplateById,
} from './poster-templates.js';

// Copy Generator
export {
    generateCopy,
    PROMPT_VERSION,
} from './copy-generator.js';

// Poster Generator
export {
    generatePoster,
    generateSeed,
} from './poster-generator.js';

// Logger
export {
    logRun,
    logRow,
    logError,
    hashRowData,
} from './logger.js';
