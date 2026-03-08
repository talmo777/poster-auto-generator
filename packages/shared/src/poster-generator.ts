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
    .replace(/[\uFFFD□]/g, '')
    .replace(/[|｜]+/g, '|')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\/\s*/g, ' / ')
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
  if (['-', '--', 'n/a', 'na', 'null', 'undefined', '없음'].includes(v)) return true;
  if (v.includes('업데이트 예정')) return true;
  if (v === '(박미나)' || v === '박미나') return true;
  if (v === '|') return true;
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

function splitSpecText(value: string | undefined | null): string[] {
  return cleanDisplayText(value)
    .split(/\s*\|\s*|\s*\/\s*|,\s*/)
    .map((part) => cleanDisplayText(part))
    .filter(Boolean);
}

function buildEyebrow(copy: PosterCopy, materials: PosterMaterials): string {
  const candidates = dedupeParts([
    materials.category,
    copy.cta,
    materials.keywords,
    '한양맞춤의약연구원 보유 장비',
  ]);
  return truncateText(candidates[0] || '한양맞춤의약연구원 보유 장비', 22);
}

function buildDisplayTitle(copy: PosterCopy, materials: PosterMaterials): string {
  const candidates = dedupeParts([
    materials.equipmentName,
    copy.headline,
    materials.modelNumber,
  ]);
  const raw = candidates[0] || '첨단 연구 장비';
  return truncateText(raw, 30);
}

function buildDisplaySubtitle(copy: PosterCopy, materials: PosterMaterials): string {
  const parts = dedupeParts([
    materials.manufacturer,
    materials.modelNumber,
    copy.subheadline,
  ]);
  const line = parts.join(' · ');
  return truncateText(line, 56);
}

