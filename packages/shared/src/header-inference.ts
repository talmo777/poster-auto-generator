/**
 * Header Inference Engine
 *
 * "헤더 강제 0" 원칙의 핵심 모듈.
 * LLM(Gemini)으로 시트 헤더의 의미를 추론하고,
 * 관리자 확정 후 매핑을 저장/검증/변경 감지.
 */

import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
    SemanticMapping,
    ResultMapping,
    DbSemanticSlot,
    ResultSemanticSlot,
    ResultMappingConfig,
    ResultSaveStrategy,
} from './types.js';

// ============================================================
// Semantic Slot Definitions
// ============================================================

export const DB_SEMANTIC_SLOTS: { slot: DbSemanticSlot; description: string }[] = [
    { slot: 'headline_source', description: '포스터 제목/헤드라인에 사용할 텍스트' },
    { slot: 'equipment_name', description: '장비명, 기기명, 실험기기 이름' },
    { slot: 'description', description: '장비 설명, 용도, 기능 상세' },
    { slot: 'price_info', description: '가격, 비용, 이용료, 수가 정보' },
    { slot: 'contact', description: '연락처, 담당자, 전화번호, 이메일' },
    { slot: 'keywords', description: '키워드, 태그, 분류 키워드' },
    { slot: 'reference_image_url', description: '참고 이미지 URL, 장비 사진 링크' },
    { slot: 'location', description: '위치, 장소, 실험실 번호, 건물명' },
    { slot: 'availability', description: '이용가능 여부, 예약 상태, 운영 시간' },
    { slot: 'category', description: '카테고리, 분류, 종류' },
    { slot: 'specification', description: '스펙, 사양, 기술 정보' },
    { slot: 'manufacturer', description: '제조사, 브랜드, 메이커' },
    { slot: 'model_number', description: '모델명, 모델번호, 제품번호' },
    { slot: 'booking_link', description: '예약 링크, 신청 URL, 문의 폼' },
    { slot: 'unmapped', description: '매핑하지 않음 (사용하지 않을 컬럼)' },
];

export const RESULT_SEMANTIC_SLOTS: { slot: ResultSemanticSlot; description: string }[] = [
    { slot: 'poster_url', description: '생성된 포스터 이미지 URL/링크' },
    { slot: 'headline_used', description: '포스터에 사용된 헤드라인 텍스트' },
    { slot: 'summary', description: '포스터 내용 요약' },
    { slot: 'generation_date', description: '생성 날짜/생성일' },
    { slot: 'template_id', description: '사용된 템플릿 ID' },
    { slot: 'json_package', description: 'JSON 패키지로 전체 결과 저장 (범용 컬럼)' },
    { slot: 'unmapped', description: '매핑하지 않음' },
];

// ============================================================
// Header Hash (변경 감지)
// ============================================================

/**
 * 헤더 배열의 SHA-256 해시값 생성
 */
export function computeHeaderHash(headers: string[]): string {
    const normalized = headers.map(h => h.trim().toLowerCase()).join('|');
    return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 헤더 변경 감지
 */
export function detectHeaderChange(currentHash: string, storedHash: string): boolean {
    if (!storedHash) return true; // 최초 실행
    return currentHash !== storedHash;
}

// ============================================================
// LLM-based Header Inference
// ============================================================

/**
 * DB 시트 헤더의 의미를 Gemini로 추론
 */
export async function inferDbMapping(
    headers: string[],
    geminiApiKey: string,
): Promise<SemanticMapping[]> {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const slotDescriptions = DB_SEMANTIC_SLOTS
        .map(s => `  - "${s.slot}": ${s.description}`)
        .join('\n');

    const prompt = `당신은 데이터 분석 전문가입니다. 
아래는 Google Sheets의 컬럼 헤더 목록입니다. 이 시트는 의약/연구 장비 대여 서비스의 데이터베이스입니다.

헤더 목록:
${headers.map((h, i) => `  [${i}] "${h}"`).join('\n')}

아래 semantic slot 중 각 헤더가 어떤 것에 해당하는지 추론하세요:
${slotDescriptions}

규칙:
1. 각 헤더에 대해 가장 적합한 slot 하나를 선택
2. 확신도(confidence)를 0.0~1.0으로 평가
3. 하나의 slot에 여러 헤더가 매핑될 수 있음
4. 어떤 slot에도 맞지 않으면 "unmapped" 선택
5. 한국어/영어/약어 모두 고려

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
[
  { "headerName": "헤더명", "columnIndex": 0, "inferredSlot": "slot_name", "confidence": 0.9 }
]`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // JSON 추출 (코드 블록 마커 제거)
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr) as Array<{
        headerName: string;
        columnIndex: number;
        inferredSlot: DbSemanticSlot;
        confidence: number;
    }>;

    return parsed.map((item) => ({
        headerName: item.headerName,
        columnIndex: item.columnIndex,
        inferredSlot: item.inferredSlot,
        confidence: item.confidence,
        isConfirmed: false,
    }));
}

