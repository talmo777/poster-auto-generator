import sharp from 'sharp';
import QRCode from 'qrcode';
import satori from 'satori';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PosterCopy,
  PosterMaterials,
  PosterTemplate,
  PosterResult,
} from './types.js';
import { PROMPT_VERSION } from './copy-generator.js';

const IMAGE_FETCH_TIMEOUT_MS = 12000;
const QR_DARK_COLOR = '#0F172A';
const QR_LIGHT_COLOR = '#FFFFFF';
const MIN_FONT_FILE_SIZE = 50_000;

const DEFAULT_ORG_LABEL = '한양맞춤의약연구원 연구장비 공동활용';
const DEFAULT_TITLE = '첨단 연구 장비';
const DEFAULT_SUBTITLE = '정밀 분석 · 실험 지원';
const DEFAULT_NOTE = '홈페이지에서 장비 상세 정보와 예약 안내를 확인할 수 있습니다.';

export function generateSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

let cachedFonts: { [weight: number]: ArrayBuffer } = {};

function getFontUrls(weight: 400 | 700 | 900): string[] {
  return [
    `https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-kr@5.0.12/files/noto-sans-kr-korean-${weight}-normal.woff`,
    `https://unpkg.com/@fontsource/noto-sans-kr@5.0.12/files/noto-sans-kr-korean-${weight}-normal.woff`,
  ];
}

export async function ensureLocalFont(weight: 400 | 700 | 900 = 400): Promise<ArrayBuffer> {
  if (cachedFonts[weight]) return cachedFonts[weight];

  const fontDir = path.join(os.tmpdir(), 'poster-fonts');
  const fontPath = path.join(fontDir, `NotoSansKR-${weight}.woff`);

  if (!fs.existsSync(fontDir)) {
    fs.mkdirSync(fontDir, { recursive: true });
  }

  if (fs.existsSync(fontPath)) {
    const stat = fs.statSync(fontPath);
    if (stat.size < MIN_FONT_FILE_SIZE) {
      console.warn(`[PosterGenerator] Cached font too small (${stat.size}B), re-downloading...`);
      fs.unlinkSync(fontPath);
    }
  }

  if (!fs.existsSync(fontPath)) {
    const urls = getFontUrls(weight);
    let downloaded = false;
    for (const fontUrl of urls) {
      try {
        console.log(`[PosterGenerator] Downloading font weight ${weight} from ${fontUrl}...`);
        const response = await fetchWithTimeout(fontUrl, 15000);
        if (!response.ok) {
          console.warn(`[PosterGenerator] HTTP ${response.status}`);
          continue;
        }
        const buf = await response.arrayBuffer();
        if (buf.byteLength < MIN_FONT_FILE_SIZE) {
          console.warn('[PosterGenerator] Font too small');
          continue;
        }
        fs.writeFileSync(fontPath, Buffer.from(buf));
        console.log(`[PosterGenerator] Font weight ${weight} downloaded (${buf.byteLength} bytes)`);
        downloaded = true;
        break;
      } catch (e) {
        console.warn('[PosterGenerator] Failed:', e);
      }
    }
    if (!downloaded) throw new Error(`Failed to download font weight ${weight}`);
  }

  const buffer = fs.readFileSync(fontPath);
  cachedFonts[weight] = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  return cachedFonts[weight];
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'poster-auto-generator/3.0' },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getCanvasSize(aspectRatio: '4:5' | '9:16'): { width: number; height: number } {
  if (aspectRatio === '9:16') return { width: 1080, height: 1920 };
  return { width: 1080, height: 1350 };
}

