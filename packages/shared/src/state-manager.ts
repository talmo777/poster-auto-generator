/**
 * State Manager + Lock
 *
 * 내부 시트의 state 탭을 사용하여 워커 상태 관리 및 동시 실행 방지 락 구현.
 */

import type { sheets_v4 } from 'googleapis';
import type { WorkerState } from './types.js';
import { readState, writeState } from './sheets-client.js';

const DEFAULT_LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15분

export class StateManager {
    private sheets: sheets_v4.Sheets;
    private spreadsheetId: string;

    constructor(sheets: sheets_v4.Sheets, spreadsheetId: string) {
        this.sheets = sheets;
        this.spreadsheetId = spreadsheetId;
    }

    /**
     * 락 획득 시도. 이미 실행 중이면 false 반환.
     * 만료된 락은 자동 해제 후 획득.
     */
    async acquireLock(timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): Promise<boolean> {
        const state = await readState(this.sheets, this.spreadsheetId);

        if (state.isRunning) {
            // 만료 확인
            if (state.lockExpiry) {
                const expiry = new Date(state.lockExpiry).getTime();
                if (Date.now() > expiry) {
                    // 만료된 락 → 강제 해제 후 획득
                    console.warn('[StateManager] Expired lock detected, force releasing...');
                } else {
                    console.warn('[StateManager] Lock is active, cannot acquire.');
                    return false;
                }
            } else {
                console.warn('[StateManager] Lock active with no expiry, cannot acquire.');
                return false;
            }
        }

        // 락 획득
        const lockExpiry = new Date(Date.now() + timeoutMs).toISOString();
        await writeState(this.sheets, this.spreadsheetId, {
            isRunning: true,
            lockExpiry,
        });

        return true;
    }

    /**
     * 락 해제
     */
    async releaseLock(): Promise<void> {
        await writeState(this.sheets, this.spreadsheetId, {
            isRunning: false,
            lockExpiry: '',
        });
    }

    /**
     * 현재 상태 조회
     */
    async getState(): Promise<WorkerState> {
        return readState(this.sheets, this.spreadsheetId);
    }

    /**
     * 다음 처리할 배치 범위 계산
     */
    getNextBatch(
        nextRowIndex: number,
        batchSize: number,
        totalRows: number,
    ): { startRow: number; endRow: number; willCycle: boolean } {
        if (totalRows === 0) {
            return { startRow: 1, endRow: 0, willCycle: false };
        }

        const startRow = nextRowIndex;
        let endRow = startRow + batchSize - 1;
        let willCycle = false;

        if (endRow > totalRows) {
            endRow = totalRows;
            willCycle = true;
        }

        return { startRow, endRow, willCycle };
    }

    /**
     * 포인터 전진 (순환 포함)
     */
    async advancePointer(
        processedCount: number,
        totalRows: number,
        currentState: WorkerState,
    ): Promise<void> {
        let newNextRow = currentState.nextRowIndex + processedCount;
        let newCycle = currentState.cycleNumber;

        if (newNextRow > totalRows) {
            newNextRow = 1;
            newCycle += 1;
        }

        await writeState(this.sheets, this.spreadsheetId, {
            nextRowIndex: newNextRow,
            cycleNumber: newCycle,
            lastRunAt: new Date().toISOString(),
            totalGenerated: currentState.totalGenerated + processedCount,
        });
    }
}