/**
 * 결과 시트 헤더 매핑 추론 + 저장 전략 결정
 */
export async function inferResultMapping(
    headers: string[],
    geminiApiKey: string,
): Promise<ResultMappingConfig> {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const slotDescriptions = RESULT_SEMANTIC_SLOTS
        .map(s => `  - "${s.slot}": ${s.description}`)
        .join('\n');

    const prompt = `당신은 데이터 분석 전문가입니다.
아래는 Google Sheets의 결과 저장용 시트의 컬럼 헤더 목록입니다.
이 시트에 포스터 자동 생성 결과를 저장해야 합니다.

헤더 목록:
${headers.map((h, i) => `  [${i}] "${h}"`).join('\n')}

결과 데이터 종류:
${slotDescriptions}

아래 3가지 저장 전략 중 하나를 추천하세요:

1. "distributed": 기존 헤더 중 의미적으로 매칭되는 컬럼이 여러 개 있어, 결과를 분산 저장 가능
2. "json_package": 범용 컬럼(비고, 메모, 기타, 내용 등)이 있어, JSON 문자열로 전체 결과를 한 컬럼에 저장
3. "manual": 적절한 컬럼이 없어 관리자가 직접 지정해야 함

반드시 아래 JSON 형식으로만 응답하세요:
{
  "strategy": "distributed" | "json_package" | "manual",
  "mappings": [
    { "headerName": "헤더명", "columnIndex": 0, "inferredSlot": "slot_name", "confidence": 0.9 }
  ],
  "jsonPackageColumn": "비고"  // strategy가 json_package일 때만
}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr) as {
        strategy: ResultSaveStrategy;
        mappings: Array<{
            headerName: string;
            columnIndex: number;
            inferredSlot: ResultSemanticSlot;
            confidence: number;
        }>;
        jsonPackageColumn?: string;
    };

    return {
        strategy: parsed.strategy,
        mappings: parsed.mappings.map((m) => ({
            ...m,
            isConfirmed: false,
        })),
        jsonPackageColumn: parsed.jsonPackageColumn,
    };
}

// ============================================================
// Mapping Validation
// ============================================================

/**
 * 확정된 매핑에서 특정 slot에 해당하는 컬럼 찾기
 */
export function findColumnBySlot(
    mappings: SemanticMapping[],
    slot: DbSemanticSlot,
): SemanticMapping | undefined {
    return mappings.find(
        m => (m.confirmedSlot || m.inferredSlot) === slot && m.isConfirmed
    );
}

/**
 * 확정된 결과 매핑에서 slot에 해당하는 컬럼 찾기
 */
export function findResultColumnBySlot(
    mappings: ResultMapping[],
    slot: ResultSemanticSlot,
): ResultMapping | undefined {
    return mappings.find(
        m => (m.confirmedSlot || m.inferredSlot) === slot && m.isConfirmed
    );
}

/**
 * DB 매핑에서 포스터 생성에 필요한 재료를 최대한 추출
 */
export function extractPosterMaterials(
    row: Record<string, string>,
    mappings: SemanticMapping[],
): Record<string, string> {
    const materials: Record<string, string> = {};

    for (const mapping of mappings) {
        const slot = mapping.confirmedSlot || mapping.inferredSlot;
        if (slot === 'unmapped') continue;

        const value = row[mapping.headerName];
        if (value && value.trim()) {
            // 같은 slot에 여러 컬럼이 매핑될 수 있으므로 합치기
            if (materials[slot]) {
                materials[slot] += ` | ${value.trim()}`;
            } else {
                materials[slot] = value.trim();
            }
        }
    }

    return materials;
}
