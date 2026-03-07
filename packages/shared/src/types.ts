// ============================================================
// Types & Interfaces
// ============================================================

// --- Config ---
export interface AppConfig {
    dbSpreadsheetId: string;
    dbSheetName: string;
    resultSpreadsheetId: string;
    resultSheetName: string;
    internalSpreadsheetId: string;
    batchSize: number;
    cronExpression: string;
    timezone: string;
    fixedMessage: string;
    geminiApiKeyEncrypted: string;
    dbHeaderMappingJson: string;
    resultHeaderMappingJson: string;
    dbHeaderHash: string;
    resultHeaderHash: string;
    driveFolderId: string;
}

// --- State ---
export interface WorkerState {
    nextRowIndex: number;
    cycleNumber: number;
    lastRunAt: string;
    isRunning: boolean;
    lockExpiry: string;
    totalGenerated: number;
}

// --- Semantic Mapping ---
export type DbSemanticSlot =
    | 'headline_source'
    | 'equipment_name'
    | 'description'
    | 'price_info'
    | 'contact'
    | 'keywords'
    | 'reference_image_url'
    | 'location'
    | 'availability'
    | 'category'
    | 'specification'
    | 'manufacturer'
    | 'model_number'
    | 'booking_link'
    | 'unmapped';

export type ResultSemanticSlot =
    | 'poster_url'
    | 'headline_used'
    | 'summary'
    | 'generation_date'
    | 'template_id'
    | 'json_package'
    | 'unmapped';

export interface SemanticMapping {
    headerName: string;
    columnIndex: number;
    inferredSlot: DbSemanticSlot;
    confidence: number;
    confirmedSlot?: DbSemanticSlot;
    isConfirmed: boolean;
}

export interface ResultMapping {
    headerName: string;
    columnIndex: number;
    inferredSlot: ResultSemanticSlot;
    confidence: number;
    confirmedSlot?: ResultSemanticSlot;
    isConfirmed: boolean;
}

export type ResultSaveStrategy = 'distributed' | 'json_package' | 'manual';

export interface ResultMappingConfig {
    strategy: ResultSaveStrategy;
    mappings: ResultMapping[];
    jsonPackageColumn?: string;
}

// --- Poster ---
export interface PosterCopy {
    headline: string;
    subheadline: string;
    bullets: string[];
    cta: string;
    supplementary: string;
}

export interface PosterMaterials {
    headlineSource?: string;
    equipmentName?: string;
    description?: string;
    priceInfo?: string;
    contact?: string;
    keywords?: string;
    referenceImageUrl?: string;
    location?: string;
    availability?: string;
    category?: string;
    specification?: string;
    manufacturer?: string;
    modelNumber?: string;
    bookingLink?: string;
}

export type TemplateLayout = 'centered' | 'split' | 'grid' | 'hero' | 'minimal' | 'diagonal';

export interface PosterTemplate {
    id: string;
    name: string;
    layout: TemplateLayout;
    colorScheme: {
        primary: string;
        secondary: string;
        accent: string;
        background: string;
        text: string;
    };
    typography: {
        headlineFont: string;
        bodyFont: string;
        ctaFont: string;
    };
    aspectRatio: '4:5' | '9:16';
    promptStyle: string;
}

export interface PosterResult {
    imageBuffer: Buffer;
    posterUrl?: string;
    driveFileId?: string;
    copy: PosterCopy;
    templateId: string;
    seed: number;
    promptVersion: string;
}

// --- Logs ---
export interface RunLog {
    runId: string;
    startedAt: string;
    finishedAt: string;
    status: 'success' | 'partial' | 'failed';
    rowsProcessed: number;
    rowsSuccess: number;
    rowsFailed: number;
    cycle: number;
    batchRange: string;
    errorSummary: string;
}

export interface RowLog {
    runId: string;
    rowIndex: number;
    dbRowHash: string;
    status: 'success' | 'failed' | 'skipped';
    templateId: string;
    seed: number;
    promptVersion: string;
    posterUrl: string;
    driveFileId: string;
    retryCount: number;
    errorMessage: string;
    createdAt: string;
}

export interface ErrorLog {
    errorId: string;
    runId: string;
    rowIndex: number;
    errorType: string;
    errorMessage: string;
    stackTrace: string;
    createdAt: string;
}
