import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs'; // ✅ Edge 런타임 방지(googleapis/crypto류 이슈 회피)

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

function extractJson(text: string): string {
  // ```json ... ``` 코드블록 제거
  const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();

  // 그대로 JSON이면 그대로
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) return cleaned;

  // 텍스트 중간에 JSON이 섞인 경우: 첫 {..} 또는 [..] 블록 추출
  const obj = cleaned.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];

  const arr = cleaned.match(/\[[\s\S]*\]/);
  if (arr) return arr[0];

  return cleaned;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const headers = body?.headers as string[] | undefined;
    const type = body?.type as 'db' | 'result' | undefined;

    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      return NextResponse.json({ error: 'headers is required' }, { status: 400 });
    }
    if (type !== 'db' && type !== 'result') {
      return NextResponse.json({ error: 'type must be "db" or "result"' }, { status: 400 });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 400 });
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);

    // 모델명은 환경/계정에 따라 막히면 gemini-1.5-flash로 내려도 됨
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    });

    const slots = type === 'db' ? DB_SLOTS : RESULT_SLOTS;
    const slotDescriptions = slots.map((s) => `- "${s.slot}": ${s.desc}`).join('\n');

    const contextDesc =
      type === 'db'
        ? '의약/연구 장비 대여 서비스의 데이터베이스 시트'
        : '포스터 자동 생성 결과를 저장하는 결과 시트';

    const prompt =
      `당신은 데이터 분석 전문가입니다.\n` +
      `아래는 Google Sheets의 컬럼 헤더 목록입니다. 이 시트는 ${contextDesc}입니다.\n\n` +
      `헤더 목록:\n` +
      headers.map((h, i) => `  [${i}] "${h}"`).join('\n') +
      `\n\n각 헤더가 아래 semantic slot 중 어떤 것에 해당하는지 추론하세요:\n` +
      slotDescriptions +
      `\n\n반드시 JSON만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.\n` +
      (type === 'db'
        ? `출력 형식: [{"headerName":"...","columnIndex":0,"inferredSlot":"slot_name","confidence":0.9}]\n`
        : `출력 형식: {"strategy":"distributed|json_package","mappings":[{"headerName":"...","columnIndex":0,"inferredSlot":"slot_name","confidence":0.9}]}\n`);

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonStr = extractJson(text);
    const parsed = JSON.parse(jsonStr);

    return NextResponse.json(parsed);
  } catch (error) {
    console.error('[infer-mapping] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Inference failed' },
      { status: 500 },
    );
  }
}
