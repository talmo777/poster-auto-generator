/**
 * Worker Main — GitHub Actions에서 실행되는 메인 엔트리포인트
 *
 * 전체 파이프라인:
 * 1. 내부 시트에서 config/state 로드
 * 2. 락 획득 (실패 시 즉시 종료)
 * 3. DB/결과 시트 헤더 변경 감지
 * 4. 배치 단위 포스터 생성 → Cloudinary 업로드 → 결과 시트 기록(append-only)
 * 5. state 업데이트 + 로그 기록
 * 6. 락 해제
 */

import {
  createSheetsClient,
  readHeaders,
  readRows,
  getLastDataRow,
  readConfigMap,
  configMapToAppConfig,
  writeCells,
  computeHeaderHash,
  writeConfigValue,
  selectTemplate,
  POSTER_TEMPLATES,
  generateCopy,
  generatePoster,
  logRun,
  logRow,
  logError,
  hashRowData,
  StateManager,
  PROMPT_VERSION,
} from '@poster/shared';

import type { SemanticMapping, ResultMappingConfig } from '@poster/shared';
import { uploadPosterToCloudinary } from './cloudinary-upload.js';

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
// Helpers (Append-only writing)
// ============================================================

function columnLetter(col1Based: number): string {
  let temp = col1Based;
  let letter = '';
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

async function getNextAppendRowByColumn(
  sheets: ReturnType<typeof createSheetsClient>,
  spreadsheetId: string,
  sheetName: string,
  anchorCol0Based: number,
): Promise<number> {
  const col = columnLetter(anchorCol0Based + 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!${col}:${col}`,
  });

  const values = res.data.values || [];
  let lastSheetRowWithData = 1; // 헤더 행

  for (let i = 1; i < values.length; i++) {
    const v = values[i]?.[0];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      lastSheetRowWithData = i + 1;
    }
  }

  return lastSheetRowWithData + 1;
}

async function getRowGenerationCounts(
  sheets: ReturnType<typeof createSheetsClient>,
  spreadsheetId: string,
): Promise<Map<number, number>> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'row_logs'!B:D",
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

async function writeResultToSheet(
  sheets: ReturnType<typeof createSheetsClient>,
  spreadsheetId: string,
  sheetName: string,
  _headers: string[],
  mappingConfig: ResultMappingConfig,
  resultData: {
    posterUrl: string;
    headlineUsed: string;
    summary: string;
    generationDate: string;
    templateId: string;
    allData: Record<string, unknown>;
  },
): Promise<number> {
  const colValuePairs: { col: number; value: string }[] = [];

  if (mappingConfig.strategy === 'distributed') {
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
        default:
          value = '';
      }

      if (value) {
        colValuePairs.push({ col: mapping.columnIndex, value });
      }
    }
  } else if (mappingConfig.strategy === 'json_package') {
    const jsonCol = mappingConfig.mappings.find(
      (m) => (m.confirmedSlot || m.inferredSlot) === 'json_package',
    );
    if (jsonCol) {
      colValuePairs.push({
        col: jsonCol.columnIndex,
        value: JSON.stringify(resultData.allData),
      });
    }
  }

  if (colValuePairs.length === 0) return -1;

  const anchorCol = Math.min(...colValuePairs.map((x) => x.col));
  const targetRow = await getNextAppendRowByColumn(
    sheets,
    spreadsheetId,
    sheetName,
    anchorCol,
  );

  await writeCells(sheets, spreadsheetId, sheetName, targetRow, colValuePairs);
  return targetRow;
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[Worker] Starting at ${startedAt}`);

  const serviceAccountKey = getEnv('GOOGLE_SERVICE_ACCOUNT_KEY');
  const internalSheetId = getEnv('INTERNAL_SHEET_ID');
  const geminiApiKey = getEnv('GEMINI_API_KEY');

  // Cloudinary env 존재 여부를 시작 시점에 미리 확인
  getEnv('CLOUDINARY_CLOUD_NAME');
  getEnv('CLOUDINARY_API_KEY');
  getEnv('CLOUDINARY_API_SECRET');

  const sheets = createSheetsClient(serviceAccountKey);
  const stateManager = new StateManager(sheets, internalSheetId);

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

  const runId = `run_${Date.now()}`;

  try {
    const configMap = await readConfigMap(sheets, internalSheetId);
    const config = configMapToAppConfig(configMap);
    config.internalSpreadsheetId = internalSheetId;

    if (!config.dbSpreadsheetId || !config.dbSheetName) {
      throw new Error(
        'DB sheet not configured. Set db_spreadsheet_id and db_sheet_name in config.',
      );
    }
    if (!config.resultSpreadsheetId || !config.resultSheetName) {
      throw new Error(
        'Result sheet not configured. Set result_spreadsheet_id and result_sheet_name in config.',
      );
    }

    // ============================================================
    // 헤더 해시 처리
    // - 최초 실행: hash 저장 후 진행
    // - 이후 실제 변경: remapping 필요 상태로 전환 후 중단
    // ============================================================

    const dbHeaders = await readHeaders(sheets, config.dbSpreadsheetId, config.dbSheetName);
    const dbHeaderHash = computeHeaderHash(dbHeaders);

    if (!config.dbHeaderHash) {
      console.log('[Worker] DB header hash not set. Initializing db_header_hash and continuing.');
      await writeConfigValue(sheets, internalSheetId, 'db_header_hash', dbHeaderHash);
      await writeConfigValue(sheets, internalSheetId, 'header_remapping_needed', 'false');
    } else if (dbHeaderHash !== config.dbHeaderHash) {
      console.warn('[Worker] DB sheet headers changed! Requires re-mapping in Admin UI.');
      await writeConfigValue(sheets, internalSheetId, 'db_header_hash', dbHeaderHash);
      await writeConfigValue(sheets, internalSheetId, 'header_remapping_needed', 'true');
      throw new Error('DB sheet headers changed. Re-mapping required via Admin UI.');
    }

    const resultHeaders = await readHeaders(
      sheets,
      config.resultSpreadsheetId,
      config.resultSheetName,
    );
    const resultHeaderHash = computeHeaderHash(resultHeaders);

    if (!config.resultHeaderHash) {
      console.log(
        '[Worker] Result header hash not set. Initializing result_header_hash and continuing.',
      );
      await writeConfigValue(sheets, internalSheetId, 'result_header_hash', resultHeaderHash);
      await writeConfigValue(sheets, internalSheetId, 'header_remapping_needed', 'false');
    } else if (resultHeaderHash !== config.resultHeaderHash) {
      console.warn('[Worker] Result sheet headers changed! Requires re-mapping in Admin UI.');
      await writeConfigValue(sheets, internalSheetId, 'result_header_hash', resultHeaderHash);
      await writeConfigValue(sheets, internalSheetId, 'header_remapping_needed', 'true');
      throw new Error('Result sheet headers changed. Re-mapping required via Admin UI.');
    }

    let dbMappings: SemanticMapping[];
    let resultMappingConfig: ResultMappingConfig;
    try {
      dbMappings = JSON.parse(config.dbHeaderMappingJson);
      resultMappingConfig = JSON.parse(config.resultHeaderMappingJson);
    } catch {
      throw new Error(
        'Header mappings not configured or invalid. Complete mapping in Admin UI.',
      );
    }

    if (!dbMappings.length || !resultMappingConfig.mappings?.length) {
      throw new Error('Header mappings are empty. Complete mapping in Admin UI.');
    }

    const state = await stateManager.getState();
    const totalRows = await getLastDataRow(sheets, config.dbSpreadsheetId, config.dbSheetName);

    if (totalRows === 0) {
      console.log('[Worker] No data rows found in DB sheet. Exiting.');
      return;
    }

    const batch = stateManager.getNextBatch(state.nextRowIndex, config.batchSize, totalRows);
    batchRange = `${batch.startRow}-${batch.endRow}`;
    console.log(
      `[Worker] Processing rows ${batchRange} (total: ${totalRows}, cycle: ${state.cycleNumber})`,
    );

    if (batch.endRow < batch.startRow) {
      console.log('[Worker] No rows to process. Exiting.');
      return;
    }

    const { rows } = await readRows(
      sheets,
      config.dbSpreadsheetId,
      config.dbSheetName,
      batch.startRow,
      batch.endRow - batch.startRow + 1,
    );

    const rowGenCounts = await getRowGenerationCounts(sheets, internalSheetId);

    for (let i = 0; i < rows.length; i++) {
      const rowIndex = batch.startRow + i;
      const row = rows[i];
      rowsProcessed++;

      const nonEmptyValues = Object.values(row).filter((v) => v && v.trim());
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
        console.log(`[Worker] Row ${rowIndex}: Generating copy with template "${template.name}"...`);
        const copy = await generateCopy(
          row,
          dbMappings,
          config.fixedMessage,
          template,
          geminiApiKey,
        );

        console.log(`[Worker] Row ${rowIndex}: Generating poster image...`);
        const posterResult = await generatePoster(copy, template, geminiApiKey);

        const fileName = `poster_row${rowIndex}_cycle${state.cycleNumber}_${Date.now()}.png`;

        console.log(`[Worker] Row ${rowIndex}: Uploading to Cloudinary as "${fileName}"...`);
        const uploadResult = await uploadPosterToCloudinary(
          posterResult.imageBuffer,
          fileName,
        );

        await writeResultToSheet(
          sheets,
          config.resultSpreadsheetId,
          config.resultSheetName,
          resultHeaders,
          resultMappingConfig,
          {
            posterUrl: uploadResult.secureUrl,
            headlineUsed: copy.headline,
            summary: copy.subheadline,
            generationDate: new Date().toISOString(),
            templateId: template.id,
            allData: {
              posterUrl: uploadResult.secureUrl,
              cloudinaryPublicId: uploadResult.publicId,
              cloudinaryAssetId: uploadResult.assetId,
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
        );

        await logRow(sheets, internalSheetId, {
          runId,
          rowIndex,
          dbRowHash,
          status: 'success',
          templateId: template.id,
          seed: posterResult.seed,
          promptVersion: PROMPT_VERSION,
          posterUrl: uploadResult.secureUrl,
          driveFileId: uploadResult.publicId, // 기존 필드 재사용
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

    await stateManager.advancePointer(rows.length, totalRows, state);

    runStatus = rowsFailed === 0 ? 'success' : rowsSuccess > 0 ? 'partial' : 'failed';
  } catch (error) {
    runStatus = 'failed';
    errorSummary = error instanceof Error ? error.message : String(error);
    console.error(`[Worker] Fatal error: ${errorSummary}`);

    await logError(sheets, internalSheetId, {
      runId,
      rowIndex: -1,
      errorType: 'FATAL',
      errorMessage: errorSummary,
      stackTrace: error instanceof Error ? error.stack || '' : '',
      createdAt: new Date().toISOString(),
    });
  } finally {
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

    await stateManager.releaseLock();
    console.log(`[Worker] Finished at ${finishedAt}. Status: ${runStatus}`);
  }
}

main().catch((error) => {
  console.error('[Worker] Unhandled error:', error);
  process.exit(1);
});
