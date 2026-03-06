/**
 * Logger
 *
 * 내부 시트의 run_logs, row_logs, errors 탭에 로그를 기록.
 */

import type { sheets_v4 } from 'googleapis';
import type { RunLog, RowLog, ErrorLog } from './types.js';
import { appendRow } from './sheets-client.js';

/**
 * UUID 생성 (uuid 패키지 없이 간단 구현)
 */
function generateId(): string {
    // 간단한 UUID v4 생성
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export async function logRun(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    log: Omit<RunLog, 'runId'>,
    tabName = 'run_logs',
): Promise<string> {
    const runId = generateId();
    await appendRow(sheets, spreadsheetId, tabName, [
        runId,
        log.startedAt,
        log.finishedAt,
        log.status,
        String(log.rowsProcessed),
        String(log.rowsSuccess),
        String(log.rowsFailed),
        String(log.cycle),
        log.batchRange,
        log.errorSummary,
    ]);
    return runId;
}

export async function logRow(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    log: RowLog,
    tabName = 'row_logs',
): Promise<void> {
    await appendRow(sheets, spreadsheetId, tabName, [
        log.runId,
        String(log.rowIndex),
        log.dbRowHash,
        log.status,
        log.templateId,
        String(log.seed),
        log.promptVersion,
        log.posterUrl,
        log.driveFileId,
        String(log.retryCount),
        log.errorMessage,
        log.createdAt,
    ]);
}

export async function logError(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    log: Omit<ErrorLog, 'errorId'>,
    tabName = 'errors',
): Promise<string> {
    const errorId = generateId();
    await appendRow(sheets, spreadsheetId, tabName, [
        errorId,
        log.runId,
        String(log.rowIndex),
        log.errorType,
        log.errorMessage,
        log.stackTrace,
        log.createdAt,
    ]);
    return errorId;
}

/**
 * 행 데이터의 해시 생성 (변경 감지/추적용)
 */
export function hashRowData(row: Record<string, string>): string {
    const values = Object.values(row).join('|');
    // 간단한 해시 (SHA-256 없이)
    let hash = 0;
    for (let i = 0; i < values.length; i++) {
        const chr = values.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}
