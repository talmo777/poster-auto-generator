import { NextRequest, NextResponse } from 'next/server';
import { readSheetHeaders } from '@/lib/sheets-service';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const spreadsheetId = searchParams.get('spreadsheetId');
        const sheetName = searchParams.get('sheetName');

        if (!spreadsheetId || !sheetName) {
            return NextResponse.json(
                { error: 'spreadsheetId and sheetName are required' },
                { status: 400 }
            );
        }

        const headers = await readSheetHeaders(spreadsheetId, sheetName);
        return NextResponse.json(headers);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
