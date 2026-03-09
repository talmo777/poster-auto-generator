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

const FALLBACK_HERO_POINTS = [
  '고가 연구장비를 합리적으로 활용할 수 있는 공동활용 환경',
  '전문 인프라 기반으로 안정적 분석 및 실험 지원',
  '기관·기업·대학 연구자를 위한 신속한 장비 이용 프로세스',
];

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
    .replace(/[\x00-\x1F]/g, ' ')
    .replace(/[\uFFFD□]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[|｜]+/g, '|')
    .replace(/[‐-–—]+/g, '-')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
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
    .replace(/([0-9.]+)\s*°c/gi, '$1℃')
    .replace(/([0-9.]+)\s*w\b/gi, '$1W')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isJunkText(value: string | undefined | null): boolean {
  const v = compactText(value).toLowerCase();
  if (!v) return true;
  const junkKeywords = [
    '-', '--', '---', 'n/a', 'na', 'null', 'undefined', '없음', '미정', 'tbd', 'to be updated',
    '업데이트 예정', '추후 업데이트', '미입력', '입력예정', '준비중', '준비 중',
  ];
  if (junkKeywords.includes(v)) return true;
  if (v.replace(/[-\s]/g, '') === '') return true;
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

function tokenizeValue(raw: string | undefined | null): string[] {
  const clean = cleanDisplayText(raw);
  if (!clean) return [];
  return clean
    .split(/\s*\|\s*|\s*\/\s*|\s*,\s*|\s*·\s*|\s*;\s*/)
    .map((token) => cleanDisplayText(token))
    .filter(Boolean);
}

function pickFirst(values: Array<string | undefined | null>, fallback: string): string {
  const picked = dedupeParts(values)[0];
  return picked ? picked : fallback;
}

function pickTopN(values: Array<string | undefined | null>, max: number, maxLen: number): string[] {
  return dedupeParts(values)
    .map((v) => truncateText(v, maxLen))
    .filter(Boolean)
    .slice(0, max);
}

function buildPosterContent(copy: PosterCopy, materials: PosterMaterials) {
  const smallLabel = truncateText(
    pickFirst(
      [
        copy.cta,
        materials.category,
        '외부 연구자·기업 대상 장비 활용 지원',
      ],
      '외부 연구자·기업 대상 장비 활용 지원',
    ),
    28,
  );

  const title = truncateText(
    pickFirst([materials.equipmentName, copy.headline, materials.modelNumber], '첨단 연구 장비'),
    32,
  );

  const categoryLabel = truncateText(
    pickFirst([materials.category, '연구장비 대여·분석 지원'], '연구장비 대여·분석 지원'),
    22,
  );

  const maker = truncateText(cleanDisplayText(materials.manufacturer), 24);
  const model = truncateText(cleanDisplayText(materials.modelNumber), 30);

  const specCandidates = dedupeParts([
    ...tokenizeValue(materials.specification),
    ...tokenizeValue(materials.keywords),
  ]).filter((token) => token.length <= 22);

  const badges = specCandidates.slice(0, 3).map((badge) => truncateText(badge, 20));

  const keyPoints = dedupeParts([
    ...copy.bullets,
    copy.subheadline,
    ...tokenizeValue(materials.specification),
    ...tokenizeValue(materials.keywords),
  ])
    .map((line) => truncateText(line, 42))
    .filter((line) => line.length >= 7)
    .slice(0, 3);

  while (keyPoints.length < 3) {
    keyPoints.push(FALLBACK_HERO_POINTS[keyPoints.length]);
  }

  const location = truncateText(cleanDisplayText(materials.location), 38);

  const contactRaw = dedupeParts([
    materials.contact,
    materials.bookingLink ? '예약 링크 제공' : '',
  ]).join(' | ');
  const contact = truncateText(contactRaw, 62);

  const footerGuide = truncateText(
    pickFirst(
      [
        copy.supplementary,
        materials.priceInfo,
        'QR 스캔 후 장비 상세 안내와 이용 절차를 확인하고 예약을 진행해 주세요.',
      ],
      'QR 스캔 후 장비 상세 안내와 이용 절차를 확인하고 예약을 진행해 주세요.',
    ),
    84,
  );

  const organizer = '한양맞춤의약연구원 연구장비 공동활용센터';

  return {
    smallLabel,
    title,
    categoryLabel,
    maker,
    model,
    badges,
    keyPoints,
    location,
    contact,
    footerGuide,
    organizer,
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
  const content = buildPosterContent(copy, materials);

  const horizontal = isStory ? 58 : 54;
  const vertical = isStory ? 60 : 48;
  const heroHeight = isStory ? 760 : 520;

  const pointRows = content.keyPoints.map((point, idx) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        marginBottom: idx === content.keyPoints.length - 1 ? 0 : (isStory ? 18 : 14),
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: isStory ? 28 : 24,
              color: '#93C5FD',
              fontSize: isStory ? 20 : 18,
              fontWeight: 900,
              lineHeight: 1.35,
            },
            children: '•',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              color: '#E2E8F0',
              fontSize: isStory ? 28 : 21,
              fontWeight: 700,
              lineHeight: 1.34,
              wordBreak: 'keep-all' as const,
              flex: 1,
            },
            children: point,
          },
        },
      ],
    },
  }));

  const badgeElements = content.badges.map((badge) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: isStory ? '10px 16px' : '8px 14px',
        borderRadius: 999,
        border: '1px solid rgba(59,130,246,0.38)',
        background: 'rgba(15,23,42,0.72)',
        color: '#BFDBFE',
        fontSize: isStory ? 18 : 15,
        fontWeight: 700,
        marginRight: 10,
        marginTop: 10,
      },
      children: badge,
    },
  }));

  const metaItems = pickTopN([
    content.categoryLabel,
    content.maker ? `제조사 ${content.maker}` : '',
    content.model ? `모델 ${content.model}` : '',
  ], 3, 36).map((item) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: isStory ? '9px 14px' : '8px 12px',
        borderRadius: 12,
        border: '1px solid rgba(148,163,184,0.28)',
        background: 'rgba(15,23,42,0.48)',
        color: '#E2E8F0',
        fontSize: isStory ? 18 : 14,
        fontWeight: 600,
        marginRight: 10,
        marginBottom: 10,
      },
      children: item,
    },
  }));

  const footerInfoBlocks = [
    content.location ? { title: '설치장소', value: content.location } : null,
    content.contact ? { title: '문의/예약', value: content.contact } : null,
  ].filter(Boolean) as Array<{ title: string; value: string }>;

  const footerInfoElements = footerInfoBlocks.map((block, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        marginBottom: index === footerInfoBlocks.length - 1 ? 0 : 10,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: isStory ? 16 : 13,
              color: '#93C5FD',
              fontWeight: 800,
              letterSpacing: 0.2,
            },
            children: block.title,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: 2,
              fontSize: isStory ? 23 : 17,
              color: '#F8FAFC',
              fontWeight: 700,
              lineHeight: 1.34,
              wordBreak: 'keep-all' as const,
            },
            children: block.value,
          },
        },
      ],
    },
  }));

  const qrNode = qrBase64
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
                },
                children: [
                  {
                    type: 'img',
                    props: {
                      src: qrBase64,
                      width: isStory ? 128 : 102,
                      height: isStory ? 128 : 102,
                    },
                  },
                ],
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
                  fontWeight: 600,
                },
                children: '상세 안내 / 예약',
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
        width,
        height,
        position: 'relative' as const,
        overflow: 'hidden',
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
              background: 'linear-gradient(140deg, rgba(2,6,23,0.95) 0%, rgba(15,23,42,0.92) 45%, rgba(3,7,18,0.96) 100%)',
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
              top: isStory ? -120 : -80,
              right: isStory ? -120 : -100,
              width: isStory ? 520 : 460,
              height: isStory ? 320 : 270,
              borderRadius: 200,
              background: 'radial-gradient(circle, rgba(56,189,248,0.22) 0%, rgba(14,116,144,0.02) 70%)',
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
              flexDirection: 'column' as const,
              width: '100%',
              height: '100%',
              zIndex: 10,
              padding: `${vertical}px ${horizontal}px ${vertical}px ${horizontal}px`,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignSelf: 'flex-start',
                    padding: isStory ? '9px 14px' : '7px 12px',
                    borderRadius: 999,
                    background: 'rgba(15,23,42,0.62)',
                    border: '1px solid rgba(59,130,246,0.40)',
                    color: '#BFDBFE',
                    fontSize: isStory ? 15 : 13,
                    fontWeight: 700,
                  },
                  children: content.smallLabel,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: isStory ? 18 : 14,
                    color: '#FFFFFF',
                    fontSize: isStory ? (content.title.length > 24 ? 68 : 76) : (content.title.length > 24 ? 54 : 62),
                    lineHeight: 1.05,
                    letterSpacing: -1.5,
                    fontWeight: 900,
                    wordBreak: 'keep-all' as const,
                    maxWidth: '96%',
                  },
                  children: content.title,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexWrap: 'wrap' as const,
                    marginTop: 14,
                    marginBottom: isStory ? 16 : 14,
                  },
                  children: metaItems,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    width: '100%',
                    borderRadius: 28,
                    padding: isStory ? '22px' : '18px',
                    background: 'linear-gradient(180deg, rgba(30,41,59,0.90) 0%, rgba(2,6,23,0.96) 100%)',
                    border: '1px solid rgba(148,163,184,0.24)',
                    boxShadow: '0 22px 70px rgba(2,6,23,0.50)',
                    minHeight: heroHeight,
                    maxHeight: heroHeight,
                    position: 'relative' as const,
                    overflow: 'hidden',
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                  children: heroBase64
                    ? [
                        {
                          type: 'img',
                          props: {
                            src: heroBase64,
                            style: {
                              position: 'absolute' as const,
                              inset: 0,
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover' as const,
                              opacity: 0.16,
                              filter: 'blur(6px)',
                            },
                          },
                        },
                        {
                          type: 'div',
                          props: {
                            style: {
                              display: 'flex',
                              width: '100%',
                              height: '100%',
                              position: 'relative' as const,
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: 20,
                              background: 'radial-gradient(circle at center, rgba(255,255,255,0.20) 0%, rgba(15,23,42,0.10) 62%, rgba(2,6,23,0.20) 100%)',
                            },
                            children: [
                              {
                                type: 'img',
                                props: {
                                  src: heroBase64,
                                  style: {
                                    width: '100%',
                                    height: '100%',
                                    objectFit: 'contain' as const,
                                    padding: isStory ? '26px' : '20px',
                                  },
                                },
                              },
                            ],
                          },
                        },
                      ]
                    : [
                        {
                          type: 'div',
                          props: {
                            style: {
                              display: 'flex',
                              color: '#94A3B8',
                              fontSize: isStory ? 24 : 20,
                              fontWeight: 700,
                            },
                            children: '장비 이미지 준비 중',
                          },
                        },
                      ],
                },
              },
              ...(badgeElements.length > 0
                ? [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexWrap: 'wrap' as const,
                          marginTop: isStory ? 6 : 4,
                        },
                        children: badgeElements,
                      },
                    },
                  ]
                : []),
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: isStory ? 18 : 14,
                    padding: isStory ? '22px 24px' : '18px 20px',
                    borderRadius: 22,
                    border: '1px solid rgba(59,130,246,0.34)',
                    background: 'rgba(15,23,42,0.56)',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexDirection: 'column' as const,
                          width: '100%',
                        },
                        children: pointRows,
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    marginTop: 'auto',
                    padding: isStory ? '18px 20px' : '14px 16px',
                    borderRadius: 20,
                    border: '1px solid rgba(148,163,184,0.24)',
                    background: 'rgba(2,6,23,0.70)',
                    alignItems: 'flex-end',
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
                        },
                        children: [
                          ...footerInfoElements,
                          {
                            type: 'div',
                            props: {
                              style: {
                                display: 'flex',
                                marginTop: footerInfoElements.length > 0 ? 10 : 0,
                                color: '#94A3B8',
                                fontSize: isStory ? 15 : 12,
                                lineHeight: 1.35,
                                fontWeight: 500,
                              },
                              children: content.footerGuide,
                            },
                          },
                          {
                            type: 'div',
                            props: {
                              style: {
                                display: 'flex',
                                marginTop: 8,
                                color: '#CBD5E1',
                                fontSize: isStory ? 14 : 12,
                                fontWeight: 600,
                              },
                              children: content.organizer,
                            },
                          },
                        ],
                      },
                    },
                    ...(qrNode ? [qrNode] : []),
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
