import { NextRequest, NextResponse } from 'next/server';
import { readAllConfig, writeConfigKV } from '@/lib/sheets-service';

export async function GET() {
    try {
        const config = await readAllConfig();
        return NextResponse.json(config);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const { key, value } = await request.json();
        if (!key) {
            return NextResponse.json({ error: 'key is required' }, { status: 400 });
        }
        await writeConfigKV(key, value);
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
