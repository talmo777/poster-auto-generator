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
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/[\uFFFD□]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[…]+/g, '…')
    .replace(/[|｜]+/g, '|')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\/\s*/g, ' / ')
    .trim();
}

function fixBrokenUnits(value: string): string {
  return value
    .replace(/-\s*90\s*냉각/gi, '-90℃ 냉각')
    .replace(/([0-9])\s*[x×]\s*([0-9])/gi, '$1×$2')
    .replace(/([0-9.]+)\s*nm\b/gi, '$1nm')
    .replace(/([0-9.]+)\s*mm\b/gi, '$1mm')
    .replace(/([0-9.]+)\s*cm\b/gi, '$1cm')
    .replace(/([0-9.]+)\s*um\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*μm\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*℃/g, '$1℃')
    .replace(/([0-9.]+)\s*°c/gi, '$1℃')
    .replace(/([0-9.]+)\s*w\b/gi, '$1W')
    .trim();
}

function isPlaceholder(value: string): boolean {
  const v = value.toLowerCase().replace(/\s+/g, '');
  if (!v) return true;
  const placeholders = [
    '-', '--', '---', '.', '..', '...', 'n/a', 'na', 'none', 'null', 'undefined', '없음', '미정',
    '준비중', '준비 중', 'tbd', 'to be updated', '업데이트예정', '추후업데이트', '정보없음',
  ];
  if (placeholders.includes(v)) return true;
  if (/^(업데이트|수정)\s*예정/.test(v)) return true;
  return false;
}

