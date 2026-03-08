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
  const bulletElements = copy.bullets.slice(0, 3).map((b, i) => ({
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'flex-start', marginBottom: i === 2 ? 0 : 20 },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: '#38BDF8', flexShrink: 0, marginTop: 8 },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', fontSize: 22, fontWeight: 700, color: 'white', marginLeft: 16, flex: 1, lineHeight: 1.5, wordBreak: 'keep-all' as const },
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
    props: { style: { display: 'flex', fontSize: 18, fontWeight: 700, color: '#F8FAFC', lineHeight: 1.5, wordBreak: 'keep-all' as const }, children: locationLine },
  });
  if (contactLine) contactChildren.push({
    type: 'div',
    props: { style: { display: 'flex', fontSize: 18, fontWeight: 700, color: '#F8FAFC', marginTop: 4, lineHeight: 1.5, wordBreak: 'keep-all' as const }, children: contactLine },
  });
  if (priceLine) contactChildren.push({
    type: 'div',
    props: { style: { display: 'flex', fontSize: 18, fontWeight: 700, color: '#F8FAFC', marginTop: 4, lineHeight: 1.5, wordBreak: 'keep-all' as const }, children: priceLine },
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

  // 1. Headline section (Centered)
  const headlineChildren: any[] = [];
  headlineChildren.push({
    type: 'div',
    props: {
      style: { display: 'flex', fontSize: 46, fontWeight: 900, lineHeight: 1.25, color: 'white', textAlign: 'center' as const, zIndex: 10, padding: '0 40px', wordBreak: 'keep-all' as const },
      children: headline,
    },
  });
  // Subheadline (English thin subheadline right below)
  if (subheadline) {
    headlineChildren.push({
      type: 'div',
      props: {
        style: { display: 'flex', fontSize: 22, fontWeight: 400, color: '#CBD5E1', marginTop: 12, lineHeight: 1.4, textAlign: 'center' as const, zIndex: 10, padding: '0 60px', wordBreak: 'keep-all' as const },
        children: subheadline,
      },
    });
  }
  contentChildren.push({
    type: 'div',
    props: { style: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', width: '100%' }, children: headlineChildren },
  });

  // 2. Hero image card with Spec badge inside bottom
  const heroCardChildren: any[] = [];
  heroCardChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: '100%',
        height: 400, // Made taller so 4:3 images don't look squished, leaving no ugly white boxes
        background: 'rgba(255,255,255,0.03)', // Subtle transparent instead of harsh white
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
        borderBottomLeftRadius: specText ? 0 : 18,
        borderBottomRightRadius: specText ? 0 : 18,
        overflow: 'hidden',
        padding: 10, // Slight padding around the image inside the card
      },
      children: [heroElement],
    },
  });

  if (specText) {
    heroCardChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px 24px',
          background: 'rgba(226, 232, 240, 0.95)', // light grey bar
          borderBottomLeftRadius: 18,
          borderBottomRightRadius: 18,
        },
        children: [{
          type: 'div',
          props: { style: { display: 'flex', fontSize: 16, fontWeight: 700, color: '#1E293B', textAlign: 'center' as const, lineHeight: 1.5, wordBreak: 'keep-all' as const }, children: specText },
        }],
      },
    });
  }

  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        marginTop: 24,
        width: '100%',
        borderRadius: 20,
        background: 'linear-gradient(135deg, rgba(255,255,255,0.2) 0%, rgba(56,189,248,0.3) 100%)', // Enhanced glowing border
        padding: 4, // creates the border effect
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' as const, borderRadius: 16, overflow: 'hidden' },
            children: heroCardChildren
          }
        }
      ],
    },
  });

  // 3. Bullet points card
  contentChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        marginTop: 20,
        width: '100%',
        borderRadius: 20,
        background: 'linear-gradient(135deg, rgba(56,189,248,0.3) 0%, rgba(255,255,255,0.05) 100%)', // gradient border
        padding: 3, // glowing border thickness
        position: 'relative' as const,
      },
      children: [
        // Decorator circle on top-left of the bullet card
        {
          type: 'div',
          props: {
            style: { display: 'flex', position: 'absolute' as const, top: -35, left: 40, width: 70, height: 70, borderRadius: 35, background: '#38BDF8', opacity: 0.8 },
            children: [],
          }
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' as const, width: '100%', padding: '36px 40px', borderRadius: 18, background: 'rgba(15,23,42,0.85)' },
            children: bulletElements,
          }
        }
      ],
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
          style: { display: 'flex', fontSize: 14, fontWeight: 400, color: '#64748B', lineHeight: 1.5 },
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

  // 2. Top-right accent circle (mint/cyan) - large and bleeding off edge
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        top: -40, right: -40,
        width: 160, height: 160,
        borderRadius: 80,
        background: 'linear-gradient(135deg, #38BDF8, #06B6D4)',
        opacity: 0.8,
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
        top: -24, right: -24,
        width: 128, height: 128,
        borderRadius: 64,
        border: '6px solid rgba(255,255,255,0.25)',
      },
      children: [],
    },
  });

  // 3. Bottom-left small circle - removing the awkward dark blue one and making it subtle
  decorativeChildren.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'absolute' as const,
        bottom: 80, left: -20,
        width: 80, height: 80,
        borderRadius: 40,
        background: 'rgba(56,189,248,0.08)', // very subtle
        border: '2px solid rgba(56,189,248,0.15)',
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
        overflow: 'hidden', // Ensure circles bleeding off edges are clipped cleanly
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
