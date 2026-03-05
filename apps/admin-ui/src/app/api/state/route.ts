import { NextResponse } from 'next/server';
import { readState } from '@/lib/sheets-service';

export async function GET() {
    try {
        const state = await readState();
        return NextResponse.json({
            nextRowIndex: parseInt(state['next_row_index'] || '1'),
            cycleNumber: parseInt(state['cycle_number'] || '1'),
            lastRunAt: state['last_run_at'] || '',
            isRunning: state['is_running'] === 'true',
            lockExpiry: state['lock_expiry'] || '',
            totalGenerated: parseInt(state['total_generated'] || '0'),
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
