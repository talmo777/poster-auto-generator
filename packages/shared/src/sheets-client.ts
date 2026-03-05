/**
 * Google Sheets Client
 *
 * 내부 시트(config/state/logs) 및 사용자 시트(DB/결과) 모두에 대한
 * 읽기/쓰기 작업을 처리하는 클라이언트.
 */

import { google, sheets_v4 } from 'googleapis';
import type { AppConfig, WorkerState } from './types.js';

// ============================================================
// Auth
// ============================================================

export function createSheetsClient(serviceAccountJson: string): sheets_v4.Sheets {
    const credentials = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive',
        ],
    });
    return google.sheets({ version: 'v4', auth });
}

// ============================================================
// Read Operations
// ============================================================

/**
 * 시트의 첫 번째 행(헤더)을 읽어 문자열 배열로 반환
 */
export async function readHeaders(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
): Promise<string[]> {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!1:1`,
    });
    return (res.data.values?.[0] as string[]) || [];
}

/**
 * 지정 범위의 행을 읽어 헤더-키 기반 객체 배열로 반환.
 * startRow는 1-indexed (헤더 제외 데이터 행 기준, 실제 시트에서 2행부터 시작)
 */
export async function readRows(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    startRow: number,
    count: number,
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
    // 먼저 헤더 읽기
    const headers = await readHeaders(sheets, spreadsheetId, sheetName);

    // 데이터 행 읽기 (시트의 실제 행번호 = startRow + 1, 헤더가 1행이므로)
    const sheetStartRow = startRow + 1;
    const sheetEndRow = sheetStartRow + count - 1;
    const range = `'${sheetName}'!A${sheetStartRow}:${columnLetter(headers.length)}${sheetEndRow}`;

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    const rawRows = res.data.values || [];
    const rows: Record<string, string>[] = rawRows.map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((header, i) => {
            obj[header] = (row[i] as string) || '';
        });
        return obj;
    });

    return { headers, rows };
}

/**
 * 시트에서 데이터가 존재하는 마지막 행 번호를 반환 (헤더 제외, 1-indexed)
 * 빈 행 사이에 데이터가 있는 경우도 고려
 */
export async function getLastDataRow(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
): Promise<number> {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!A:A`,
    });
    const values = res.data.values || [];
    // values[0]은 헤더, 마지막 비어있지 않은 행을 찾음
    let lastRow = 0;
    for (let i = 1; i < values.length; i++) {
        if (values[i] && values[i][0] && String(values[i][0]).trim() !== '') {
            lastRow = i; // 0-indexed in array, but 1-indexed as data row
        }
    }
    return lastRow; // 헤더 제외한 데이터 행 수 기준
}

// ============================================================
// Write Operations
// ============================================================

/**
 * 시트 끝에 새 행 추가 (append)
 */
export async function appendRow(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    values: string[],
): Promise<void> {
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${sheetName}'!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [values],
        },
    });
}

/**
 * 특정 셀에 값 쓰기
 * row: 1-indexed (시트 실제 행)
 * col: 0-indexed
 */
export async function writeCell(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    row: number,
    col: number,
    value: string,
): Promise<void> {
    const cell = `'${sheetName}'!${columnLetter(col + 1)}${row}`;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: cell,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[value]],
        },
    });
}

/**
 * 특정 행의 여러 컬럼에 동시에 값 쓰기
 */
export async function writeCells(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetName: string,
    row: number,
    colValuePairs: { col: number; value: string }[],
): Promise<void> {
    const data = colValuePairs.map(({ col, value }) => ({
        range: `'${sheetName}'!${columnLetter(col + 1)}${row}`,
        values: [[value]],
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data,
        },
    });
}

// ============================================================
// Config KV (Internal Sheet - config tab)
// ============================================================

/**
 * config 탭에서 key-value 전체를 읽어 Map으로 반환
 */
export async function readConfigMap(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    configSheetName = 'config',
): Promise<Map<string, string>> {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${configSheetName}'!A:C`,
    });
    const rows = res.data.values || [];
    const map = new Map<string, string>();
    // 첫 행은 헤더 (key, value, updated_at) → 스킵
    for (let i = 1; i < rows.length; i++) {
        const key = rows[i]?.[0];
        const value = rows[i]?.[1];
        if (key) map.set(String(key), String(value ?? ''));
    }
    return map;
}

