/**
 * Sheets Service — Server-side Google Sheets operations for API routes
 */

import { google } from 'googleapis';

function getAuth() {
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');

    const credentials = JSON.parse(keyJson);
    return new google.auth.GoogleAuth({
        credentials,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive',
        ],
    });
}

function getSheets() {
    return google.sheets({ version: 'v4', auth: getAuth() });
}

const INTERNAL_SHEET_ID = process.env.INTERNAL_SHEET_ID || '';

// --- Config ---

export async function readAllConfig(): Promise<Record<string, string>> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: INTERNAL_SHEET_ID,
        range: "'config'!A:C",
    });
    const rows = res.data.values || [];
    const config: Record<string, string> = {};
    for (let i = 1; i < rows.length; i++) {
        if (rows[i]?.[0]) config[rows[i][0]] = rows[i]?.[1] ?? '';
    }
    return config;
}

export async function writeConfigKV(key: string, value: string): Promise<void> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: INTERNAL_SHEET_ID,
        range: "'config'!A:A",
    });
    const keys = res.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i]?.[0] === key) { rowIndex = i + 1; break; }
    }
    const now = new Date().toISOString();
    if (rowIndex > 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: INTERNAL_SHEET_ID,
            range: `'config'!B${rowIndex}:C${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[value, now]] },
        });
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: INTERNAL_SHEET_ID,
            range: "'config'!A:A",
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[key, value, now]] },
        });
    }
}

// --- State ---

export async function readState(): Promise<Record<string, string>> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: INTERNAL_SHEET_ID,
        range: "'state'!A:B",
    });
    const rows = res.data.values || [];
    const state: Record<string, string> = {};
    for (let i = 1; i < rows.length; i++) {
        if (rows[i]?.[0]) state[rows[i][0]] = rows[i]?.[1] ?? '';
    }
    return state;
}

// --- Headers ---

export async function readSheetHeaders(
    spreadsheetId: string,
    sheetName: string,
): Promise<string[]> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!1:1`,
    });
    return (res.data.values?.[0] as string[]) || [];
}

// --- Logs ---

export async function readRunLogs(): Promise<string[][]> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: INTERNAL_SHEET_ID,
        range: "'run_logs'!A:J",
    });
    return res.data.values || [];
}

export async function readRowLogs(): Promise<string[][]> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: INTERNAL_SHEET_ID,
        range: "'row_logs'!A:L",
    });
    return res.data.values || [];
}

export async function readErrors(): Promise<string[][]> {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: INTERNAL_SHEET_ID,
        range: "'errors'!A:G",
    });
    return res.data.values || [];
}
