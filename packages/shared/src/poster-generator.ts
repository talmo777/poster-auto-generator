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
      headers: { 'User-Agent': 'poster-auto-generator/2.1' },
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
    .replace(/([0-9.]+)\s*m\b/g, '$1m')
    .replace(/([0-9.]+)\s*nm\b/gi, '$1nm')
    .replace(/([0-9.]+)\s*mm\b/gi, '$1mm')
    .replace(/([0-9.]+)\s*cm\b/gi, '$1cm')
    .replace(/([0-9.]+)\s*um\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*μm\b/gi, '$1μm')
    .replace(/([0-9.]+)\s*℃/g, '$1℃')
    .trim();
}

function cleanDisplayText(value: string | undefined | null): string {
  return fixBrokenUnits(compactText(value));
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function buildSpecChips(materials: PosterMaterials): string[] {
  const candidates = [
    cleanDisplayText(materials.manufacturer),
    cleanDisplayText(materials.modelNumber),
    cleanDisplayText(materials.specification),
  ].filter(Boolean);

  const chips: string[] = [];
  for (const value of candidates) {
    if (chips.length >= 5) break;
    chips.push(truncateText(value, 34));
  }
  return chips;
}

function normalizeBullets(copy: PosterCopy, materials: PosterMaterials): string[] {
  const source = copy.bullets
    .map((item) => cleanDisplayText(item))
    .filter(Boolean);

  const normalized = source
    .map((item) => truncateText(item, 34))
    .slice(0, 3);

  if (normalized.length >= 3) return normalized;

  const fallbacks = [
    cleanDisplayText(materials.specification),
    cleanDisplayText(materials.modelNumber),
    cleanDisplayText(materials.manufacturer),
  ].filter(Boolean);

  for (const fb of fallbacks) {
    if (normalized.length >= 3) break;
    normalized.push(truncateText(fb, 34));
  }

  while (normalized.length < 3) {
    normalized.push('정밀 분석 및 연구 지원');
  }

  return normalized;
}

function buildPosterVdom(
  width: number,
  height: number,
  copy: PosterCopy,
  materials: PosterMaterials,
  heroBase64: string | null,
  qrBase64: string | null,
) {
  const headline = cleanDisplayText(copy.headline);
  const subheadline = cleanDisplayText(copy.subheadline);
  const equipmentName = cleanDisplayText(materials.equipmentName) || headline;
  const categoryLabel = cleanDisplayText(materials.category || copy.cta || '');
  const specLine = [
    cleanDisplayText(materials.equipmentName),
    cleanDisplayText(materials.modelNumber),
    cleanDisplayText(materials.manufacturer),
  ].filter(Boolean).join(' | ');

  const specChips = buildSpecChips(materials);
  const bullets = normalizeBullets(copy, materials);

  const locationLine = cleanDisplayText(materials.location ? `설치장소 ${materials.location}` : '');
  const contactLine = cleanDisplayText(materials.contact ? `문의 및 예약 ${materials.contact}` : '');
  const priceLine = cleanDisplayText(materials.priceInfo || '');
  const footerMsg = cleanDisplayText(
    copy.supplementary || '홈페이지에서 장비 상세 정보와 사용 안내를 확인할 수 있습니다.'
  );

  const headlineLength = headline.length;
  const hasLongHeadline = headlineLength >= 20;
  const hasVeryLongHeadline = headlineLength >= 28;

  const headlineFontSize = hasVeryLongHeadline ? 56 : hasLongHeadline ? 64 : 72;
  const headlineLineHeight = hasVeryLongHeadline ? 1.04 : 1.08;
  const subheadlineFontSize = hasVeryLongHeadline ? 18 : 20;
  const heroHeight = hasVeryLongHeadline ? 360 : hasLongHeadline ? 390 : 420;
  const imageInset = hasVeryLongHeadline ? 18 : 20;
  const bulletCardMarginTop = hasVeryLongHeadline ? 24 : 30;
  const footerTitleFontSize = 18;
  const footerMetaFontSize = 15;
  const footerNoteFontSize = 13;
  const qrSize = 104;

  const bulletElements = bullets.map((b, i) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        marginBottom: i === bullets.length - 1 ? 0 : 16,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 12,
              height: 12,
              borderRadius: 999,
              backgroundColor: '#7C3AED',
              flexShrink: 0,
              marginTop: 9,
              boxShadow: '0 0 0 4px rgba(168,85,247,0.14)',
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 22,
              fontWeight: 700,
              color: 'white',
              marginLeft: 16,
              flex: 1,
              lineHeight: 1.4,
              wordBreak: 'keep-all' as const,
            },
            children: b,
          },
        },
      ],
    },
  }));

  const chipElements = specChips.slice(0, 5).map((chip) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: '10px 18px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.96)',
        color: '#111827',
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1.2,
        marginRight: 12,
        marginBottom: 12,
        border: '1px solid rgba(148,163,184,0.28)',
      },
      children: chip,
    },
  }));

  const heroElement = heroBase64
    ? {
        type: 'img',
        props: {
          src: heroBase64,
          style: {
            width: '100%',
            height: '100%',
            objectFit: 'contain' as const,
            borderRadius: 24,
            background: '#F8FAFC',
          },
        },
      }
    : {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            background: 'rgba(15,23,42,0.92)',
            borderRadius: 24,
            color: '#94A3B8',
            fontSize: 22,
            fontWeight: 700,
          },
          children: 'IMAGE PREVIEW',
        },
      };

  const contactChildren: any[] = [];
  if (locationLine) {
    contactChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          fontSize: footerTitleFontSize,
          fontWeight: 700,
          color: '#F8FAFC',
          lineHeight: 1.32,
          wordBreak: 'keep-all' as const,
        },
        children: locationLine,
      },
    });
  }
  if (contactLine) {
    contactChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          fontSize: footerTitleFontSize,
          fontWeight: 700,
          color: '#F8FAFC',
          marginTop: 4,
          lineHeight: 1.32,
          wordBreak: 'keep-all' as const,
        },
        children: contactLine,
      },
    });
  }
  if (priceLine) {
    contactChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          fontSize: footerMetaFontSize,
          fontWeight: 400,
          color: '#CBD5E1',
          marginTop: 8,
          lineHeight: 1.34,
          wordBreak: 'keep-all' as const,
        },
        children: truncateText(priceLine, 88),
      },
    });
  }

  const qrElement = qrBase64
    ? {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'column' as const,
            alignItems: 'center',
            marginLeft: 24,
            flexShrink: 0,
          },
          children: [
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  padding: 10,
                  background: 'white',
                  borderRadius: 16,
                  border: '2px solid rgba(124,58,237,0.24)',
                  boxShadow: '0 12px 30px rgba(2,6,23,0.22)',
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
                  fontSize: 14,
                  fontWeight: 700,
                  marginTop: 8,
                  color: '#CBD5E1',
                },
                children: '홈페이지 바로가기',
              },
            },
          ],
        },
      }
    : null;

  const contentChildren: any[] = [];

  const headlineChildren: any[] = [
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          fontSize: headlineFontSize,
          fontWeight: 900,
          lineHeight: headlineLineHeight,
          color: 'white',
          textAlign: 'center' as const,
          padding: '0 20px',
          letterSpacing: -1.6,
          wordBreak: 'keep-all' as const,
          justifyContent: 'center',
        },
        children: headline,
      },
    },
  ];

  if (subheadline) {
    headlineChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          fontSize: subheadlineFontSize,
          fontWeight: 400,
          color: '#CBD5E1',
          marginTop: 10,
          lineHeight: 1.3,
          textAlign: 'center' as const,
          padding: '0 48px',
          wordBreak: 'keep-all' as const,
          justifyContent: 'center',
        },
        children: subheadline,
      },
    });
  }

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        width: '100%',
      },
      children: headlineChildren,
    },
  });

  const heroCardChildren: any[] = [
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          height: heroHeight,
          background: 'rgba(255,255,255,0.76)',
          borderRadius: 28,
          overflow: 'hidden',
          padding: imageInset,
        },
        children: [heroElement],
      },
    },
  ];

  if (specLine) {
    heroCardChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px 18px 0 18px',
        },
        children: [{
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: '100%',
              justifyContent: 'center',
              alignItems: 'center',
              padding: '16px 18px',
              borderRadius: 18,
              background: 'rgba(255,255,255,0.94)',
              color: '#111827',
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1.3,
              textAlign: 'center' as const,
              wordBreak: 'keep-all' as const,
            },
            children: truncateText(specLine, 100),
          },
        }],
      },
    });
  }

  if (chipElements.length > 0) {
    heroCardChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          flexWrap: 'wrap' as const,
          justifyContent: 'center',
          alignItems: 'center',
          padding: '16px 6px 0 6px',
        },
        children: chipElements,
      },
    });
  }

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        marginTop: 22,
        width: '100%',
        borderRadius: 28,
        background: 'linear-gradient(180deg, rgba(148,163,184,0.34) 0%, rgba(30,41,59,0.88) 100%)',
        padding: 18,
        boxShadow: '0 24px 60px rgba(2,6,23,0.28)',
      },
      children: heroCardChildren,
    },
  });

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: bulletCardMarginTop,
        width: '100%',
        borderRadius: 24,
        background: 'rgba(2,6,23,0.54)',
        border: '1px solid rgba(148,163,184,0.22)',
        padding: '30px 32px',
        position: 'relative' as const,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute' as const,
              top: -12,
              left: 24,
              width: 48,
              height: 48,
              borderRadius: 24,
              background: 'linear-gradient(135deg, #A855F7, #F0ABFC)',
              opacity: 0.9,
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
              marginTop: 8,
            },
            children: bulletElements,
          },
        },
      ],
    },
  });

  contentChildren.push({
    type: 'div',
    props: { style: { display: 'flex', flexGrow: 1 }, children: [] },
  });

  const footerRowChildren: any[] = [
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column' as const,
          flex: 1,
          paddingRight: 16,
          minWidth: 0,
        },
        children: contactChildren,
      },
    },
  ];

  if (qrElement) footerRowChildren.push(qrElement);

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        marginTop: 18,
      },
      children: footerRowChildren,
    },
  });

  if (footerMsg) {
    contentChildren.push({
      type: 'div',
      props: {
        style: { display: 'flex', marginTop: 10 },
        children: [{
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: footerNoteFontSize,
              fontWeight: 400,
              color: '#94A3B8',
              lineHeight: 1.32,
            },
            children: truncateText(footerMsg, 118),
          },
        }],
      },
    });
  }

  const decorativeChildren: any[] = [];

  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'linear-gradient(135deg, rgba(2,6,23,0.95) 0%, rgba(8,15,46,0.96) 48%, rgba(3,7,18,0.98) 100%)',
      },
      children: [],
    },
  });

  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: -100,
        right: -140,
        width: 460,
        height: 260,
        transform: 'rotate(24deg)',
        background: 'linear-gradient(135deg, rgba(56,189,248,0.06), rgba(168,85,247,0.18))',
      },
      children: [],
    },
  });

  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 24,
        left: 24,
        right: 24,
        bottom: 24,
        border: '1px solid rgba(148,163,184,0.22)',
        borderRadius: 28,
      },
      children: [],
    },
  });

  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 40,
        right: 36,
        width: 70,
        height: 70,
        borderRadius: 999,
        background: 'linear-gradient(135deg, #A855F7, #F0ABFC)',
        opacity: 0.9,
      },
      children: [],
    },
  });

  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 50,
        right: 46,
        width: 50,
        height: 50,
        borderRadius: 999,
        border: '3px solid rgba(255,255,255,0.22)',
      },
      children: [],
    },
  });

  const contentLayer = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        padding: '38px 52px 52px 52px',
        height: '100%',
        position: 'relative' as const,
        zIndex: 10,
      },
      children: contentChildren,
    },
  };

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        width,
        height,
        color: 'white',
        fontFamily: 'Noto Sans KR',
        position: 'relative' as const,
        overflow: 'hidden',
      },
      children: [...decorativeChildren, contentLayer],
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
          width: 140,
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
        .modulate({ brightness: 0.22, saturation: 1.2 })
        .blur(80)
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
