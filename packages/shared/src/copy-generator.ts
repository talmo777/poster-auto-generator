/**
 * Copy Generator
 *
 * DB 행 데이터 + 매핑 + 고정문구로부터
 * LLM(Gemini)을 사용해 포스터용 카피 생성.
 *
 * 정보 부족 시에도 가능한 범위에서 생성.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { PosterCopy, PosterTemplate, SemanticMapping } from './types.js';
import { extractPosterMaterials } from './header-inference.js';

export const PROMPT_VERSION = '1.0.0';

/**
 * 포스터용 카피 생성
 */
export async function generateCopy(
    rowData: Record<string, string>,
    mappings: SemanticMapping[],
    fixedMessage: string,
    template: PosterTemplate,
    geminiApiKey: string,
): Promise<PosterCopy> {
    const materials = extractPosterMaterials(rowData, mappings);

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = buildCopyPrompt(materials, fixedMessage, template);
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr) as PosterCopy;

    // 텍스트 길이 제한 적용 (포스터 잘림 방지)
    return sanitizeCopy(parsed);
}

function buildCopyPrompt(
    materials: Record<string, string>,
    fixedMessage: string,
    template: PosterTemplate,
): string {
    const materialEntries = Object.entries(materials)
        .map(([slot, value]) => `  - ${slot}: "${value}"`)
        .join('\n');

    const hasEquipmentName = !!materials['equipment_name'];
    const hasDescription = !!materials['description'];

    let infoNote = '';
    if (!hasEquipmentName && !hasDescription) {
        infoNote = `\n참고: 장비명이나 설명이 명시되지 않았습니다. 주어진 정보를 최대한 활용하고, 고정문구와 센터 정보로 보완하여 전문적인 카피를 작성하세요.`;
    }

    return `당신은 의약/연구기관 B2B 마케팅 카피라이터입니다.
아래 정보를 바탕으로 고급 실험장비/실험실 대여 홍보 포스터의 카피를 작성하세요.

포스터 디자인 테마: "${template.name}" (${template.layout} 레이아웃)
컬러 톤: ${template.colorScheme.primary} 기반

사용 가능한 데이터:
${materialEntries || '  (데이터 없음 - 고정문구와 센터 기본 정보만 사용)'}

고정문구/브랜드 메시지:
  "${fixedMessage || '한양맞춤의약연구센터 - 첨단 연구장비 공동활용 서비스'}"
${infoNote}

작성 규칙:
1. headline: 최대 25자. 임팩트 있는 한 줄 (장비명이 있으면 포함)
2. subheadline: 최대 40자. 부연 설명
3. bullets: 핵심 특징 2~4개, 각 최대 20자
4. cta: 행동 유도 문구 (예: "지금 문의하세요", "예약 바로가기"), 최대 15자
5. supplementary: 추가 정보 문구 (위치, 연락처 등), 최대 50자
6. 전문적이고 신뢰감 있는 톤 유지
7. 한국어로 작성

반드시 아래 JSON 형식으로만 응답하세요:
{
  "headline": "...",
  "subheadline": "...",
  "bullets": ["...", "..."],
  "cta": "...",
  "supplementary": "..."
}`;
}

/**
 * 텍스트 길이 제한 (포스터 잘림 방지)
 */
function sanitizeCopy(copy: PosterCopy): PosterCopy {
    return {
        headline: truncate(copy.headline, 30),
        subheadline: truncate(copy.subheadline, 50),
        bullets: (copy.bullets || []).slice(0, 4).map(b => truncate(b, 25)),
        cta: truncate(copy.cta, 20),
        supplementary: truncate(copy.supplementary, 60),
    };
}

function truncate(str: string, maxLen: number): string {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
}
