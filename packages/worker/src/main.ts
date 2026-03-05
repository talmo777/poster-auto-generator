/**
 * Worker Main — GitHub Actions에서 실행되는 메인 엔트리포인트
 *
 * 전체 파이프라인:
 * 1. 내부 시트에서 config/state 로드
 * 2. 락 획득 (실패 시 즉시 종료)
 * 3. DB/결과 시트 헤더 변경 감지
 * 4. 배치 단위 포스터 생성 → Drive 업로드 → 결과 시트 기록
 * 5. state 업데이트 + 로그 기록
 * 6. 락 해제
 */

import {
    createSheetsClient,
    createDriveClient,
    readHeaders,
    readRows,
    getLastDataRow,
    readConfigMap,
    configMapToAppConfig,
    writeCells,
    computeHeaderHash,
    detectHeaderChange,
    writeConfigValue,
    selectTemplate,
    POSTER_TEMPLATES,
    generateCopy,
    generatePoster,
    uploadImage,
    logRun,
    logRow,
    logError,
    hashRowData,
    decrypt,
    StateManager,
    PROMPT_VERSION,
} from '@poster/shared';

import type {
    SemanticMapping,
    ResultMappingConfig,
    RowLog,
} from '@poster/shared';

// ============================================================
// Environment
// ============================================================

function getEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Environment variable ${name} is required`);
    }
    return value;
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
    const startedAt = new Date().toISOString();
    console.log(`[Worker] Starting at ${startedAt}`);

    // 1. 환경변수 로드
    const serviceAccountKey = getEnv('GOOGLE_SERVICE_ACCOUNT_KEY');
    const encryptionKeyHex = getEnv('ENCRYPTION_KEY');
    const internalSheetId = getEnv('INTERNAL_SHEET_ID');
    const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');

    // 2. 클라이언트 초기화
    const sheets = createSheetsClient(serviceAccountKey);
    const drive = createDriveClient(serviceAccountKey);
    const stateManager = new StateManager(sheets, internalSheetId);

    // 3. 락 획득
    const lockAcquired = await stateManager.acquireLock();
    if (!lockAcquired) {
        console.log('[Worker] Another instance is running. Exiting.');
        return;
    }

    let runStatus: 'success' | 'partial' | 'failed' = 'success';
    let rowsProcessed = 0;
    let rowsSuccess = 0;
    let rowsFailed = 0;
    let batchRange = '';
    let errorSummary = '';

    try {
        // 4. 설정 로드
        const configMap = await readConfigMap(sheets, internalSheetId);
        const config = configMapToAppConfig(configMap);
        config.internalSpreadsheetId = internalSheetId;

        // Gemini API Key 복호화
        let geminiApiKey: string;
        try {
            geminiApiKey = decrypt(config.geminiApiKeyEncrypted, encryptionKey);
        } catch {
            throw new Error('Failed to decrypt Gemini API key. Check ENCRYPTION_KEY.');
        }

        // 설정 검증
        if (!config.dbSpreadsheetId || !config.dbSheetName) {
            throw new Error('DB sheet not configured. Set db_spreadsheet_id and db_sheet_name in config.');
        }
        if (!config.resultSpreadsheetId || !config.resultSheetName) {
            throw new Error('Result sheet not configured. Set result_spreadsheet_id and result_sheet_name in config.');
        }
        if (!config.driveFolderId) {
            throw new Error('Drive folder not configured. Set drive_folder_id in config.');
        }

        // 5. DB 시트 헤더 변경 감지
        const dbHeaders = await readHeaders(sheets, config.dbSpreadsheetId, config.dbSheetName);
        const dbHeaderHash = computeHeaderHash(dbHeaders);

        if (detectHeaderChange(dbHeaderHash, config.dbHeaderHash)) {
            console.warn('[Worker] DB sheet headers changed! Requires re-mapping in Admin UI.');
            await writeConfigValue(sheets, internalSheetId, 'db_header_hash', dbHeaderHash);
            await writeConfigValue(sheets, internalSheetId, 'header_remapping_needed', 'true');
            throw new Error('DB sheet headers changed. Re-mapping required via Admin UI.');
        }

        // 6. 결과 시트 헤더 변경 감지
        const resultHeaders = await readHeaders(sheets, config.resultSpreadsheetId, config.resultSheetName);
        const resultHeaderHash = computeHeaderHash(resultHeaders);

        if (detectHeaderChange(resultHeaderHash, config.resultHeaderHash)) {
            console.warn('[Worker] Result sheet headers changed! Requires re-mapping in Admin UI.');
            await writeConfigValue(sheets, internalSheetId, 'result_header_hash', resultHeaderHash);
            await writeConfigValue(sheets, internalSheetId, 'header_remapping_needed', 'true');
            throw new Error('Result sheet headers changed. Re-mapping required via Admin UI.');
        }

        // 7. 매핑 로드
        let dbMappings: SemanticMapping[];
        let resultMappingConfig: ResultMappingConfig;
        try {
            dbMappings = JSON.parse(config.dbHeaderMappingJson);
            resultMappingConfig = JSON.parse(config.resultHeaderMappingJson);
        } catch {
            throw new Error('Header mappings not configured or invalid. Complete mapping in Admin UI.');
        }

        if (!dbMappings.length || !resultMappingConfig.mappings?.length) {
            throw new Error('Header mappings are empty. Complete mapping in Admin UI.');
        }

        // 8. 상태 로드 + 배치 계산
        const state = await stateManager.getState();
        const totalRows = await getLastDataRow(sheets, config.dbSpreadsheetId, config.dbSheetName);

        if (totalRows === 0) {
            console.log('[Worker] No data rows found in DB sheet. Exiting.');
            return;
        }

        const batch = stateManager.getNextBatch(state.nextRowIndex, config.batchSize, totalRows);
        batchRange = `${batch.startRow}-${batch.endRow}`;
        console.log(`[Worker] Processing rows ${batchRange} (total: ${totalRows}, cycle: ${state.cycleNumber})`);

        if (batch.endRow < batch.startRow) {
            console.log('[Worker] No rows to process. Exiting.');
            return;
        }

        // 9. 행 읽기
        const { rows } = await readRows(
            sheets,
            config.dbSpreadsheetId,
            config.dbSheetName,
            batch.startRow,
            batch.endRow - batch.startRow + 1,
        );

        // 10. 행별 생성 횟수 조회 (row_logs에서)
        const rowGenCounts = await getRowGenerationCounts(sheets, internalSheetId);

        // Run ID 생성
        const runId = `run_${Date.now()}`;

        // 11. 각 행 처리
        for (let i = 0; i < rows.length; i++) {
            const rowIndex = batch.startRow + i;
            const row = rows[i];
            rowsProcessed++;

            // 빈 행 스킵
            const nonEmptyValues = Object.values(row).filter(v => v && v.trim());
            if (nonEmptyValues.length === 0) {
                console.log(`[Worker] Row ${rowIndex}: Empty, skipping.`);
                await logRow(sheets, internalSheetId, {
                    runId,
                    rowIndex,
                    dbRowHash: '',
                    status: 'skipped',
                    templateId: '',
                    seed: 0,
                    promptVersion: PROMPT_VERSION,
                    posterUrl: '',
                    driveFileId: '',
                    retryCount: 0,
                    errorMessage: 'Empty row',
                    createdAt: new Date().toISOString(),
                });
                continue;
            }

            const dbRowHash = hashRowData(row);
            const rowGenCount = rowGenCounts.get(rowIndex) ?? 0;
            const template = selectTemplate(rowGenCount, POSTER_TEMPLATES);

            try {
                // (a) LLM 카피 생성
                console.log(`[Worker] Row ${rowIndex}: Generating copy with template "${template.name}"...`);
                const copy = await generateCopy(
                    row,
                    dbMappings,
                    config.fixedMessage,
                    template,
                    geminiApiKey,
                );

                // (b) 포스터 이미지 생성
                console.log(`[Worker] Row ${rowIndex}: Generating poster image...`);
                const posterResult = await generatePoster(
                    copy,
                    template,
                    geminiApiKey,
                );

                // (c) Drive 업로드
                const fileName = `poster_row${rowIndex}_cycle${state.cycleNumber}_${Date.now()}.png`;
                console.log(`[Worker] Row ${rowIndex}: Uploading to Drive as "${fileName}"...`);
                const uploadResult = await uploadImage(
                    drive,
                    config.driveFolderId,
                    fileName,
                    posterResult.imageBuffer,
                );

                // (d) 결과 시트에 저장
                await writeResultToSheet(
                    sheets,
                    config.resultSpreadsheetId,
                    config.resultSheetName,
                    resultHeaders,
                    resultMappingConfig,
                    {
                        posterUrl: uploadResult.webViewLink,
                        headlineUsed: copy.headline,
                        summary: copy.subheadline,
                        generationDate: new Date().toISOString(),
                        templateId: template.id,
                        allData: {
                            posterUrl: uploadResult.webViewLink,
                            driveFileId: uploadResult.fileId,
                            headline: copy.headline,
                            subheadline: copy.subheadline,
                            bullets: copy.bullets,
                            cta: copy.cta,
                            templateId: template.id,
                            seed: posterResult.seed,
                            promptVersion: PROMPT_VERSION,
                            generatedAt: new Date().toISOString(),
                        },
                    },
                    rowIndex + 1, // 결과 시트 행 (헤더 포함)
                );

                // (e) 로그 기록
                await logRow(sheets, internalSheetId, {
                    runId,
                    rowIndex,
                    dbRowHash,
                    status: 'success',
                    templateId: template.id,
                    seed: posterResult.seed,
                    promptVersion: PROMPT_VERSION,
                    posterUrl: uploadResult.webViewLink,
                    driveFileId: uploadResult.fileId,
                    retryCount: 0,
                    errorMessage: '',
                    createdAt: new Date().toISOString(),
                });

                rowsSuccess++;
                console.log(`[Worker] Row ${rowIndex}: ✅ Success!`);
            } catch (rowError) {
                rowsFailed++;
                const errMsg = rowError instanceof Error ? rowError.message : String(rowError);
                console.error(`[Worker] Row ${rowIndex}: ❌ Failed - ${errMsg}`);

                await logRow(sheets, internalSheetId, {
                    runId,
                    rowIndex,
                    dbRowHash,
                    status: 'failed',
                    templateId: template.id,
                    seed: 0,
                    promptVersion: PROMPT_VERSION,
                    posterUrl: '',
                    driveFileId: '',
                    retryCount: 0,
                    errorMessage: errMsg,
                    createdAt: new Date().toISOString(),
                });

                await logError(sheets, internalSheetId, {
                    runId,
                    rowIndex,
                    errorType: 'ROW_PROCESSING',
                    errorMessage: errMsg,
                    stackTrace: rowError instanceof Error ? rowError.stack || '' : '',
                    createdAt: new Date().toISOString(),
                });
            }
        }

        // 12. 포인터 전진
        await stateManager.advancePointer(rows.length, totalRows, state);

        runStatus = rowsFailed === 0 ? 'success' : rowsSuccess > 0 ? 'partial' : 'failed';
    } catch (error) {
        runStatus = 'failed';
        errorSummary = error instanceof Error ? error.message : String(error);
        console.error(`[Worker] Fatal error: ${errorSummary}`);

        await logError(sheets, internalSheetId, {
            runId: `run_${Date.now()}`,
            rowIndex: -1,
            errorType: 'FATAL',
            errorMessage: errorSummary,
            stackTrace: error instanceof Error ? error.stack || '' : '',
            createdAt: new Date().toISOString(),
        });
    } finally {
        // 13. 실행 로그 기록
        const finishedAt = new Date().toISOString();
        const state = await stateManager.getState();
        await logRun(sheets, internalSheetId, {
            startedAt,
            finishedAt,
            status: runStatus,
            rowsProcessed,
            rowsSuccess,
            rowsFailed,
            cycle: state.cycleNumber,
            batchRange,
            errorSummary,
        });

        // 14. 락 해제
        await stateManager.releaseLock();
        console.log(`[Worker] Finished at ${finishedAt}. Status: ${runStatus}`);
    }
}

// ============================================================
// Helpers
// ============================================================

/**
 * row_logs에서 행별 생성 횟수 집계
 */
async function getRowGenerationCounts(
    sheets: ReturnType<typeof createSheetsClient>,
    spreadsheetId: string,
): Promise<Map<number, number>> {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: "'row_logs'!B:D",  // rowIndex, dbRowHash, status
        });
        const rows = res.data.values || [];
        const counts = new Map<number, number>();

        for (let i = 1; i < rows.length; i++) {
            const rowIndex = parseInt(rows[i]?.[0], 10);
            const status = rows[i]?.[2];
            if (!isNaN(rowIndex) && status === 'success') {
                counts.set(rowIndex, (counts.get(rowIndex) ?? 0) + 1);
            }
        }
        return counts;
    } catch {
        return new Map();
    }
}

/**
 * 결과 시트에 결과 저장 (3단계 전략)
 */
async function writeResultToSheet(
    sheets: ReturnType<typeof createSheetsClient>,
    spreadsheetId: string,
    sheetName: string,
    headers: string[],
    mappingConfig: ResultMappingConfig,
    resultData: {
        posterUrl: string;
        headlineUsed: string;
        summary: string;
        generationDate: string;
        templateId: string;
        allData: Record<string, unknown>;
    },
    targetRow: number,
): Promise<void> {
    const colValuePairs: { col: number; value: string }[] = [];

    if (mappingConfig.strategy === 'distributed') {
        // 전략 1: 분산 저장
        for (const mapping of mappingConfig.mappings) {
            const slot = mapping.confirmedSlot || mapping.inferredSlot;
            if (slot === 'unmapped') continue;

            let value = '';
            switch (slot) {
                case 'poster_url':
                    value = resultData.posterUrl;
                    break;
                case 'headline_used':
                    value = resultData.headlineUsed;
                    break;
                case 'summary':
                    value = resultData.summary;
                    break;
                case 'generation_date':
                    value = resultData.generationDate;
                    break;
                case 'template_id':
                    value = resultData.templateId;
                    break;
            }

            if (value) {
                colValuePairs.push({ col: mapping.columnIndex, value });
            }
        }
    } else if (mappingConfig.strategy === 'json_package') {
        // 전략 2: JSON 패키지
        const jsonCol = mappingConfig.mappings.find(
            m => (m.confirmedSlot || m.inferredSlot) === 'json_package'
        );
        if (jsonCol) {
            colValuePairs.push({
                col: jsonCol.columnIndex,
                value: JSON.stringify(resultData.allData),
            });
        }
    }

    if (colValuePairs.length > 0) {
        await writeCells(sheets, spreadsheetId, sheetName, targetRow, colValuePairs);
    }
}

// ============================================================
// Entry Point
// ============================================================

main().catch((error) => {
    console.error('[Worker] Unhandled error:', error);
    process.exit(1);
});
