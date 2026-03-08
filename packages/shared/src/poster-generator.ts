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
      headers: { 'User-Agent': 'poster-auto-generator/2.2' },
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

function sanitizeDisplayText(value?: string): string {
  if (!value) return '';

  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[|]+/g, ' | ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/[•▪■◆▶▷]/g, '·')
    .replace(/�/g, '')
    .replace(/□/g, '')
    .replace(/×/g, '×')
    .replace(/x(?=\d)/gi, '×')
    .replace(/(?<=\d) ?um\b/gi, 'μm')
    .replace(/(?<=\d) ?nm\b/gi, 'nm')
    .replace(/(?<=\d) ?cm\b/gi, 'cm')
    .replace(/(?<=\d) ?mm\b/gi, 'mm')
    .replace(/(?<=\d) ?μ m\b/gi, 'μm')
    .replace(/(?<=\d) ?m\b/g, 'm')
    .replace(/-90\s*냉각/g, '-90℃ 냉각')
    .replace(/([0-9])\s*[x×]\s*([0-9])/g, '$1×$2')
    .replace(/([0-9])\s*~\s*([0-9])/g, '$1~$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildStructuredSpecs(materials: PosterMaterials): string[] {
  const specs: string[] = [];

  const equipment = sanitizeDisplayText(materials.equipmentName);
  const manufacturer = sanitizeDisplayText(materials.manufacturer);
  const model = sanitizeDisplayText(materials.modelNumber);
  const category = sanitizeDisplayText(materials.category);
  const specification = sanitizeDisplayText(materials.specification);

  if (manufacturer) specs.push(manufacturer);
  if (model) specs.push(model);
  if (category) specs.push(category);

  if (specification) {
    const splitSpecs = specification
      .split(/\s*\|\s*|\s*\/\s*|\s*;\s*/)
      .map((item) => sanitizeDisplayText(item))
      .filter(Boolean)
      .filter((item) => item !== equipment && item !== manufacturer && item !== model);

    for (const item of splitSpecs) {
      if (specs.length >= 6) break;
      if (!specs.includes(item)) specs.push(item);
    }
  }

  return specs.slice(0, 6);
}

function buildBenefitBullets(copy: PosterCopy, materials: PosterMaterials): string[] {
  const normalized = (copy.bullets || [])
    .map((item) => sanitizeDisplayText(item))
    .filter(Boolean)
    .slice(0, 3);

  if (normalized.length === 3) return normalized;

  const fallbackPool = [
    sanitizeDisplayText(materials.category),
    sanitizeDisplayText(materials.description),
    sanitizeDisplayText(materials.specification),
    sanitizeDisplayText(materials.location) ? `${sanitizeDisplayText(materials.location)} 설치` : '',
    '연구 장비 공동활용',
    '상세 조건 별도 안내',
    '홈페이지에서 예약 확인',
  ]
    .filter(Boolean)
    .map((item) => item.length > 26 ? `${item.slice(0, 24).trim()}…` : item);

  for (const item of fallbackPool) {
    if (normalized.length >= 3) break;
    if (!normalized.includes(item)) normalized.push(item);
  }

  while (normalized.length < 3) {
    normalized.push(['전문 연구 지원', '공동활용 장비 운영', '사용 문의 가능'][normalized.length]);
  }

  return normalized.slice(0, 3);
}

function buildContactLines(materials: PosterMaterials): string[] {
  const lines: string[] = [];

  const location = sanitizeDisplayText(materials.location);
  if (location) lines.push(`설치장소  ${location}`);

  const contact = sanitizeDisplayText(materials.contact);
  if (contact) lines.push(`문의 및 예약  ${contact}`);

  const supplementary = sanitizeDisplayText(materials.availability || materials.priceInfo);
  if (supplementary) lines.push(supplementary);

  return lines.slice(0, 3);
}

function pickEnglishLine(copy: PosterCopy, materials: PosterMaterials): string {
  const options = [
    sanitizeDisplayText(copy.subheadline),
    [sanitizeDisplayText(materials.equipmentName), sanitizeDisplayText(materials.manufacturer)]
      .filter(Boolean)
      .join(' | '),
    'Advanced Research Equipment Access',
  ].filter(Boolean);

  return options[0] || 'Advanced Research Equipment Access';
}

function ellipsize(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function buildPosterVdom(
  width: number,
  height: number,
  copy: PosterCopy,
  template: PosterTemplate,
  materials: PosterMaterials,
  heroBase64: string | null,
  qrBase64: string | null,
) {
  const accent = template.colorScheme.accent || '#38BDF8';
  const accentSoft = `${accent}22`;
  const accentLine = `${accent}55`;
  const headline = ellipsize(sanitizeDisplayText(copy.headline || materials.equipmentName || '첨단 연구장비 공동활용'), 34);
  const englishLine = ellipsize(pickEnglishLine(copy, materials), 62);
  const equipmentLabel = ellipsize(
    sanitizeDisplayText(
      [materials.equipmentName, materials.modelNumber, materials.manufacturer].filter(Boolean).join(' | '),
    ) || '연구 장비 정보',
    90,
  );
  const specItems = buildStructuredSpecs(materials);
  const bullets = buildBenefitBullets(copy, materials);
  const contactLines = buildContactLines(materials);
  const footerMessage = ellipsize(
    sanitizeDisplayText(copy.supplementary) ||
      '맞춤의약연구원 홈페이지에서 장비 상세 정보와 이용 절차를 확인할 수 있습니다.',
    80,
  );

  const heroContent = heroBase64
    ? {
        type: 'img',
        props: {
          src: heroBase64,
          style: {
            width: '100%',
            height: '100%',
            objectFit: 'contain' as const,
            objectPosition: 'center center' as const,
          },
        },
      }
    : {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            width: '100%',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.72))',
            color: '#94A3B8',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: 0.2,
          },
          children: 'IMAGE PREVIEW',
        },
      };

  const bulletNodes = bullets.map((item, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        marginBottom: index === bullets.length - 1 ? 0 : 22,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 12,
              height: 12,
              marginTop: 12,
              marginRight: 16,
              borderRadius: 999,
              background: accent,
              boxShadow: `0 0 0 6px ${accentSoft}`,
              flexShrink: 0,
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flex: 1,
              color: '#F8FAFC',
              fontSize: 27,
              fontWeight: 700,
              lineHeight: 1.45,
              wordBreak: 'keep-all' as const,
            },
            children: item,
          },
        },
      ],
    },
  }));

  const specNodes = specItems.map((item) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        padding: '10px 16px',
        marginRight: 10,
        marginBottom: 10,
        borderRadius: 999,
        background: 'rgba(241,245,249,0.92)',
        border: `1px solid ${accentLine}`,
        color: '#0F172A',
        fontSize: 17,
        fontWeight: 700,
        lineHeight: 1.2,
      },
      children: item,
    },
  }));

  const contactNodes = contactLines.map((item, index) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        fontSize: index === 0 ? 26 : 24,
        fontWeight: index < 2 ? 700 : 500,
        color: index < 2 ? '#F8FAFC' : '#CBD5E1',
        lineHeight: 1.45,
        marginBottom: index === contactLines.length - 1 ? 0 : 8,
        wordBreak: 'keep-all' as const,
      },
      children: item,
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
            width: 168,
            padding: '14px 14px 10px',
            borderRadius: 18,
            background: 'rgba(255,255,255,0.96)',
            border: `2px solid ${accentLine}`,
            boxShadow: '0 12px 30px rgba(2,6,23,0.30)',
          },
          children: [
            {
              type: 'img',
              props: {
                src: qrBase64,
                width: 132,
                height: 132,
              },
            },
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  marginTop: 8,
                  color: '#0F172A',
                  fontSize: 15,
                  fontWeight: 700,
                  textAlign: 'center' as const,
                },
                children: '홈페이지 바로가기',
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
        background: 'linear-gradient(145deg, #06132A 0%, #0A1C3C 46%, #081224 100%)',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute' as const,
              inset: 0,
              background: 'linear-gradient(180deg, rgba(6,19,42,0.35) 0%, rgba(2,6,23,0.68) 100%)',
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
              top: -130,
              right: -70,
              width: 420,
              height: 260,
              transform: 'rotate(18deg)',
              background: `linear-gradient(180deg, ${accentLine}, transparent)`,
              opacity: 0.55,
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
              left: 26,
              top: 26,
              right: 26,
              bottom: 26,
              borderRadius: 26,
              border: '1px solid rgba(255,255,255,0.22)',
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
              top: 46,
              right: 56,
              width: 62,
              height: 62,
              borderRadius: 999,
              background: accent,
              boxShadow: `0 0 0 10px ${accentSoft}`,
              opacity: 0.95,
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
              left: 44,
              bottom: 74,
              width: 220,
              height: 220,
              borderRadius: 999,
              background: `radial-gradient(circle, ${accentSoft} 0%, transparent 68%)`,
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
              position: 'relative' as const,
              zIndex: 2,
              width: '100%',
              height: '100%',
              padding: '56px 60px 42px',
              color: '#FFFFFF',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column' as const,
                    alignItems: 'center',
                    textAlign: 'center' as const,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          color: '#F8FAFC',
                          fontSize: 56,
                          fontWeight: 900,
                          lineHeight: 1.15,
                          letterSpacing: -1.2,
                          maxWidth: 900,
                          wordBreak: 'keep-all' as const,
                        },
                        children: headline,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          marginTop: 14,
                          color: '#D6E2F0',
                          fontSize: 21,
                          fontWeight: 400,
                          lineHeight: 1.35,
                          maxWidth: 820,
                          wordBreak: 'keep-all' as const,
                        },
                        children: englishLine,
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
                    flexDirection: 'column' as const,
                    marginTop: 34,
                    borderRadius: 28,
                    padding: 18,
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.10) 100%)',
                    boxShadow: '0 24px 60px rgba(2,6,23,0.36)',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          height: height >= 1800 ? 650 : 470,
                          borderRadius: 22,
                          padding: 20,
                          background: 'linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(241,245,249,0.96) 100%)',
                          overflow: 'hidden',
                        },
                        children: [heroContent],
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          marginTop: 16,
                          padding: '18px 22px',
                          borderRadius: 18,
                          background: 'rgba(255,255,255,0.94)',
                          color: '#0F172A',
                          fontSize: 19,
                          fontWeight: 700,
                          justifyContent: 'center',
                          textAlign: 'center' as const,
                          lineHeight: 1.4,
                          wordBreak: 'keep-all' as const,
                        },
                        children: equipmentLabel,
                      },
                    },
                    specNodes.length > 0
                      ? {
                          type: 'div',
                          props: {
                            style: {
                              display: 'flex',
                              flexWrap: 'wrap' as const,
                              marginTop: 16,
                              justifyContent: 'center',
                            },
                            children: specNodes,
                          },
                        }
                      : {
                          type: 'div',
                          props: { style: { display: 'none' }, children: [] },
                        },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column' as const,
                    marginTop: 28,
                    borderRadius: 24,
                    padding: '34px 34px 32px',
                    background: 'rgba(8,18,36,0.70)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    boxShadow: '0 18px 48px rgba(2,6,23,0.24)',
                  },
                  children: bulletNodes,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexGrow: 1,
                  },
                  children: [],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-end',
                    marginTop: 24,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexDirection: 'column' as const,
                          flex: 1,
                          paddingRight: 22,
                        },
                        children: [
                          ...contactNodes,
                          {
                            type: 'div',
                            props: {
                              style: {
                                display: 'flex',
                                marginTop: 16,
                                color: '#D5E1EE',
                                fontSize: 18,
                                fontWeight: 400,
                                lineHeight: 1.45,
                                maxWidth: 720,
                              },
                              children: footerMessage,
                            },
                          },
                        ],
                      },
                    },
                    qrNode || {
                      type: 'div',
                      props: { style: { display: 'none' }, children: [] },
                    },
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
          width: 144,
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
        .modulate({ brightness: 0.28, saturation: 1.15 })
        .blur(80)
        .png()
        .toBuffer();
    } catch {
      blurredBgBuffer = await sharp({
        create: { width, height, channels: 4, background: '#081224' },
      })
        .png()
        .toBuffer();
    }
  } else {
    blurredBgBuffer = await sharp({
      create: { width, height, channels: 4, background: '#081224' },
    })
      .png()
      .toBuffer();
  }

  const vdom = buildPosterVdom(width, height, copy, template, materials, heroBase64, qrBase64);

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
