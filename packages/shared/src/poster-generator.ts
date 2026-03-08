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
        if (!response.ok) { console.warn(`[PosterGenerator] HTTP ${response.status}`); continue; }
        const buf = await response.arrayBuffer();
        if (buf.byteLength < MIN_FONT_FILE_SIZE) { console.warn(`[PosterGenerator] Font too small`); continue; }
        fs.writeFileSync(fontPath, Buffer.from(buf));
        console.log(`[PosterGenerator] Font weight ${weight} downloaded (${buf.byteLength} bytes)`);
        downloaded = true;
        break;
      } catch (e) { console.warn(`[PosterGenerator] Failed:`, e); }
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

/**
 * Build Satori-compatible React-like VDOM tree directly (no satori-html).
 * This avoids all HTML escaping / parsing issues.
 */
function buildPosterVdom(
  width: number,
  height: number,
  copy: PosterCopy,
  materials: PosterMaterials,
  heroBase64: string | null,
  qrBase64: string | null,
) {
  const headline = copy.headline;
  const subheadline = copy.subheadline;
  const categoryLabel = materials.category || copy.cta || '';

  // Build spec text
  const specParts = [materials.equipmentName, materials.manufacturer, materials.modelNumber, materials.specification].filter(Boolean);
  const specText = specParts.join(' | ');

  const locationLine = materials.location ? `설치장소 : ${materials.location}` : '';
  const contactLine = materials.contact ? `담당자 : ${materials.contact}` : '';
  const priceLine = materials.priceInfo || '';
  const footerMsg = copy.supplementary || '맞춤의약연구원에서 사용요금을 내고 사용 가능하며, 예약은 맞춤의약연구원 회원가입 후 예약하여 담당교수님 확인 완료 후 사용 가능합니다.';

  // Build bullet elements
  const bulletElements = copy.bullets.slice(0, 3).map(b => ({
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'center', marginBottom: 14 },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: '#38BDF8', flexShrink: 0 },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: { fontSize: 26, fontWeight: 700, color: 'white', marginLeft: 18 },
            children: b,
          },
        },
      ],
    },
  }));

  // Hero image element
  const heroElement = heroBase64
    ? {
      type: 'img',
      props: {
        src: heroBase64,
        style: { width: '100%', height: '100%', objectFit: 'contain' as const },
      },
    }
    : {
      type: 'div',
      props: {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: 'rgba(30,41,59,0.8)', color: '#64748B', fontSize: 22 },
        children: 'REFERENCE IMAGE PREVIEW',
      },
    };

  // Contact info children
  const contactChildren: any[] = [];
  if (locationLine) contactChildren.push({
    type: 'div',
    props: { style: { fontSize: 20, fontWeight: 700, color: '#E2E8F0', lineHeight: 1.4 }, children: locationLine },
  });
  if (contactLine) contactChildren.push({
    type: 'div',
    props: { style: { fontSize: 20, fontWeight: 700, color: '#E2E8F0', marginTop: 6, lineHeight: 1.4 }, children: contactLine },
  });
  if (priceLine) contactChildren.push({
    type: 'div',
    props: { style: { fontSize: 20, fontWeight: 700, color: '#E2E8F0', marginTop: 6, lineHeight: 1.4 }, children: priceLine },
  });

  // QR element
  const qrElement = qrBase64
    ? {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center' },
        children: [
          {
            type: 'div',
            props: {
              style: { display: 'flex', padding: 14, background: 'white', borderRadius: 16 },
              children: [{
                type: 'img',
                props: { src: qrBase64, width: 120, height: 120 },
              }],
            },
          },
          {
            type: 'div',
            props: {
              style: { fontSize: 15, fontWeight: 700, marginTop: 8, color: '#94A3B8' },
              children: '홈페이지 바로가기',
            },
          },
        ],
      },
    }
    : null;

  // Top-level content children
  const contentChildren: any[] = [];

  // 1. Headline section
  const headlineChildren: any[] = [];
  // Category label above headline (like reference)
  if (categoryLabel) {
    headlineChildren.push({
      type: 'div',
      props: {
        style: { fontSize: 18, fontWeight: 900, color: '#38BDF8', letterSpacing: 4, marginBottom: 16, textTransform: 'uppercase' as const },
        children: categoryLabel,
      },
    });
  }
  headlineChildren.push({
    type: 'div',
    props: {
      style: { fontSize: 60, fontWeight: 900, lineHeight: 1.15, color: 'white' },
      children: headline,
    },
  });
  // Subheadline
  if (subheadline) {
    headlineChildren.push({
      type: 'div',
      props: {
        style: { fontSize: 24, fontWeight: 400, color: '#94A3B8', marginTop: 12, lineHeight: 1.4 },
        children: subheadline,
      },
    });
  }
  contentChildren.push({
    type: 'div',
    props: { style: { display: 'flex', flexDirection: 'column' as const }, children: headlineChildren },
  });

  // 2. Hero image card
  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: 28,
        width: '100%',
        height: 330, // Reduced from 380 to give more bottom space
        borderRadius: 24,
        overflow: 'hidden',
        background: 'white', // White background for contain
        border: '2px solid rgba(255,255,255,0.12)',
        flexShrink: 1,
      },
      children: [heroElement],
    },
  });

  // 3. Spec badge
  if (specText) {
    contentChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          marginTop: 16,
          padding: '14px 28px',
          background: 'rgba(255,255,255,0.92)',
          borderRadius: 14,
          maxWidth: '100%',
        },
        children: [{
          type: 'div',
          props: { style: { fontSize: 20, fontWeight: 700, color: '#0F172A', lineHeight: 1.4 }, children: specText },
        }],
      },
    });
  }

  // 4. Bullet points card
  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        marginTop: 24,
        padding: '32px 36px',
        borderRadius: 24,
        background: 'rgba(30,58,95,0.35)',
        border: '2px solid rgba(56,189,248,0.2)',
      },
      children: bulletElements,
    },
  });

  // 5. Spacer
  contentChildren.push({
    type: 'div',
    props: { style: { display: 'flex', flexGrow: 1 }, children: [] },
  });

  // 6. Footer: contact + QR
  const footerRowChildren: any[] = [];
  footerRowChildren.push({
    type: 'div',
    props: { style: { display: 'flex', flexDirection: 'column' as const, maxWidth: 780 }, children: contactChildren },
  });
  if (qrElement) footerRowChildren.push(qrElement);

  contentChildren.push({
    type: 'div',
    props: {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 16 },
      children: footerRowChildren,
    },
  });

  // 7. Footer message
  contentChildren.push({
    type: 'div',
    props: {
      style: { display: 'flex', marginTop: 12 },
      children: [{
        type: 'div',
        props: {
          style: { fontSize: 14, fontWeight: 400, color: '#64748B', lineHeight: 1.5 },
          children: footerMsg,
        },
      }],
    },
  });

  // ============================================================
  // BACKGROUND + DECORATIVE LAYERS
  // ============================================================
  const decorativeChildren: any[] = [];

  // 1. Dark overlay gradient
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'linear-gradient(135deg, rgba(15,23,42,0.8), rgba(2,6,23,0.9), rgba(15,23,42,0.8))',
      },
      children: [],
    },
  });

  // 2. Top-right accent circle (mint/cyan)
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 50, right: 50,
        width: 80, height: 80,
        borderRadius: 40,
        background: 'linear-gradient(135deg, #38BDF8, #06B6D4)',
        opacity: 0.9,
      },
      children: [],
    },
  });
  // Inner ring for top-right circle
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 58, right: 58,
        width: 64, height: 64,
        borderRadius: 32,
        border: '4px solid rgba(255,255,255,0.25)',
      },
      children: [],
    },
  });

  // 3. Bottom-left small circle
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        bottom: 120, left: 40,
        width: 48, height: 48,
        borderRadius: 24,
        background: 'rgba(56,189,248,0.15)',
        border: '3px solid rgba(56,189,248,0.3)',
      },
      children: [],
    },
  });

  // 4. Subtle diagonal accent lines
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: 0, right: 200,
        width: 2, height: 250,
        background: 'linear-gradient(to bottom, rgba(56,189,248,0.3), transparent)',
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
        bottom: 0, left: 200,
        width: 2, height: 200,
        background: 'linear-gradient(to top, rgba(56,189,248,0.2), transparent)',
      },
      children: [],
    },
  });

  // ========== CONTENT LAYER ========== 
  const contentLayer = {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column' as const, padding: '56px 52px 40px 52px', height: '100%', position: 'relative' as const, zIndex: 10 },
      children: contentChildren,
    },
  };

  // Root
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        width: width,
        height: height,
        color: 'white',
        fontFamily: 'Noto Sans KR',
        position: 'relative' as const,
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

  // Render deeply blurred background layer
  let blurredBgBuffer: Buffer;
  if (materials.referenceImageUrl) {
    try {
      const res = await fetchWithTimeout(materials.referenceImageUrl, IMAGE_FETCH_TIMEOUT_MS);
      const bgArrayBuffer = await res.arrayBuffer();
      blurredBgBuffer = await sharp(Buffer.from(bgArrayBuffer))
        .resize(width, height, { fit: 'cover' })
        .modulate({ brightness: 0.25, saturation: 1.6 })
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

  // Build React-like VDOM tree directly (bypasses satori-html escaping issues)
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