async function fetchImageAsBase64(imageUrl: string | undefined): Promise<string | null> {
  if (!imageUrl) return null;
  try {
    const res = await fetchWithTimeout(imageUrl, IMAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = res.headers.get('content-type') || 'image/png';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (e) {
    console.warn('[PosterGenerator] Hero image fetch failed:', e);
    return null;
  }
}

function compactText(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .replace(/\n+/g, ' ')
    .replace(/[\uFFFD□]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[|｜]+/g, '|')
    .replace(/[•·]+/g, '·')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

function fixBrokenUnits(value: string): string {
  if (!value) return '';
  return value
    .replace(/-\s*90\s*냉각/g, '-90℃ 냉각')
    .replace(/([0-9])\s*[x×]\s*([0-9])/gi, '$1×$2')
    .replace(/([0-9.]+)\s*nm\b/gi, '$1nm')
    .replace(/([0-9.]+)\s*mm\b/gi, '$1mm')
    .replace(/([0-9.]+)\s*cm\b/gi, '$1cm')
    .replace(/([0-9.]+)\s*um\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*μm\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*℃/g, '$1℃')
    .replace(/([0-9.]+)\s*W\b/g, '$1W')
    .trim();
}

function isJunkText(value: string | undefined | null): boolean {
  const v = compactText(value).toLowerCase();
  if (!v) return true;

  const normalized = v.replace(/\s+/g, '');
  const directJunk = [
    '-', '--', '---', '|', '·', '.', 'n/a', 'na', 'none', 'null', 'undefined', '없음',
    '미정', '준비중', '업데이트예정', '추후업데이트', 'tbd', 'todo', '미입력', '정보없음',
  ];

  if (directJunk.includes(v) || directJunk.includes(normalized)) return true;
  if (v.includes('업데이트 예정') || v.includes('미정') || v.includes('추후 안내')) return true;

  return false;
}

function cleanDisplayText(value: string | undefined | null): string {
  const cleaned = fixBrokenUnits(compactText(value));
  if (isJunkText(cleaned)) return '';
  return cleaned;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function dedupeParts(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const raw of values) {
    const value = cleanDisplayText(raw);
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(value);
  }

  return results;
}

function splitParts(values: Array<string | undefined | null>): string[] {
  const merged = dedupeParts(values).join(' | ');
  return merged
    .split(/\s*\|\s*|\s*\/\s*|\s*,\s*/)
    .map((part) => cleanDisplayText(part))
    .filter(Boolean);
}

function pickTitle(copy: PosterCopy, materials: PosterMaterials): string {
  const candidates = dedupeParts([
    materials.equipmentName,
    copy.headline,
    materials.modelNumber,
    materials.category,
  ]);

  return truncateText(candidates[0] || DEFAULT_TITLE, 34);
}

function pickEyebrow(copy: PosterCopy, materials: PosterMaterials): string {
  const candidates = dedupeParts([
    copy.cta,
    materials.category,
    DEFAULT_ORG_LABEL,
  ]);
  return truncateText(candidates[0] || DEFAULT_ORG_LABEL, 30);
}

function pickSubMeta(materials: PosterMaterials): string {
  const parts = dedupeParts([materials.manufacturer, materials.modelNumber, materials.category]);
  return truncateText(parts.join(' · ') || DEFAULT_SUBTITLE, 68);
}

function buildKeyPoints(copy: PosterCopy, materials: PosterMaterials): string[] {
  const fromCopy = copy.bullets
    .map((v) => cleanDisplayText(v))
    .filter(Boolean)
    .map((v) => truncateText(v, 46));

  const fromSpecs = splitParts([materials.specification, materials.keywords])
    .map((v) => truncateText(v, 38));

  const merged = dedupeParts([...fromCopy, ...fromSpecs]).slice(0, 3);

  const fallback = [
    '고가 연구장비를 합리적인 방식으로 공동 활용',
    '전문 인프라 기반의 정밀 분석 및 실험 지원',
    '외부 기관·기업·연구실 대상 예약형 이용 가능',
  ];

  while (merged.length < 3) {
    merged.push(fallback[merged.length]);
  }

  return merged;
}

function pickSpecBadges(materials: PosterMaterials): string[] {
  const parts = splitParts([
    materials.specification,
    materials.keywords,
    materials.manufacturer,
    materials.modelNumber,
  ])
    .map((v) => truncateText(v, 20))
    .filter((v) => v.length >= 2 && v.length <= 20);

  const compact = parts.filter((v) => v.length <= 14);
  const selected = dedupeParts([...compact, ...parts]).slice(0, 3);

  return selected;
}

function buildFooterContact(materials: PosterMaterials): string[] {
  const lines = dedupeParts([
    materials.contact,
    materials.location,
    materials.priceInfo,
  ]).map((v) => truncateText(v, 52));

  return lines.slice(0, 3);
}

function buildFooterNote(copy: PosterCopy, materials: PosterMaterials): string {
  const candidates = dedupeParts([
    copy.supplementary,
    materials.priceInfo,
    '장비 이용 가능 여부 및 일정은 문의 후 확정됩니다.',
    DEFAULT_NOTE,
  ]);

  return truncateText(candidates[0] || DEFAULT_NOTE, 86);
}

function buildPosterVdom(
  width: number,
  height: number,
  copy: PosterCopy,
  materials: PosterMaterials,
  heroBase64: string | null,
  qrBase64: string | null,
) {
  const isStory = height > 1600;

  const eyebrow = pickEyebrow(copy, materials);
  const title = pickTitle(copy, materials);
  const subMeta = pickSubMeta(materials);
  const keyPoints = buildKeyPoints(copy, materials);
  const specBadges = pickSpecBadges(materials);
  const footerContacts = buildFooterContact(materials);
  const footerNote = buildFooterNote(copy, materials);

  const outerPaddingX = isStory ? 56 : 50;
  const outerPaddingY = isStory ? 58 : 44;
  const heroHeight = isStory ? 730 : 440;
  const qrSize = isStory ? 136 : 110;

  const keyPointElements = keyPoints.map((point, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: '100%',
        alignItems: 'flex-start',
        marginBottom: index === keyPoints.length - 1 ? 0 : (isStory ? 18 : 14),
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: isStory ? 13 : 11,
              height: isStory ? 13 : 11,
              borderRadius: 999,
              marginTop: isStory ? 9 : 8,
              flexShrink: 0,
              background: 'linear-gradient(135deg, #22D3EE, #818CF8)',
              boxShadow: '0 0 0 4px rgba(34,211,238,0.18)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginLeft: 14,
              color: '#E2E8F0',
              fontSize: isStory ? 27 : 20,
              fontWeight: 700,
              lineHeight: 1.34,
              flex: 1,
              wordBreak: 'keep-all' as const,
            },
            children: point,
          },
        },
      ],
    },
  }));

  const badgeElements = specBadges.map((badge) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        padding: isStory ? '10px 16px' : '8px 14px',
        borderRadius: 999,
        marginRight: 8,
        marginBottom: 8,
        background: 'rgba(148,163,184,0.14)',
        border: '1px solid rgba(148,163,184,0.34)',
        color: '#E2E8F0',
        fontSize: isStory ? 16 : 13,
        fontWeight: 700,
      },
      children: badge,
    },
  }));

  const contactElements = footerContacts.map((line, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        color: '#F8FAFC',
        fontSize: isStory ? 20 : 16,
        fontWeight: 700,
        lineHeight: 1.35,
        marginTop: index === 0 ? 0 : 6,
        wordBreak: 'keep-all' as const,
      },
      children: line,
    },
  }));

  const heroOverlayChildren: any[] = [];

  if (heroBase64) {
    heroOverlayChildren.push({
      type: 'img',
      props: {
        src: heroBase64,
        style: {
          position: 'absolute' as const,
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover' as const,
          opacity: 0.12,
          filter: 'blur(18px)',
        },
      },
    });
  }

  heroOverlayChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative' as const,
        width: '100%',
        height: '100%',
        borderRadius: 34,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 35%, rgba(255,255,255,0.98) 0%, rgba(241,245,249,0.96) 45%, rgba(203,213,225,0.94) 100%)',
        border: '1px solid rgba(255,255,255,0.75)',
        boxShadow: '0 22px 50px rgba(2,6,23,0.24), inset 0 1px 0 rgba(255,255,255,0.9)',
      },
      children: heroBase64
        ? [{
            type: 'img',
            props: {
              src: heroBase64,
              style: {
                width: '100%',
                height: '100%',
                objectFit: 'contain' as const,
                padding: isStory ? '36px 34px' : '28px 28px',
              },
            },
          }]
        : [{
            type: 'div',
            props: {
              style: {
                display: 'flex',
                color: '#64748B',
                fontSize: isStory ? 24 : 20,
                fontWeight: 700,
              },
              children: '장비 이미지 준비 중',
            },
          }],
    },
  });

  const qrSection = qrBase64
    ? {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'column' as const,
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: 18,
            flexShrink: 0,
          },
          children: [
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  padding: 10,
                  borderRadius: 18,
                  background: '#FFFFFF',
                  border: '1px solid rgba(148,163,184,0.35)',
                },
                children: [{
                  type: 'img',
                  props: {
                    src: qrBase64,
                    width: qrSize,
                    height: qrSize,
                  },
                }],
              },
            },
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  marginTop: 8,
                  color: '#CBD5E1',
                  fontSize: isStory ? 15 : 13,
                  fontWeight: 700,
                },
                children: '예/안내 바로가기',
              },
            },
          ],
        },
      }
    : null;

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative' as const,
        width,
        height,
        color: '#FFFFFF',
        fontFamily: 'Noto Sans KR',
        overflow: 'hidden',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute' as const,
              inset: 0,
              background: 'linear-gradient(140deg, rgba(2,6,23,0.94) 0%, rgba(9,16,43,0.92) 46%, rgba(10,16,34,0.96) 100%)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute' as const,
              top: -120,
              right: -120,
              width: isStory ? 660 : 500,
              height: isStory ? 320 : 260,
              transform: 'rotate(20deg)',
              background: 'linear-gradient(135deg, rgba(34,211,238,0.16), rgba(129,140,248,0.16))',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute' as const,
              top: 24,
              left: 24,
              right: 24,
              bottom: 24,
              borderRadius: 30,
              border: '1px solid rgba(148,163,184,0.18)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column' as const,
              width: '100%',
              height: '100%',
              padding: `${outerPaddingY}px ${outerPaddingX}px`,
              position: 'relative' as const,
              zIndex: 4,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignSelf: 'flex-start',
                    padding: isStory ? '8px 14px' : '6px 12px',
                    borderRadius: 999,
                    background: 'rgba(30,41,59,0.7)',
                    border: '1px solid rgba(148,163,184,0.24)',
                    color: '#C4B5FD',
                    fontSize: isStory ? 14 : 12,
                    fontWeight: 800,
                    letterSpacing: 0.2,
                  },
                  children: eyebrow,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: isStory ? 18 : 14,
                    color: '#FFFFFF',
                    fontSize: isStory ? 78 : 58,
                    fontWeight: 900,
                    lineHeight: 1.04,
                    letterSpacing: -1.6,
                    wordBreak: 'keep-all' as const,
                  },
                  children: title,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: 10,
                    color: '#CBD5E1',
                    fontSize: isStory ? 20 : 16,
                    fontWeight: 500,
                    lineHeight: 1.35,
                    wordBreak: 'keep-all' as const,
                  },
                  children: subMeta,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    width: '100%',
                    marginTop: isStory ? 24 : 18,
                    height: heroHeight,
                    borderRadius: 34,
                    overflow: 'hidden',
                    position: 'relative' as const,
                    background: 'rgba(15,23,42,0.6)',
                  },
                  children: heroOverlayChildren,
                },
              },
              ...(badgeElements.length > 0
                ? [{
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        flexWrap: 'wrap' as const,
                        width: '100%',
                        marginTop: 14,
                      },
                      children: badgeElements,
                    },
                  }]
                : []),
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: isStory ? 18 : 14,
                    width: '100%',
                    padding: isStory ? '24px 24px' : '20px 20px',
                    borderRadius: 24,
                    background: 'rgba(15,23,42,0.5)',
                    border: '1px solid rgba(148,163,184,0.18)',
                  },
                  children: [{
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        flexDirection: 'column' as const,
                        width: '100%',
                      },
                      children: keyPointElements,
                    },
                  }],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    width: '100%',
                    marginTop: 'auto',
                    padding: isStory ? '20px 22px' : '16px 18px',
                    borderRadius: 22,
                    background: 'rgba(2,6,23,0.62)',
                    border: '1px solid rgba(148,163,184,0.22)',
                    alignItems: 'flex-end',
                    justifyContent: 'space-between',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexDirection: 'column' as const,
                          flex: 1,
                          minWidth: 0,
                          paddingRight: qrBase64 ? 14 : 0,
                        },
                        children: [
                          {
                            type: 'div',
                            props: {
                              style: {
                                display: 'flex',
                                color: '#93C5FD',
                                fontSize: isStory ? 13 : 11,
                                fontWeight: 800,
                                letterSpacing: 0.4,
                                marginBottom: 6,
                              },
                              children: '설치장소 · 문의 · 이용안내',
                            },
                          },
                          ...contactElements,
                          {
                            type: 'div',
                            props: {
                              style: {
                                display: 'flex',
                                marginTop: 8,
                                color: '#94A3B8',
                                fontSize: isStory ? 14 : 12,
                                fontWeight: 400,
                                lineHeight: 1.35,
                                maxWidth: qrBase64 ? '92%' : '100%',
                              },
                              children: footerNote,
                            },
                          },
                        ],
                      },
                    },
                    ...(qrSection ? [qrSection] : []),
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