function buildValueBadges(materials: PosterMaterials): string[] {
  const badges = dedupeParts([
    materials.manufacturer,
    materials.modelNumber,
    ...splitSpecText(materials.specification).slice(0, 6),
  ]);

  return badges
    .map((badge) => truncateText(badge, 24))
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeBullets(copy: PosterCopy, materials: PosterMaterials): string[] {
  const explicit = copy.bullets
    .map((item) => cleanDisplayText(item))
    .filter(Boolean)
    .map((item) => truncateText(item, 28));

  const fallback = splitSpecText(materials.specification)
    .map((item) => truncateText(item, 28));

  const merged = dedupeParts([...explicit, ...fallback]);
  const selected = merged.slice(0, 3);

  while (selected.length < 3) {
    selected.push(['정밀 분석 지원', '연구 효율 향상', '전문 장비 활용'][selected.length]);
  }

  return selected;
}

function buildFooterLine(prefix: string, value: string | undefined | null, maxLen: number): string {
  const cleaned = cleanDisplayText(value);
  if (!cleaned) return '';
  return truncateText(`${prefix} ${cleaned}`, maxLen);
}

function buildFooterNote(copy: PosterCopy, materials: PosterMaterials): string {
  const candidates = dedupeParts([
    copy.supplementary,
    materials.priceInfo,
    '홈페이지에서 장비 상세 정보와 예약 안내를 확인할 수 있습니다.',
  ]);
  return truncateText(candidates[0] || '홈페이지에서 장비 상세 정보와 예약 안내를 확인할 수 있습니다.', 72);
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

  const eyebrow = buildEyebrow(copy, materials);
  const title = buildDisplayTitle(copy, materials);
  const subtitle = buildDisplaySubtitle(copy, materials);
  const badges = buildValueBadges(materials);
  const bullets = normalizeBullets(copy, materials);

  const locationLine = buildFooterLine('설치장소', materials.location, 34);
  const contactLine = buildFooterLine('문의 및 예약', materials.contact, 54);
  const footerNote = buildFooterNote(copy, materials);

  const titleLength = title.length;
  const titleFontSize = isStory ? (titleLength >= 24 ? 66 : 74) : (titleLength >= 24 ? 54 : 62);
  const titleLineHeight = titleLength >= 24 ? 1.03 : 1.08;
  const heroHeight = isStory ? 650 : 430;
  const footerQrSize = isStory ? 132 : 108;
  const outerPaddingX = isStory ? 56 : 52;
  const outerPaddingY = isStory ? 58 : 46;
  const bulletFontSize = isStory ? 28 : 22;
  const bulletDotSize = isStory ? 13 : 11;
  const bulletGap = isStory ? 24 : 16;

  const bulletElements = bullets.map((bullet, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        marginBottom: index === bullets.length - 1 ? 0 : bulletGap,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: bulletDotSize,
              height: bulletDotSize,
              borderRadius: 999,
              background: 'linear-gradient(135deg, #7C3AED, #C084FC)',
              marginTop: isStory ? 10 : 9,
              flexShrink: 0,
              boxShadow: '0 0 0 5px rgba(168,85,247,0.16)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginLeft: 16,
              color: '#F8FAFC',
              fontSize: bulletFontSize,
              fontWeight: 800,
              lineHeight: 1.35,
              wordBreak: 'keep-all' as const,
              flex: 1,
            },
            children: bullet,
          },
        },
      ],
    },
  }));

  const badgeElements = badges.map((badge) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: isStory ? '12px 20px' : '10px 18px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.97)',
        color: '#0F172A',
        fontSize: isStory ? 18 : 15,
        fontWeight: 800,
        marginRight: 10,
        marginBottom: 10,
        border: '1px solid rgba(148,163,184,0.24)',
      },
      children: badge,
    },
  }));

  const heroCardChildren: any[] = [];

  if (heroBase64) {
    heroCardChildren.push({
      type: 'img',
      props: {
        src: heroBase64,
        style: {
          position: 'absolute' as const,
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover' as const,
          opacity: 0.18,
        },
      },
    });
  }

  heroCardChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative' as const,
        width: '100%',
        height: '100%',
        borderRadius: 30,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(241,245,249,0.96) 100%)',
        border: '1px solid rgba(255,255,255,0.55)',
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8)',
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
                padding: isStory ? '28px' : '24px',
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

  const footerLeftChildren: any[] = [];
  if (locationLine) {
    footerLeftChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          color: '#F8FAFC',
          fontSize: isStory ? 24 : 18,
          fontWeight: 800,
          lineHeight: 1.35,
          wordBreak: 'keep-all' as const,
        },
        children: locationLine,
      },
    });
  }
  if (contactLine) {
    footerLeftChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          color: '#F8FAFC',
          fontSize: isStory ? 24 : 18,
          fontWeight: 800,
          lineHeight: 1.35,
          marginTop: 4,
          wordBreak: 'keep-all' as const,
        },
        children: contactLine,
      },
    });
  }
  footerLeftChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        color: '#94A3B8',
        fontSize: isStory ? 16 : 13,
        fontWeight: 400,
        lineHeight: 1.35,
        marginTop: 10,
        maxWidth: qrBase64 ? '92%' : '100%',
      },
      children: footerNote,
    },
  });

  const qrElement = qrBase64 ? {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        marginLeft: 22,
        flexShrink: 0,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              padding: 10,
              background: 'rgba(255,255,255,0.98)',
              borderRadius: 18,
              border: '1px solid rgba(196,181,253,0.48)',
              boxShadow: '0 12px 30px rgba(2,6,23,0.24)',
            },
            children: [{
              type: 'img',
              props: { src: qrBase64, width: footerQrSize, height: footerQrSize },
            }],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: isStory ? 16 : 14,
              fontWeight: 700,
              color: '#CBD5E1',
              marginTop: 8,
            },
            children: '홈페이지 바로가기',
          },
        },
      ],
    },
  } : null;

  const children: any[] = [];

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        inset: 0,
        background: 'linear-gradient(135deg, rgba(2,6,23,0.94) 0%, rgba(7,16,56,0.94) 45%, rgba(1,8,26,0.97) 100%)',
      },
      children: [],
    },
  });

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: -80,
        right: -120,
        width: isStory ? 520 : 420,
        height: isStory ? 280 : 240,
        transform: 'rotate(24deg)',
        background: 'linear-gradient(135deg, rgba(56,189,248,0.10), rgba(168,85,247,0.18))',
      },
      children: [],
    },
  });

  children.push({
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
        border: '1px solid rgba(148,163,184,0.20)',
      },
      children: [],
    },
  });

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 40,
        right: 36,
        width: isStory ? 76 : 68,
        height: isStory ? 76 : 68,
        borderRadius: 999,
        background: 'linear-gradient(135deg, rgba(168,85,247,0.95), rgba(216,180,254,0.92))',
      },
      children: [],
    },
  });

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 49,
        right: 45,
        width: isStory ? 58 : 50,
        height: isStory ? 58 : 50,
        borderRadius: 999,
        border: '3px solid rgba(255,255,255,0.20)',
      },
      children: [],
    },
  });

  const contentChildren: any[] = [];

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        alignSelf: 'center',
        padding: isStory ? '10px 18px' : '8px 16px',
        borderRadius: 999,
        background: 'rgba(15,23,42,0.52)',
        border: '1px solid rgba(148,163,184,0.22)',
        color: '#C4B5FD',
        fontSize: isStory ? 16 : 13,
        fontWeight: 800,
        letterSpacing: 0.4,
      },
      children: eyebrow,
    },
  });

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: 18,
        color: '#FFFFFF',
        fontSize: titleFontSize,
        fontWeight: 900,
        lineHeight: titleLineHeight,
        textAlign: 'center' as const,
        justifyContent: 'center',
        letterSpacing: -1.8,
        wordBreak: 'keep-all' as const,
      },
      children: title,
    },
  });

  if (subtitle) {
    contentChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          marginTop: 10,
          color: '#CBD5E1',
          fontSize: isStory ? 20 : 18,
          fontWeight: 500,
          lineHeight: 1.35,
          textAlign: 'center' as const,
          justifyContent: 'center',
          wordBreak: 'keep-all' as const,
          padding: '0 40px',
        },
        children: subtitle,
      },
    });
  }

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        width: '100%',
        marginTop: isStory ? 26 : 24,
        padding: isStory ? '20px' : '18px',
        borderRadius: 30,
        background: 'linear-gradient(180deg, rgba(71,85,105,0.58) 0%, rgba(30,41,59,0.90) 100%)',
        boxShadow: '0 28px 70px rgba(2,6,23,0.32)',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: '100%',
              height: heroHeight,
              position: 'relative' as const,
              borderRadius: 30,
              overflow: 'hidden',
            },
            children: heroCardChildren,
          },
        },
        ...(badgeElements.length > 0 ? [{
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexWrap: 'wrap' as const,
              alignItems: 'center',
              justifyContent: 'center',
              padding: isStory ? '18px 6px 2px 6px' : '16px 6px 0 6px',
            },
            children: badgeElements,
          },
        }] : []),
      ],
    },
  });

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: isStory ? 24 : 22,
        width: '100%',
        borderRadius: 26,
        background: 'rgba(2,6,23,0.54)',
        border: '1px solid rgba(148,163,184,0.18)',
        padding: isStory ? '34px 34px' : '28px 30px',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      },
      children: [{
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'column' as const,
            width: '100%',
          },
          children: bulletElements,
        },
      }],
    },
  });

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: isStory ? 26 : 24,
        padding: isStory ? '22px 24px' : '18px 20px',
        borderRadius: 22,
        background: 'rgba(2,6,23,0.34)',
        border: '1px solid rgba(148,163,184,0.12)',
        justifyContent: 'space-between',
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
              paddingRight: qrBase64 ? 14 : 0,
            },
            children: footerLeftChildren,
          },
        },
        ...(qrElement ? [qrElement] : []),
      ],
    },
  });

  children.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        width: '100%',
        height: '100%',
        position: 'relative' as const,
        zIndex: 10,
        padding: `${outerPaddingY}px ${outerPaddingX}px ${outerPaddingY}px ${outerPaddingX}px`,
      },
      children: contentChildren,
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
