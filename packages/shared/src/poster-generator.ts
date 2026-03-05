/**
 * Poster Generator
 *
 * 템플릿 + 카피 → Gemini 이미지 생성 API로 포스터 이미지 생성.
 * 실패 시 최대 2회 재생성, seed 기록.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { PosterCopy, PosterTemplate, PosterResult } from './types.js';
import { PROMPT_VERSION } from './copy-generator.js';

const MAX_RETRIES = 2;

/**
 * 랜덤 시드 생성 (추적용)
 */
export function generateSeed(): number {
    return Math.floor(Math.random() * 2147483647);
}

/**
 * 포스터 이미지 생성
 */
export async function generatePoster(
    copy: PosterCopy,
    template: PosterTemplate,
    geminiApiKey: string,
    seed?: number,
): Promise<PosterResult> {
    const actualSeed = seed ?? generateSeed();

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        generationConfig: {
            // @ts-expect-error - responseModalities is supported but not in types
            responseModalities: ['image', 'text'],
        },
    });

    const prompt = buildImagePrompt(copy, template, actualSeed);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            const response = result.response;
            const candidates = response.candidates;

            if (!candidates || candidates.length === 0) {
                throw new Error('No candidates in response');
            }

            // 이미지 파트 추출
            for (const part of candidates[0].content.parts) {
                if (part.inlineData) {
                    const imageBuffer = Buffer.from(part.inlineData.data!, 'base64');
                    return {
                        imageBuffer,
                        copy,
                        templateId: template.id,
                        seed: actualSeed,
                        promptVersion: PROMPT_VERSION,
                    };
                }
            }

            throw new Error('No image data in response');
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(
                `[PosterGenerator] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError.message}`
            );

            if (attempt < MAX_RETRIES) {
                // 재시도 전 짧은 대기
                await sleep(2000 * (attempt + 1));
            }
        }
    }

    throw new Error(
        `Poster generation failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`
    );
}

function buildImagePrompt(
    copy: PosterCopy,
    template: PosterTemplate,
    seed: number,
): string {
    const dimensions = template.aspectRatio === '4:5'
        ? '1080x1350 pixels'
        : '1080x1920 pixels';

    const bulletsText = copy.bullets.map((b, i) => `  ${i + 1}. ${b}`).join('\n');

    return `Generate a professional promotional poster image for a medical research equipment rental service.

DESIGN SPECIFICATIONS:
- Dimensions: ${dimensions} (aspect ratio ${template.aspectRatio})
- Style: ${template.promptStyle}
- Color scheme: Primary ${template.colorScheme.primary}, Secondary ${template.colorScheme.secondary}, Accent ${template.colorScheme.accent}, Background ${template.colorScheme.background}
- Layout type: ${template.layout}
- Overall feel: Premium B2B medical/pharmaceutical research institution

TEXT CONTENT TO INCLUDE ON THE POSTER:
- Main headline: "${copy.headline}"
- Subheadline: "${copy.subheadline}"
- Key features:
${bulletsText}
- Call to action: "${copy.cta}"
- Additional info: "${copy.supplementary}"

CRITICAL RULES:
1. All text MUST be clearly readable and NOT cut off
2. Use Korean text as provided above
3. Maintain generous margins and padding
4. Typography must be clean and professional
5. Do NOT include any text that is not listed above
6. The poster should look like it was designed by a professional graphic designer
7. Include subtle design elements (geometric shapes, gradients, icons) appropriate for medical/research context
8. Random variation seed: ${seed}

Generate the poster image now.`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
