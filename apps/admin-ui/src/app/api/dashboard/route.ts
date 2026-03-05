import { NextResponse } from 'next/server';
import { readState, readRunLogs, readRowLogs } from '@/lib/sheets-service';

export async function GET() {
    try {
        const state = await readState();
        const runLogsRaw = await readRunLogs();
        const rowLogsRaw = await readRowLogs();

        // Parse run logs (skip header)
        const recentRuns = runLogsRaw.slice(1).slice(-10).reverse().map((row) => ({
            runId: row[0] || '',
            startedAt: row[1] || '',
            finishedAt: row[2] || '',
            status: row[3] || '',
            rowsProcessed: parseInt(row[4] || '0'),
            rowsSuccess: parseInt(row[5] || '0'),
            rowsFailed: parseInt(row[6] || '0'),
            cycle: parseInt(row[7] || '0'),
            batchRange: row[8] || '',
            errorSummary: row[9] || '',
        }));

        // Row generation counts (skip header)
        const rowGenerationCounts: Record<number, number> = {};
        for (let i = 1; i < rowLogsRaw.length; i++) {
            const rowIndex = parseInt(rowLogsRaw[i]?.[1] || '0');
            const status = rowLogsRaw[i]?.[3];
            if (rowIndex && status === 'success') {
                rowGenerationCounts[rowIndex] = (rowGenerationCounts[rowIndex] || 0) + 1;
            }
        }

        return NextResponse.json({
            totalGenerated: parseInt(state['total_generated'] || '0'),
            cycleNumber: parseInt(state['cycle_number'] || '1'),
            nextRowIndex: parseInt(state['next_row_index'] || '1'),
            lastRunAt: state['last_run_at'] || '',
            isRunning: state['is_running'] === 'true',
            recentRuns,
            rowGenerationCounts,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
