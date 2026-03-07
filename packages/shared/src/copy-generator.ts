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

export const PROMPT_VERSION = '2.0.0';

export async function generateCopy(
  rowData: Record<string, string>,
  mappings: SemanticMapping[],
  fixedMessage: string,
  template: PosterTemplate,
  geminiApiKey: string,
): Promise<PosterCopy> {
  const materials = extractPosterMaterials(rowData, mappings);

  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const prompt = buildCopyPrompt(materials, fixedMessage, template);
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(jsonStr) as PosterCopy;

  return sanitizeCopy(parsed, materials);
}

function buildCopyPrompt(
  materials: Record<string, string>,
  fixedMessage: string,
  template: PosterTemplate,
): string {
  const materialEntries = Object.entries(materials)
    .map(([slot, value]) => `- ${slot}: "${value}"`)
    .join('\n');

  return `당신은 의약/연구기관 B2B 마케팅 포스터 카피라이터입니다.
아래 정보를 바탕으로 "실제 홍보용 포스터"에 바로 들어갈 짧고 강한 한국어 카피를 작성하세요.

포스터 디자인 테마:
- template_name: "${template.name}"
- layout: "${template.layout}"
- primary_color: "${template.colorScheme.primary}"
- accent_color: "${template.colorScheme.accent}"

사용 가능한 데이터:
${materialEntries || '- 데이터 없음'}

고정문구/브랜드 메시지:
"${fixedMessage || '한양맞춤의약연구센터 - 첨단 연구장비 공동활용 서비스'}"

목표:
- 외부 연구자/기업/기관 담당자가 포스터를 보고
- 장비의 핵심 가치와 신청 유도를 즉시 이해하도록 작성

엄격한 작성 규칙:
1. headline: 12~28자. 장비명 또는 핵심 가치를 가장 먼저 드러낼 것
2. subheadline: 20~48자. 어떤 연구/분석/활용에 유리한지 한 문장
3. bullets: 정확히 3개. 각 8~20자. 포스터용 핵심 베네핏만
4. cta: 8~18자. 신청 유도 문구
5. supplementary: 18~55자. 예약/이용/운영 관련 짧은 보조 문구
6. 절대 금지:
   - 말줄임표(...)
   - 장문 문단
   - 과장된 감탄 표현
   - 같은 뜻 반복
   - 너무 긴 전문용어 나열
7. 문장은 포스터에 들어가는 문구답게 짧고 단단하게 작성
8. booking_link, reference_image_url 같은 URL 자체는 카피에 직접 노출하지 말 것

반드시 아래 JSON만 출력:
{
  "headline": "...",
  "subheadline": "...",
  "bullets": ["...", "...", "..."],
  "cta": "...",
  "supplementary": "..."
}`;
}

function sanitizeCopy(copy: PosterCopy, materials: Record<string, string>): PosterCopy {
  const fallbackHeadline =
    firstNonEmpty([
      copy.headline,
      materials.equipment_name,
      materials.headline_source,
      '첨단 연구장비 공동활용',
    ]) ?? '첨단 연구장비 공동활용';

  const fallbackSubheadline =
    firstNonEmpty([
      copy.subheadline,
      materials.description,
      '연구 지원을 위한 전문 장비 이용 안내',
    ]) ?? '연구 지원을 위한 전문 장비 이용 안내';

  const fallbackBullets = buildFallbackBullets(materials);
  const cleanBullets = (copy.bullets || [])
    .map((item) => normalizeInlineText(item))
    .filter(Boolean)
    .slice(0, 3);

  while (cleanBullets.length < 3) {
    const next = fallbackBullets[cleanBullets.length];
    if (!next) break;
    cleanBullets.push(next);
  }

  const cta = firstNonEmpty([
    normalizeInlineText(copy.cta),
    materials.booking_link ? '온라인 예약 신청' : '장비 이용 문의',
  ]) ?? '장비 이용 문의';

  const supplementary = firstNonEmpty([
    normalizeInlineText(copy.supplementary),
    buildSupplementaryFallback(materials),
  ]) ?? '센터 홈페이지에서 상세 정보와 이용 절차를 확인하세요.';

  return {
    headline: limitText(normalizeInlineText(fallbackHeadline), 28),
    subheadline: limitText(normalizeInlineText(fallbackSubheadline), 48),
    bullets: cleanBullets.map((item) => limitText(item, 20)).slice(0, 3),
    cta: limitText(normalizeInlineText(cta), 18),
    supplementary: limitText(normalizeInlineText(supplementary), 55),
  };
}

function buildFallbackBullets(materials: Record<string, string>): string[] {
  const candidates = [
    materials.specification,
    materials.keywords,
    materials.category,
    materials.availability,
    materials.manufacturer ? `${materials.manufacturer} 장비` : '',
    materials.model_number ? `모델 ${materials.model_number}` : '',
    materials.location ? `${materials.location} 설치` : '',
    materials.price_info ? '요금 정보 별도 확인' : '',
  ]
    .map((item) => normalizeInlineText(item))
    .filter(Boolean);

  const unique: string[] = [];
  for (const item of candidates) {
    const compact = limitText(item, 20);
    if (compact && !unique.includes(compact)) {
      unique.push(compact);
    }
    if (unique.length >= 3) break;
  }

  while (unique.length < 3) {
    const defaultPool = ['전문 연구 지원', '센터 공동활용 가능', '상세 조건 별도 안내'];
    const candidate = defaultPool[unique.length];
    if (!unique.includes(candidate)) {
      unique.push(candidate);
    } else {
      break;
    }
  }

  return unique.slice(0, 3);
}

function buildSupplementaryFallback(materials: Record<string, string>): string {
  const parts = [
    materials.location ? `${normalizeInlineText(materials.location)} 설치` : '',
    materials.contact ? `문의 ${normalizeInlineText(materials.contact)}` : '',
    materials.price_info ? '이용료는 별도 안내됩니다.' : '',
    materials.booking_link ? '센터 홈페이지에서 예약 가능합니다.' : '센터 문의 후 이용 가능합니다.',
  ].filter(Boolean);

  return parts.join(' / ');
}

function normalizeInlineText(value?: string): string {
  if (!value) return '';
  return value
    .replace(/\s+/g, ' ')
    .replace(/[•·▪■□▶▷◆◇★☆]/g, ' ')
    .replace(/\.\.\.+/g, ' ')
    .replace(/…+/g, ' ')
    .replace(/\s+\|\s+/g, ' / ')
    .trim();
}

function limitText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  const sliced = value.slice(0, maxLen).trim();
  return sliced.replace(/[,\-/:;]$/, '').trim();
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => !!value && value.trim().length > 0);
}