export async function generatePoster(
  copy: PosterCopy,
  template: PosterTemplate,
  materials: PosterMaterials,
  _geminiApiKey?: string,
  seed?: number,
): Promise<PosterResult> {
  const actualSeed = seed ?? generateSeed();
  const { width, height } = getCanvasSize(template.aspectRatio);

  const [font400, font700, font900] = await Promise.all([
    ensureLocalFont(400),
    ensureLocalFont(700),
    ensureLocalFont(900),
  ]);

  const [heroBase64, qrBuffer] = await Promise.all([
    fetchImageAsBase64(materials.referenceImageUrl),
    materials.bookingLink
      ? QRCode.toBuffer(materials.bookingLink, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 0,
          width: 160,
          color: { dark: QR_DARK_COLOR, light: QR_LIGHT_COLOR },
        })
      : null,
  ]);

  const qrBase64 = qrBuffer ? `data:image/png;base64,${qrBuffer.toString('base64')}` : null;

  let blurredBgBuffer: Buffer;
  if (materials.referenceImageUrl) {
    try {
      const res = await fetchWithTimeout(materials.referenceImageUrl, IMAGE_FETCH_TIMEOUT_MS);
      const bgArrayBuffer = await res.arrayBuffer();
      blurredBgBuffer = await sharp(Buffer.from(bgArrayBuffer))
        .resize(width, height, { fit: 'cover' })
        .modulate({ brightness: 0.18, saturation: 1.15 })
        .blur(82)
        .png()
        .toBuffer();
    } catch {
      blurredBgBuffer = await sharp({
        create: { width, height, channels: 4, background: '#020617' },
      }).png().toBuffer();
    }
  } else {
    blurredBgBuffer = await sharp({
      create: { width, height, channels: 4, background: '#020617' },
    }).png().toBuffer();
  }

  const vdom = buildPosterVdom(width, height, copy, materials, heroBase64, qrBase64);

  const svg = await satori(vdom as any, {
    width,
    height,
    fonts: [
      { name: 'Noto Sans KR', data: font400, weight: 400, style: 'normal' as const },
      { name: 'Noto Sans KR', data: font700, weight: 700, style: 'normal' as const },
      { name: 'Noto Sans KR', data: font900, weight: 900, style: 'normal' as const },
    ],
  });

  const satoriBuffer = Buffer.from(svg);
  const finalBuffer = await sharp(blurredBgBuffer)
    .composite([{ input: satoriBuffer, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return {
    imageBuffer: finalBuffer,
    copy,
    templateId: template.id,
    seed: actualSeed,
    promptVersion: PROMPT_VERSION,
  };
}
