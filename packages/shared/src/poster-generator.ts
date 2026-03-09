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

const FALLBACK_POINTS = ['정밀 데이터 확보', '외부 연구자 공동 활용', '예약 기반 안정 운영'];

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

function normalizeText(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\uFFFD□]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[|｜]+/g, '|')
    .replace(/[‐-–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

function fixUnits(value: string): string {
  return value
    .replace(/([0-9])\s*[xX×]\s*([0-9])/g, '$1×$2')
    .replace(/([0-9.]+)\s*nm\b/gi, '$1nm')
    .replace(/([0-9.]+)\s*mm\b/gi, '$1mm')
    .replace(/([0-9.]+)\s*cm\b/gi, '$1cm')
    .replace(/([0-9.]+)\s*um\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*μm\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*℃/g, '$1℃')
    .replace(/([0-9.]+)\s*°c/gi, '$1℃')
    .replace(/([0-9.]+)\s*w\b/gi, '$1W')
    .replace(/-\s*90\s*냉각/g, '-90℃ 냉각')
    .trim();
}

function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if ([
    '-', '--', '---', '.', '..', 'n/a', 'na', 'none', 'null', 'undefined', '없음', '미정', 'tbd',
    'updating', 'update soon', '업데이트예정', '업데이트 예정', '준비중', '준비 중',
  ].includes(v)) {
    return true;
  }
  if (/^(업데이트|update).*(예정|soon)/i.test(v)) return true;
  if (/^[-|/\\_\s]+$/.test(v)) return true;
  return false;
}

function cleanText(value: string | undefined | null, maxLength = 120): string {
  const normalized = fixUnits(normalizeText(value));
  if (!normalized || isPlaceholder(normalized)) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function splitParts(value: string | undefined | null): string[] {
  const cleaned = cleanText(value, 200);
  if (!cleaned) return [];
  return cleaned
    .split(/\s*\|\s*|\s*\/\s*|\s*[,;·]\s*/)
    .map((part) => cleanText(part, 40))
    .filter(Boolean);
}

function uniq(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const text = cleanText(raw, 140);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function selectTopSpecs(materials: PosterMaterials): string[] {
  const merged = uniq([
    ...splitParts(materials.specification),
    ...splitParts(materials.keywords),
  ]);

  const short = merged
    .filter((item) => item.length >= 2 && item.length <= 24)
    .filter((item) => /\d|nm|mm|μm|℃|분석|해상도|정밀|속도|laser|검출|이미징|throughput|자동/i.test(item));

  if (short.length >= 3) return short.slice(0, 3);
  return uniq([...short, ...merged]).slice(0, 3);
}

function buildPosterData(copy: PosterCopy, materials: PosterMaterials) {
  const title =
    cleanText(materials.equipmentName, 34) ||
    cleanText(copy.headline, 34) ||
    cleanText(materials.modelNumber, 34) ||
    '첨단 연구장비';

  const category = cleanText(materials.category, 22) || '연구장비 대여';
  const manufacturer = cleanText(materials.manufacturer, 26);
  const model = cleanText(materials.modelNumber, 28);
  const subheadline = cleanText(copy.subheadline, 56);

  const upperLabelParts = uniq([
    '한양맞춤의약연구원',
    cleanText(copy.cta, 22),
  ]).slice(0, 2);

  const points = uniq([
    ...copy.bullets.map((b) => cleanText(b, 40)),
    ...splitParts(materials.keywords).map((v) => cleanText(v, 40)),
    ...splitParts(materials.specification).map((v) => cleanText(v, 40)),
  ]).slice(0, 3);

  while (points.length < 3) {
    points.push(FALLBACK_POINTS[points.length]);
  }

  const badges = uniq([
    category,
    manufacturer,
    ...selectTopSpecs(materials),
  ])
    .map((badge) => cleanText(badge, 20))
    .filter(Boolean)
    .slice(0, 3);

  const location = cleanText(materials.location, 40);
  const contact = cleanText(materials.contact, 58);
  const footerGuide =
    cleanText(copy.supplementary, 84) ||
    cleanText(materials.priceInfo, 84) ||
    '장비 상세 조건 및 예약 가능 일정은 QR 링크에서 확인해 주세요.';

  return {
    title,
    category,
    manufacturer,
    model,
    subheadline,
    upperLabel: upperLabelParts.join(' · '),
    points,
    badges,
    location,
    contact,
    footerGuide,
  };
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
  const data = buildPosterData(copy, materials);

  const sidePad = isStory ? 58 : 52;
  const topPad = isStory ? 56 : 48;
  const bottomPad = isStory ? 54 : 44;
  const heroHeight = isStory ? 720 : 470;
  const qrSize = isStory ? 126 : 104;

  const infoLines = uniq([
    data.manufacturer ? `제조사 ${data.manufacturer}` : '',
    data.model ? `모델 ${data.model}` : '',
    data.subheadline,
  ]).slice(0, 2);

  const pointElements = data.points.map((point, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row' as const,
        alignItems: 'flex-start',
        marginBottom: index === data.points.length - 1 ? 0 : (isStory ? 16 : 12),
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: isStory ? 11 : 10,
              height: isStory ? 11 : 10,
              borderRadius: 999,
              background: 'linear-gradient(135deg, #38BDF8, #A78BFA)',
              marginTop: isStory ? 11 : 9,
              marginRight: 12,
              flexShrink: 0,
              boxShadow: '0 0 0 4px rgba(56,189,248,0.16)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              color: '#E2E8F0',
              fontSize: isStory ? 30 : 22,
              fontWeight: 700,
              lineHeight: 1.35,
              wordBreak: 'keep-all' as const,
              flex: 1,
            },
            children: point,
          },
        },
      ],
    },
  }));

  const badgeElements = data.badges.map((badge) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        borderRadius: 999,
        padding: isStory ? '10px 18px' : '8px 16px',
        marginRight: 10,
        marginBottom: 10,
        color: '#0B1220',
        background: 'rgba(248,250,252,0.98)',
        border: '1px solid rgba(148,163,184,0.34)',
        fontSize: isStory ? 17 : 14,
        fontWeight: 800,
      },
      children: badge,
    },
  }));

  const heroChildren: any[] = [];
  if (heroBase64) {
    heroChildren.push({
      type: 'img',
      props: {
        src: heroBase64,
        style: {
          position: 'absolute' as const,
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover' as const,
          opacity: 0.14,
          filter: 'blur(6px)',
        },
      },
    });
  }

  heroChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative' as const,
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 30,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.55)',
        background: 'radial-gradient(circle at 50% 20%, rgba(255,255,255,0.97) 0%, rgba(241,245,249,0.98) 58%, rgba(226,232,240,0.98) 100%)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.92)',
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
                objectPosition: 'center center',
                padding: isStory ? '34px' : '26px',
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

  const footerMeta: any[] = [];
  if (data.location) {
    footerMeta.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          color: '#F8FAFC',
          fontSize: isStory ? 23 : 18,
          fontWeight: 800,
          marginBottom: 4,
          lineHeight: 1.32,
          wordBreak: 'keep-all' as const,
        },
        children: `설치장소  ${data.location}`,
      },
    });
  }
  if (data.contact) {
    footerMeta.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          color: '#E2E8F0',
          fontSize: isStory ? 22 : 17,
          fontWeight: 700,
          lineHeight: 1.35,
          wordBreak: 'keep-all' as const,
        },
        children: `문의/예약  ${data.contact}`,
      },
    });
  }

  const infoRows = infoLines.map((line, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: index === 0 ? 8 : 4,
        color: '#CBD5E1',
        fontSize: isStory ? 18 : 15,
        fontWeight: 500,
        lineHeight: 1.35,
        wordBreak: 'keep-all' as const,
      },
      children: line,
    },
  }));

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width,
        height,
        position: 'relative' as const,
        overflow: 'hidden',
        color: '#FFFFFF',
        fontFamily: 'Noto Sans KR',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute' as const,
              inset: 0,
              background: 'linear-gradient(145deg, rgba(2,6,23,0.95) 0%, rgba(8,17,46,0.95) 56%, rgba(3,10,28,0.98) 100%)',
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
              top: isStory ? -120 : -90,
              right: isStory ? -130 : -110,
              width: isStory ? 560 : 430,
              height: isStory ? 360 : 250,
              transform: 'rotate(18deg)',
              background: 'linear-gradient(120deg, rgba(56,189,248,0.14), rgba(167,139,250,0.18))',
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
              top: 22,
              left: 22,
              right: 22,
              bottom: 22,
              borderRadius: 28,
              border: '1px solid rgba(148,163,184,0.26)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'relative' as const,
              zIndex: 5,
              width: '100%',
              height: '100%',
              flexDirection: 'column' as const,
              padding: `${topPad}px ${sidePad}px ${bottomPad}px ${sidePad}px`,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignSelf: 'flex-start',
                    padding: isStory ? '10px 16px' : '8px 14px',
                    borderRadius: 999,
                    background: 'rgba(15,23,42,0.62)',
                    border: '1px solid rgba(148,163,184,0.3)',
                    color: '#C4B5FD',
                    fontWeight: 800,
                    fontSize: isStory ? 15 : 13,
                    letterSpacing: 0.3,
                  },
                  children: data.upperLabel,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: isStory ? 18 : 16,
                    color: '#93C5FD',
                    fontSize: isStory ? 24 : 18,
                    fontWeight: 800,
                    letterSpacing: 0.2,
                  },
                  children: data.category,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: 8,
                    color: '#FFFFFF',
                    fontSize: isStory ? (data.title.length > 22 ? 70 : 78) : (data.title.length > 22 ? 53 : 60),
                    lineHeight: data.title.length > 24 ? 1.04 : 1.1,
                    fontWeight: 900,
                    letterSpacing: -1.4,
                    wordBreak: 'keep-all' as const,
                  },
                  children: data.title,
                },
              },
              ...infoRows,
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: isStory ? 20 : 18,
                    width: '100%',
                    height: heroHeight,
                    borderRadius: 30,
                    overflow: 'hidden',
                    position: 'relative' as const,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(148,163,184,0.18)',
                    boxShadow: '0 28px 64px rgba(2,6,23,0.38)',
                  },
                  children: heroChildren,
                },
              },
              ...(badgeElements.length > 0
                ? [{
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        flexWrap: 'wrap' as const,
                        marginTop: isStory ? 16 : 14,
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
                    marginTop: isStory ? 14 : 12,
                    padding: isStory ? '24px 24px' : '18px 18px',
                    borderRadius: 24,
                    background: 'rgba(15,23,42,0.54)',
                    border: '1px solid rgba(148,163,184,0.2)',
                  },
                  children: [{
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        flexDirection: 'column' as const,
                        width: '100%',
                      },
                      children: pointElements,
                    },
                  }],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: 'auto',
                    borderRadius: 22,
                    padding: isStory ? '20px 22px' : '16px 18px',
                    background: 'rgba(2,6,23,0.5)',
                    border: '1px solid rgba(148,163,184,0.2)',
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
                          paddingRight: qrBase64 ? 12 : 0,
                          minWidth: 0,
                        },
                        children: [
                          ...footerMeta,
                          {
                            type: 'div',
                            props: {
                              style: {
                                display: 'flex',
                                color: '#94A3B8',
                                fontSize: isStory ? 16 : 13,
                                fontWeight: 500,
                                marginTop: 8,
                                lineHeight: 1.35,
                              },
                              children: data.footerGuide,
                            },
                          },
                        ],
                      },
                    },
                    ...(qrBase64
                      ? [{
                          type: 'div',
                          props: {
                            style: {
                              display: 'flex',
                              flexDirection: 'column' as const,
                              alignItems: 'center',
                              marginLeft: 12,
                            },
                            children: [
                              {
                                type: 'div',
                                props: {
                                  style: {
                                    display: 'flex',
                                    padding: 9,
                                    borderRadius: 16,
                                    background: '#FFFFFF',
                                    border: '1px solid rgba(148,163,184,0.4)',
                                  },
                                  children: [{
                                    type: 'img',
                                    props: { src: qrBase64, width: qrSize, height: qrSize },
                                  }],
                                },
                              },
                              {
                                type: 'div',
                                props: {
                                  style: {
                                    display: 'flex',
                                    marginTop: 6,
                                    color: '#CBD5E1',
                                    fontSize: isStory ? 15 : 12,
                                    fontWeight: 700,
                                  },
                                  children: '예약/상세정보',
                                },
                              },
                            ],
                          },
                        }]
                      : []),
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