function cleanDisplayText(value: string | undefined | null): string {
  const cleaned = fixBrokenUnits(compactText(value));
  if (!cleaned || isPlaceholder(cleaned)) return '';
  return cleaned;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function dedupeParts(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of values) {
    const cleaned = cleanDisplayText(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(cleaned);
  }
  return items;
}

function splitToTokens(value: string | undefined | null): string[] {
  const text = cleanDisplayText(value);
  if (!text) return [];
  return text
    .split(/\s*\|\s*|\s*\/\s*|\s*,\s*|\s*;\s*/)
    .map((part) => cleanDisplayText(part))
    .filter(Boolean);
}

function buildTopLabel(copy: PosterCopy, materials: PosterMaterials): string {
  const first = dedupeParts([
    copy.cta,
    materials.category,
    '연구장비 공동활용 · 외부기관 이용 가능',
  ])[0] || '연구장비 공동활용 · 외부기관 이용 가능';
  return truncateText(first, 36);
}

function buildTitle(materials: PosterMaterials, copy: PosterCopy): string {
  const title = dedupeParts([
    materials.equipmentName,
    copy.headline,
    materials.modelNumber,
    materials.category,
  ])[0] || '첨단 연구장비';
  return truncateText(title, 34);
}

function buildMeta(materials: PosterMaterials): { maker: string; model: string; category: string } {
  return {
    maker: truncateText(cleanDisplayText(materials.manufacturer), 28),
    model: truncateText(cleanDisplayText(materials.modelNumber), 30),
    category: truncateText(cleanDisplayText(materials.category), 26),
  };
}

function buildMarketingPoints(copy: PosterCopy, materials: PosterMaterials): string[] {
  const explicit = copy.bullets
    .map((item) => cleanDisplayText(item))
    .filter(Boolean)
    .map((item) => truncateText(item, 42));

  const tokenSpecs = splitToTokens(materials.specification)
    .map((item) => truncateText(item, 42));

  const merged = dedupeParts([...explicit, ...tokenSpecs]).slice(0, 3);

  while (merged.length < 3) {
    const fallback = ['고가 장비를 합리적으로 이용', '전문 인프라 기반 분석 지원', '외부기관 예약·문의 상시 대응'][merged.length];
    merged.push(fallback);
  }

  return merged;
}

function scoreSpecTag(item: string): number {
  let score = 0;
  if (/\d/.test(item)) score += 2;
  if (/(nm|mm|cm|μm|rpm|hz|ghz|mhz|℃|°c|w|fps|x|배|배율|해상도|정밀|분석|레이저|온도|속도)/i.test(item)) score += 3;
  if (item.length <= 18) score += 2;
  if (item.length > 24) score -= 2;
  return score;
}

function buildSpecTags(materials: PosterMaterials): string[] {
  const candidates = dedupeParts([
    ...splitToTokens(materials.specification),
    materials.category,
  ]);

  return candidates
    .filter((item) => item.length >= 2 && item.length <= 24)
    .sort((a, b) => scoreSpecTag(b) - scoreSpecTag(a))
    .slice(0, 3)
    .map((item) => truncateText(item, 24));
}

function buildContactRows(copy: PosterCopy, materials: PosterMaterials): string[] {
  const rows: string[] = [];
  const location = cleanDisplayText(materials.location);
  const contact = cleanDisplayText(materials.contact);
  const booking = cleanDisplayText(materials.bookingLink);

  if (location) rows.push(truncateText(`설치장소  ${location}`, 52));
  if (contact) rows.push(truncateText(`문의/예약  ${contact}`, 60));
  if (!contact && booking) rows.push(truncateText(`온라인 예약  ${booking.replace(/^https?:\/\//, '')}`, 58));

  return rows.slice(0, 3);
}

function buildBottomGuide(copy: PosterCopy, materials: PosterMaterials): string {
  const text = dedupeParts([
    copy.supplementary,
    materials.priceInfo,
    '상세 스펙과 이용 절차는 QR 또는 홈페이지에서 확인하세요.',
  ])[0] || '상세 스펙과 이용 절차는 QR 또는 홈페이지에서 확인하세요.';
  return truncateText(text, 76);
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

  const topLabel = buildTopLabel(copy, materials);
  const title = buildTitle(materials, copy);
  const meta = buildMeta(materials);
  const points = buildMarketingPoints(copy, materials);
  const tags = buildSpecTags(materials);
  const contacts = buildContactRows(copy, materials);
  const bottomGuide = buildBottomGuide(copy, materials);

  const outerPaddingX = isStory ? 56 : 50;
  const outerPaddingY = isStory ? 56 : 44;
  const heroHeight = isStory ? 760 : 470;
  const qrSize = isStory ? 136 : 108;
  const titleSize = isStory ? (title.length > 21 ? 70 : 78) : (title.length > 21 ? 56 : 64);

  const metaPills = [
    meta.maker ? `제조사 ${meta.maker}` : '',
    meta.model ? `모델 ${meta.model}` : '',
    meta.category ? `분야 ${meta.category}` : '',
  ].filter(Boolean);

  const pointElements = points.map((point, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: '100%',
        alignItems: 'flex-start',
        marginBottom: index === points.length - 1 ? 0 : (isStory ? 18 : 14),
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: isStory ? 14 : 12,
              height: isStory ? 14 : 12,
              borderRadius: 999,
              marginTop: isStory ? 12 : 10,
              background: 'linear-gradient(135deg, #67E8F9 0%, #A78BFA 100%)',
              flexShrink: 0,
              boxShadow: '0 0 0 4px rgba(167,139,250,0.24)',
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
              fontSize: isStory ? 28 : 22,
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

  const tagElements = tags.map((tag) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: isStory ? '10px 16px' : '8px 14px',
        borderRadius: 999,
        border: '1px solid rgba(148,163,184,0.34)',
        background: 'rgba(15,23,42,0.80)',
        color: '#E2E8F0',
        marginRight: 10,
        marginBottom: 10,
        fontSize: isStory ? 18 : 14,
        fontWeight: 700,
      },
      children: tag,
    },
  }));

  const metaElements = metaPills.map((pill) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: isStory ? '10px 14px' : '8px 12px',
        borderRadius: 10,
        marginRight: 10,
        marginBottom: 10,
        background: 'rgba(30,41,59,0.72)',
        border: '1px solid rgba(100,116,139,0.5)',
        color: '#CBD5E1',
        fontSize: isStory ? 17 : 14,
        fontWeight: 600,
      },
      children: pill,
    },
  }));

  const contactElements = contacts.map((line, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        color: '#F8FAFC',
        fontSize: isStory ? 22 : 17,
        fontWeight: 700,
        lineHeight: 1.35,
        marginBottom: index === contacts.length - 1 ? 0 : 6,
        wordBreak: 'keep-all' as const,
      },
      children: line,
    },
  }));

  const heroChildren: any[] = [
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          position: 'absolute' as const,
          inset: 0,
          background: 'radial-gradient(circle at 18% 18%, rgba(103,232,249,0.18), transparent 44%), radial-gradient(circle at 85% 86%, rgba(167,139,250,0.22), transparent 48%), linear-gradient(180deg, #F8FAFC 0%, #E2E8F0 100%)',
        },
        children: [],
      },
    },
  ];

  if (heroBase64) {
    heroChildren.push({
      type: 'img',
      props: {
        src: heroBase64,
        style: {
          display: 'flex',
          position: 'absolute' as const,
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover' as const,
          opacity: 0.15,
          filter: 'blur(18px)',
        },
      },
    });

    heroChildren.push({
      type: 'img',
      props: {
        src: heroBase64,
        style: {
          display: 'flex',
          position: 'relative' as const,
          width: '100%',
          height: '100%',
          objectFit: 'contain' as const,
          padding: isStory ? '34px' : '26px',
          zIndex: 2,
        },
      },
    });
  } else {
    heroChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          position: 'relative' as const,
          zIndex: 2,
          color: '#64748B',
          fontSize: isStory ? 26 : 20,
          fontWeight: 700,
        },
        children: '장비 이미지 준비 중',
      },
    });
  }

  const children: any[] = [
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          position: 'absolute' as const,
          inset: 0,
          background: 'linear-gradient(136deg, rgba(2,6,23,0.96) 0%, rgba(10,25,52,0.95) 52%, rgba(3,9,28,0.98) 100%)',
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
          top: -90,
          left: -130,
          width: isStory ? 600 : 480,
          height: isStory ? 360 : 280,
          transform: 'rotate(14deg)',
          background: 'linear-gradient(135deg, rgba(14,165,233,0.16), rgba(129,140,248,0.10))',
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
          bottom: -130,
          right: -120,
          width: isStory ? 700 : 540,
          height: isStory ? 360 : 280,
          transform: 'rotate(-12deg)',
          background: 'linear-gradient(135deg, rgba(167,139,250,0.22), rgba(56,189,248,0.12))',
        },
        children: [],
      },
    },
  ];

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative' as const,
        zIndex: 10,
        width: '100%',
        height: '100%',
        flexDirection: 'column' as const,
        padding: `${outerPaddingY}px ${outerPaddingX}px`,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignSelf: 'flex-start',
              padding: isStory ? '10px 18px' : '8px 14px',
              borderRadius: 999,
              border: '1px solid rgba(125,211,252,0.34)',
              background: 'rgba(15,23,42,0.54)',
              color: '#BAE6FD',
              fontSize: isStory ? 17 : 13,
              fontWeight: 800,
              letterSpacing: 0.25,
            },
            children: topLabel,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: 16,
              color: '#FFFFFF',
              fontSize: titleSize,
              fontWeight: 900,
              lineHeight: 1.07,
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
              marginTop: 12,
              flexWrap: 'wrap' as const,
            },
            children: metaElements,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: isStory ? 24 : 20,
              width: '100%',
              height: heroHeight,
              borderRadius: 28,
              border: '1px solid rgba(148,163,184,0.38)',
              background: 'rgba(248,250,252,0.96)',
              overflow: 'hidden',
              boxShadow: '0 32px 80px rgba(2,6,23,0.46)',
              position: 'relative' as const,
              alignItems: 'center',
              justifyContent: 'center',
            },
            children: heroChildren,
          },
        },
        ...(tagElements.length > 0 ? [{
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: 16,
              flexWrap: 'wrap' as const,
            },
            children: tagElements,
          },
        }] : []),
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: isStory ? 18 : 16,
              borderRadius: 20,
              padding: isStory ? '26px 24px' : '22px 20px',
              border: '1px solid rgba(100,116,139,0.35)',
              background: 'rgba(2,6,23,0.45)',
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
              padding: isStory ? '22px' : '18px',
              border: '1px solid rgba(148,163,184,0.28)',
              background: 'rgba(2,6,23,0.58)',
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
                    ...contactElements,
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          marginTop: 10,
                          color: '#94A3B8',
                          fontSize: isStory ? 16 : 13,
                          fontWeight: 500,
                          lineHeight: 1.34,
                        },
                        children: bottomGuide,
                      },
                    },
                  ],
                },
              },
              ...(qrBase64 ? [{
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column' as const,
                    alignItems: 'center',
                    marginLeft: 14,
                    flexShrink: 0,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          padding: 8,
                          borderRadius: 16,
                          background: '#FFFFFF',
                        },
                        children: [{ type: 'img', props: { src: qrBase64, width: qrSize, height: qrSize } }],
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          marginTop: 7,
                          color: '#CBD5E1',
                          fontSize: isStory ? 15 : 12,
                          fontWeight: 700,
                        },
                        children: '예약/상세 안내',
                      },
                    },
                  ],
                },
              }] : []),
            ],
          },
        },
      ],
    },
  });

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width,
        height,
        color: '#FFFFFF',
        fontFamily: 'Noto Sans KR',
        position: 'relative' as const,
        overflow: 'hidden',
      },
      children,
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