/**
 * config 탭에 key-value 쓰기 (존재하면 업데이트, 없으면 추가)
 */
export async function writeConfigValue(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    key: string,
    value: string,
    configSheetName = 'config',
): Promise<void> {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${configSheetName}'!A:A`,
    });
    const keys = res.data.values || [];
    let rowIndex = -1;

    for (let i = 0; i < keys.length; i++) {
        if (keys[i]?.[0] === key) {
            rowIndex = i + 1; // 1-indexed
            break;
        }
    }

    const now = new Date().toISOString();

    if (rowIndex > 0) {
        // Update existing
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `'${configSheetName}'!B${rowIndex}:C${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[value, now]] },
        });
    } else {
        // Append new
        await appendRow(sheets, spreadsheetId, configSheetName, [key, value, now]);
    }
}

/**
 * config Map을 AppConfig 객체로 변환
 */
export function configMapToAppConfig(map: Map<string, string>): AppConfig {
    return {
        dbSpreadsheetId: map.get('db_spreadsheet_id') ?? '',
        dbSheetName: map.get('db_sheet_name') ?? '',
        resultSpreadsheetId: map.get('result_spreadsheet_id') ?? '',
        resultSheetName: map.get('result_sheet_name') ?? '',
        internalSpreadsheetId: '', // set externally
        batchSize: parseInt(map.get('batch_size') ?? '5', 10),
        cronExpression: map.get('cron_expression') ?? '0 0 * * 1',
        timezone: map.get('timezone') ?? 'Asia/Seoul',
        fixedMessage: map.get('fixed_message') ?? '',
        geminiApiKeyEncrypted: map.get('gemini_api_key_encrypted') ?? '',
        dbHeaderMappingJson: map.get('db_header_mapping_json') ?? '[]',
        resultHeaderMappingJson: map.get('result_header_mapping_json') ?? '{}',
        dbHeaderHash: map.get('db_header_hash') ?? '',
        resultHeaderHash: map.get('result_header_hash') ?? '',
        driveFolderId: map.get('drive_folder_id') ?? '',
    };
}

// ============================================================
// State (Internal Sheet - state tab)
// ============================================================

export async function readState(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    stateSheetName = 'state',
): Promise<WorkerState> {
    const map = await readConfigMap(sheets, spreadsheetId, stateSheetName);
    return {
        nextRowIndex: parseInt(map.get('next_row_index') ?? '1', 10),
        cycleNumber: parseInt(map.get('cycle_number') ?? '1', 10),
        lastRunAt: map.get('last_run_at') ?? '',
        isRunning: map.get('is_running') === 'true',
        lockExpiry: map.get('lock_expiry') ?? '',
        totalGenerated: parseInt(map.get('total_generated') ?? '0', 10),
    };
}

export async function writeState(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    state: Partial<WorkerState>,
    stateSheetName = 'state',
): Promise<void> {
    const entries: [string, string][] = [];
    if (state.nextRowIndex !== undefined)
        entries.push(['next_row_index', String(state.nextRowIndex)]);
    if (state.cycleNumber !== undefined)
        entries.push(['cycle_number', String(state.cycleNumber)]);
    if (state.lastRunAt !== undefined)
        entries.push(['last_run_at', state.lastRunAt]);
    if (state.isRunning !== undefined)
        entries.push(['is_running', String(state.isRunning)]);
    if (state.lockExpiry !== undefined)
        entries.push(['lock_expiry', state.lockExpiry]);
    if (state.totalGenerated !== undefined)
        entries.push(['total_generated', String(state.totalGenerated)]);

    for (const [key, value] of entries) {
        await writeConfigValue(sheets, spreadsheetId, key, value, stateSheetName);
    }
}

// ============================================================
// Utility
// ============================================================

/**
 * 0-indexed 컬럼 번호를 엑셀 컬럼 문자로 변환 (1→A, 2→B, 27→AA ...)
 */
function columnLetter(colNum: number): string {
    let letter = '';
    let num = colNum;
    while (num > 0) {
        const mod = (num - 1) % 26;
        letter = String.fromCharCode(65 + mod) + letter;
        num = Math.floor((num - 1) / 26);
    }
    return letter;
}

export { columnLetter };
