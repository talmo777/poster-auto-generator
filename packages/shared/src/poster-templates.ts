/**
 * Poster Templates
 *
 * 12종 템플릿 메타데이터 정의. 의약/연구기관 B2B 고급 홍보물 톤.
 * row_generation_count에 따라 로테이션.
 */

import type { PosterTemplate } from './types.js';

export const POSTER_TEMPLATES: PosterTemplate[] = [
    {
        id: 'tmpl_01',
        name: 'Corporate Navy',
        layout: 'centered',
        colorScheme: {
            primary: '#1B2A4A',
            secondary: '#2E4C7D',
            accent: '#4ECDC4',
            background: '#0D1B2A',
            text: '#FFFFFF',
        },
        typography: {
            headlineFont: 'Pretendard Bold',
            bodyFont: 'Pretendard Regular',
            ctaFont: 'Pretendard SemiBold',
        },
        aspectRatio: '4:5',
        promptStyle: 'Professional corporate medical research poster with deep navy blue theme, clean minimal layout, centered text blocks with subtle geometric accents, premium feel',
    },
    {
        id: 'tmpl_02',
        name: 'Lab Gradient',
        layout: 'split',
        colorScheme: {
            primary: '#667EEA',
            secondary: '#764BA2',
            accent: '#F093FB',
            background: '#1A1A2E',
            text: '#FFFFFF',
        },
        typography: {
            headlineFont: 'Noto Sans KR Bold',
            bodyFont: 'Noto Sans KR Regular',
            ctaFont: 'Noto Sans KR Medium',
        },
        aspectRatio: '4:5',
        promptStyle: 'Modern laboratory equipment promotional poster with gradient purple-blue theme, split layout with equipment imagery on one side and text on the other, scientific aesthetic',
    },
    {
        id: 'tmpl_03',
        name: 'Clean White',
        layout: 'minimal',
        colorScheme: {
            primary: '#2D3436',
            secondary: '#636E72',
            accent: '#0984E3',
            background: '#FFFFFF',
            text: '#2D3436',
        },
        typography: {
            headlineFont: 'Pretendard Bold',
            bodyFont: 'Pretendard Light',
            ctaFont: 'Pretendard Medium',
        },
        aspectRatio: '4:5',
        promptStyle: 'Clean white minimalist research equipment poster, lots of whitespace, elegant typography with blue accent elements, professional medical aesthetic',
    },
    {
        id: 'tmpl_04',
        name: 'Tech Grid',
        layout: 'grid',
        colorScheme: {
            primary: '#00B894',
            secondary: '#00CEC9',
            accent: '#FDCB6E',
            background: '#0C0C1D',
            text: '#FFFFFF',
        },
        typography: {
            headlineFont: 'Noto Sans KR Black',
            bodyFont: 'Noto Sans KR Regular',
            ctaFont: 'Noto Sans KR Bold',
        },
        aspectRatio: '4:5',
        promptStyle: 'High-tech grid layout poster for scientific equipment, dark background with teal/green glowing grid lines, futuristic research lab atmosphere',
    },
    {
        id: 'tmpl_05',
        name: 'Bio Emerald',
        layout: 'hero',
        colorScheme: {
            primary: '#1E8449',
            secondary: '#27AE60',
            accent: '#F1C40F',
            background: '#0B2B1A',
            text: '#ECFDF5',
        },
        typography: {
            headlineFont: 'Pretendard ExtraBold',
            bodyFont: 'Pretendard Regular',
            ctaFont: 'Pretendard SemiBold',
        },
        aspectRatio: '4:5',
        promptStyle: 'Biotech research poster with emerald green theme, hero image area for equipment visualization, organic molecular patterns in background, premium pharmaceutical aesthetic',
    },
    {
        id: 'tmpl_06',
        name: 'Steel Industrial',
        layout: 'diagonal',
        colorScheme: {
            primary: '#4A5568',
            secondary: '#718096',
            accent: '#ED8936',
            background: '#1A202C',
            text: '#E2E8F0',
        },
        typography: {
            headlineFont: 'Noto Sans KR Bold',
            bodyFont: 'Noto Sans KR Regular',
            ctaFont: 'Noto Sans KR Medium',
        },
        aspectRatio: '4:5',
        promptStyle: 'Industrial scientific equipment poster with steel gray and orange accents, diagonal composition, bold geometric shapes, mechanical precision aesthetic',
    },
    {
        id: 'tmpl_07',
        name: 'Pharma Blue',
        layout: 'centered',
        colorScheme: {
            primary: '#2B6CB0',
            secondary: '#3182CE',
            accent: '#63B3ED',
            background: '#EBF8FF',
            text: '#1A365D',
        },
        typography: {
            headlineFont: 'Pretendard Bold',
            bodyFont: 'Pretendard Regular',
            ctaFont: 'Pretendard SemiBold',
        },
        aspectRatio: '4:5',
        promptStyle: 'Pharmaceutical blue theme poster, light blue background with deep blue text, centered professional layout, trustworthy medical institution aesthetic, clean and authoritative',
    },
    {
        id: 'tmpl_08',
        name: 'Quantum Dark',
        layout: 'split',
        colorScheme: {
            primary: '#7C3AED',
            secondary: '#5B21B6',
            accent: '#A855F7',
            background: '#0F0720',
            text: '#F5F3FF',
        },
        typography: {
            headlineFont: 'Noto Sans KR Black',
            bodyFont: 'Noto Sans KR Light',
            ctaFont: 'Noto Sans KR Bold',
        },
        aspectRatio: '4:5',
        promptStyle: 'Quantum-inspired dark violet poster for advanced research equipment, particle effects and wave patterns, split layout with dramatic lighting, cutting-edge science aesthetic',
    },
    {
        id: 'tmpl_09',
        name: 'Medical Trust',
        layout: 'hero',
        colorScheme: {
            primary: '#065F46',
            secondary: '#047857',
            accent: '#10B981',
            background: '#F0FDF4',
            text: '#064E3B',
        },
        typography: {
            headlineFont: 'Pretendard ExtraBold',
            bodyFont: 'Pretendard Regular',
            ctaFont: 'Pretendard Medium',
        },
        aspectRatio: '4:5',
        promptStyle: 'Medical trust-building poster with soft green palette, hero layout with large equipment image area, clean professional borders, institutional credibility aesthetic',
    },
    {
        id: 'tmpl_10',
        name: 'Innovation Red',
        layout: 'diagonal',
        colorScheme: {
            primary: '#DC2626',
            secondary: '#EF4444',
            accent: '#FCA5A5',
            background: '#1C1917',
            text: '#FAFAF9',
        },
        typography: {
            headlineFont: 'Noto Sans KR Bold',
            bodyFont: 'Noto Sans KR Regular',
            ctaFont: 'Noto Sans KR SemiBold',
        },
        aspectRatio: '4:5',
        promptStyle: 'Bold innovation-themed poster with striking red accents on dark background, diagonal dynamic composition, energy and progress aesthetic, cutting-edge research vibe',
    },
    {
        id: 'tmpl_11',
        name: 'Precision Gold',
        layout: 'grid',
        colorScheme: {
            primary: '#92400E',
            secondary: '#B45309',
            accent: '#F59E0B',
            background: '#FFFBEB',
            text: '#78350F',
        },
        typography: {
            headlineFont: 'Pretendard Bold',
            bodyFont: 'Pretendard Regular',
            ctaFont: 'Pretendard SemiBold',
        },
        aspectRatio: '4:5',
        promptStyle: 'Premium precision instruments poster with warm gold accents, grid layout showcasing equipment specs, luxury branding aesthetic, high-end analytical equipment feel',
    },
    {
        id: 'tmpl_12',
        name: 'Arctic Science',
        layout: 'minimal',
        colorScheme: {
            primary: '#0E7490',
            secondary: '#06B6D4',
            accent: '#67E8F9',
            background: '#ECFEFF',
            text: '#164E63',
        },
        typography: {
            headlineFont: 'Noto Sans KR Bold',
            bodyFont: 'Noto Sans KR Regular',
            ctaFont: 'Noto Sans KR Medium',
        },
        aspectRatio: '4:5',
        promptStyle: 'Arctic-cool scientific poster with cyan-teal palette, minimal clean design with ample breathing room, crystalline geometric elements, sophisticated research aesthetic',
    },
];

/**
 * row_generation_count에 따른 템플릿 로테이션 선택
 */
export function selectTemplate(
    rowGenerationCount: number,
    templates = POSTER_TEMPLATES,
): PosterTemplate {
    const index = rowGenerationCount % templates.length;
    return templates[index];
}

/**
 * ID로 템플릿 조회
 */
export function getTemplateById(
    templateId: string,
    templates = POSTER_TEMPLATES,
): PosterTemplate | undefined {
    return templates.find(t => t.id === templateId);
}
