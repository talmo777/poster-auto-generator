/**
 * Admin UI — Sheets API Helper
 *
 * 브라우저에서 Google Sheets API를 직접 호출하기 위한 클라이언트.
 * API Route (Next.js) 경유로 서비스 어카운트 인증 처리.
 */

// 내부 시트 API 호출 헬퍼
const API_BASE = '/api';

export interface ConfigEntry {
    key: string;
    value: string;
    updatedAt: string;
}

export interface StateEntry {
    nextRowIndex: number;
    cycleNumber: number;
    lastRunAt: string;
    isRunning: boolean;
    lockExpiry: string;
    totalGenerated: number;
}

export interface RunLogEntry {
    runId: string;
    startedAt: string;
    finishedAt: string;
    status: string;
    rowsProcessed: number;
    rowsSuccess: number;
    rowsFailed: number;
    cycle: number;
    batchRange: string;
    errorSummary: string;
}

export interface RowLogEntry {
    runId: string;
    rowIndex: number;
    dbRowHash: string;
    status: string;
    templateId: string;
    seed: number;
    promptVersion: string;
    posterUrl: string;
    driveFileId: string;
    retryCount: number;
    errorMessage: string;
    createdAt: string;
}

export interface ErrorEntry {
    errorId: string;
    runId: string;
    rowIndex: number;
    errorType: string;
    errorMessage: string;
    stackTrace: string;
    createdAt: string;
}

// Config 관련
export async function fetchConfig(): Promise<Map<string, string>> {
    const res = await fetch(`${API_BASE}/config`);
    const data = await res.json();
    return new Map(Object.entries(data));
}

export async function updateConfig(key: string, value: string): Promise<void> {
    await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
    });
}

// State
export async function fetchState(): Promise<StateEntry> {
    const res = await fetch(`${API_BASE}/state`);
    return res.json();
}

// Headers
export async function fetchSheetHeaders(
    spreadsheetId: string,
    sheetName: string,
): Promise<string[]> {
    const res = await fetch(
        `${API_BASE}/headers?spreadsheetId=${encodeURIComponent(spreadsheetId)}&sheetName=${encodeURIComponent(sheetName)}`
    );
    return res.json();
}

// Header Inference
export async function inferMapping(
    headers: string[],
    type: 'db' | 'result',
): Promise<unknown> {
    const res = await fetch(`${API_BASE}/infer-mapping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headers, type }),
    });
    return res.json();
}

// Logs
export async function fetchRunLogs(): Promise<RunLogEntry[]> {
    const res = await fetch(`${API_BASE}/logs/runs`);
    return res.json();
}

export async function fetchRowLogs(): Promise<RowLogEntry[]> {
    const res = await fetch(`${API_BASE}/logs/rows`);
    return res.json();
}

export async function fetchErrors(): Promise<ErrorEntry[]> {
    const res = await fetch(`${API_BASE}/logs/errors`);
    return res.json();
}

// Dashboard stats
export async function fetchDashboardStats(): Promise<{
    totalGenerated: number;
    cycleNumber: number;
    nextRowIndex: number;
    lastRunAt: string;
    isRunning: boolean;
    recentRuns: RunLogEntry[];
    rowGenerationCounts: Record<number, number>;
}> {
    const res = await fetch(`${API_BASE}/dashboard`);
    return res.json();
}
