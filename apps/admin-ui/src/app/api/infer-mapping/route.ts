import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readAllConfig } from '@/lib/sheets-service';
import { createDecipheriv } from 'crypto';

// DB semantic slots
const DB_SLOTS = [
    { slot: 'headline_source', desc: '포스터 제목/헤드라인에 사용할 텍스트' },
    { slot: 'equipment_name', desc: '장비명, 기기명' },
    { slot: 'description', desc: '장비 설명, 용도' },
    { slot: 'price_info', desc: '가격, 비용 정보' },
    { slot: 'contact', desc: '연락처, 담당자' },
    { slot: 'keywords', desc: '키워드, 태그' },
    { slot: 'reference_image_url', desc: '참고 이미지 URL' },
    { slot: 'location', desc: '위치, 장소' },
    { slot: 'availability', desc: '이용가능 여부' },
    { slot: 'category', desc: '카테고리, 분류' },
    { slot: 'specification', desc: '스펙, 사양' },
    { slot: 'manufacturer', desc: '제조사' },
    { slot: 'model_number', desc: '모델명' },
    { slot: 'booking_link', desc: '예약 링크' },
    { slot: 'unmapped', desc: '매핑하지 않음' },
];

const RESULT_SLOTS = [
    { slot: 'poster_url', desc: '포스터 이미지 URL' },
    { slot: 'headline_used', desc: '사용된 헤드라인' },
    { slot: 'summary', desc: '내용 요약' },
    { slot: 'generation_date', desc: '생성 날짜' },
    { slot: 'template_id', desc: '템플릿 ID' },
    { slot: 'json_package', desc: 'JSON 패키지 저장' },
    { slot: 'unmapped', desc: '매핑하지 않음' },
];

export async function POST(request: NextRequest) {
    try {
        const { headers, type } = await request.json();

        // API key 가져오기 (환경변수 직접 사용)
        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (!geminiApiKey) {
            return NextResponse.json(
                { error: 'Gemini API key not configured' },
                { status: 400 }
            );
        }

        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const slots = type === 'db' ? DB_SLOTS : RESULT_SLOTS;
        const slotDescriptions = slots
            .map((s) => `  - "${s.slot}": ${s.desc}`)
            .join('\n');

        const contextDesc = type === 'db'
            ? '의약/연구 장비 대여 서비스의 데이터베이스'
            : '포스터 자동 생성 결과를 저장하는 시트';

        const prompt = `당신은 데이터 분석 전문가입니다.
아래는 Google Sheets의 컬럼 헤더 목록입니다. 이 시트는 ${contextDesc}입니다.

헤더 목록:
${(headers as string[]).map((h: string, i: number) => `  [${i}] "${h}"`).join('\n')}

각 헤더가 아래 semantic slot 중 어떤 것에 해당하는지 추론하세요:
${slotDescriptions}

반드시 아래 JSON 형식으로만 응답하세요:
${type === 'db'
                ? `[{ "headerName": "헤더명", "columnIndex": 0, "inferredSlot": "slot_name", "confidence": 0.9 }]`
                : `{ "strategy": "distributed|json_package|manual", "mappings": [{ "headerName": "헤더명", "columnIndex": 0, "inferredSlot": "slot_name", "confidence": 0.9 }], "jsonPackageColumn": null }`
            }`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return NextResponse.json(parsed);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Inference failed' },
            { status: 500 }
        );
    }
}
