import { NextResponse } from 'next/server';
import { readRunLogs, readRowLogs, readErrors } from '@/lib/sheets-service';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ type: string }> },
) {
    try {
        const { type } = await params;

        if (type === 'runs') {
            const raw = await readRunLogs();
            const logs = raw.slice(1).reverse().map((row) => ({
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
            return NextResponse.json(logs);
        }

        if (type === 'rows') {
            const raw = await readRowLogs();
            const logs = raw.slice(1).reverse().map((row) => ({
                runId: row[0] || '',
                rowIndex: parseInt(row[1] || '0'),
                dbRowHash: row[2] || '',
                status: row[3] || '',
                templateId: row[4] || '',
                seed: parseInt(row[5] || '0'),
                promptVersion: row[6] || '',
                posterUrl: row[7] || '',
                driveFileId: row[8] || '',
                retryCount: parseInt(row[9] || '0'),
                errorMessage: row[10] || '',
                createdAt: row[11] || '',
            }));
            return NextResponse.json(logs);
        }

        if (type === 'errors') {
            const raw = await readErrors();
            const logs = raw.slice(1).reverse().map((row) => ({
                errorId: row[0] || '',
                runId: row[1] || '',
                rowIndex: parseInt(row[2] || '0'),
                errorType: row[3] || '',
                errorMessage: row[4] || '',
                stackTrace: row[5] || '',
                createdAt: row[6] || '',
            }));
            return NextResponse.json(logs);
        }

        return NextResponse.json({ error: 'Invalid log type' }, { status: 400 });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
