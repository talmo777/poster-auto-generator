/**
 * Poster Generator
 *
 * 코드 렌더링 기반 포스터 생성
 * - 실제 이미지 URL 사용
 * - bookingLink -> QR 삽입
 * - SVG UTF-8 렌더 안정화
 * - QR 가시성 보정
 */

import sharp from 'sharp';
import QRCode from 'qrcode';
import type {
  PosterCopy,
  PosterMaterials,
  PosterTemplate,
  PosterResult,
} from './types.js';
import { PROMPT_VERSION } from './copy-generator.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const IMAGE_FETCH_TIMEOUT_MS = 12000;
const QR_DARK_COLOR = '#0F172A';
const QR_LIGHT_COLOR = '#FFFFFF';
const FONT_STACK =
  "Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, NanumGothic, sans-serif";

const FONT_FILES = [
  {
    filename: 'NotoSansKR-Regular.otf',
    url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf',
  },
  {
    filename: 'NotoSansKR-Bold.otf',
    url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf',
  },
];

export function generateSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

export async function ensureLocalFont() {
  const fontDir = path.join(os.tmpdir(), 'poster-fonts');
  const fontConfigPath = path.join(fontDir, 'fonts.conf');

  if (!fs.existsSync(fontDir)) {
    fs.mkdirSync(fontDir, { recursive: true });
  }

  for (const font of FONT_FILES) {
    const fontPath = path.join(fontDir, font.filename);
    if (!fs.existsSync(fontPath)) {
      console.log(`[PosterGenerator] Downloading ${font.filename} to ${fontPath}...`);
      try {
        const response = await fetchWithTimeout(font.url, 30000);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(fontPath, Buffer.from(buffer));
          console.log(`[PosterGenerator] ${font.filename} downloaded.`);
        } else {
          console.error(`[PosterGenerator] Font download failed for ${font.filename} with status ${response.status}: ${font.url}`);
        }
      } catch (e) {
        console.error(`[PosterGenerator] Failed to download ${font.filename}:`, e);
      }
    }
  }

  if (!fs.existsSync(fontConfigPath)) {
    const fontConfigXml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
</fontconfig>`;
    fs.writeFileSync(fontConfigPath, fontConfigXml);
  }

  process.env.FONTCONFIG_PATH = fontDir;
}

export async function generatePoster(
  copy: PosterCopy,
  template: PosterTemplate,
  materials: PosterMaterials,
  _geminiApiKey?: string,
  seed?: number,
): Promise<PosterResult> {
  await ensureLocalFont();

  const actualSeed = seed ?? generateSeed();
  const { width, height } = getCanvasSize(template.aspectRatio);

  const heroArea = getHeroArea(width, height);
  const panelArea = getPanelArea(width, height);
  const qrArea = getQrArea(width, height);

  const heroImageBuffer = await buildHeroImage(
    materials.referenceImageUrl,
    heroArea.width,
    heroArea.height,
    template,
  );

  const qrBuffer = materials.bookingLink
    ? await QRCode.toBuffer(materials.bookingLink, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: qrArea.size,
      color: {
        dark: QR_DARK_COLOR,
        light: QR_LIGHT_COLOR,
      },
    })
    : null;

  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: hexToRgbObject(template.colorScheme.background),
    },
  });

  const composites: sharp.OverlayOptions[] = [];

  composites.push({
    input: svgToBuffer(buildBackgroundSvg(width, height, template)),
    top: 0,
    left: 0,
  });

  composites.push({
    input: svgToBuffer(buildRoundedRectSvg(heroArea.width, heroArea.height, 36, '#FFFFFF12')),
    top: heroArea.top - 8,
    left: heroArea.left - 8,
  });

  composites.push({
    input: heroImageBuffer,
    top: heroArea.top,
    left: heroArea.left,
  });

  composites.push({
    input: svgToBuffer(
      buildGradientOverlaySvg(heroArea.width, heroArea.height, 32, [
        { offset: '0%', color: '#00000000' },
        { offset: '70%', color: '#0000001A' },
        { offset: '100%', color: '#00000080' },
      ]),
    ),
    top: heroArea.top,
    left: heroArea.left,
  });

  composites.push({
    input: svgToBuffer(
      buildRoundedRectSvg(
        panelArea.width,
        panelArea.height,
        32,
        addAlpha(template.colorScheme.secondary, 0.45),
        addAlpha(template.colorScheme.accent, 0.65),
      ),
    ),
    top: panelArea.top,
    left: panelArea.left,
  });

  composites.push({
    input: svgToBuffer(
      buildPosterTextSvg(width, height, copy, materials, template, {
        heroArea,
        panelArea,
        qrArea,
        hasQr: !!qrBuffer,
      }),
    ),
    top: 0,
    left: 0,
  });

  if (qrBuffer) {
    composites.push({
      input: await sharp(qrBuffer)
        .resize(qrArea.size, qrArea.size, { fit: 'contain' })
        .png()
        .toBuffer(),
      top: qrArea.top,
      left: qrArea.left,
    });
  }

  const imageBuffer = await base.composite(composites).png().toBuffer();

  return {
    imageBuffer,
    copy,
    templateId: template.id,
    seed: actualSeed,
    promptVersion: PROMPT_VERSION,
  };
}

function getCanvasSize(aspectRatio: '4:5' | '9:16'): { width: number; height: number } {
  if (aspectRatio === '9:16') {
    return { width: 1080, height: 1920 };
  }
  return { width: 1080, height: 1350 };
}

function getHeroArea(width: number, height: number) {
  return {
    left: 68,
    top: 170,
    width: width - 136,
    height: Math.round(height * 0.34),
  };
}

function getPanelArea(width: number, height: number) {
  return {
    left: 56,
    top: Math.round(height * 0.60),
    width: width - 112,
    height: Math.round(height * 0.22),
  };
}

function getQrArea(width: number, height: number) {
  return {
    left: width - 220,
    top: height - 210,
    size: 132,
  };
}

async function buildHeroImage(
  imageUrl: string | undefined,
  width: number,
  height: number,
  template: PosterTemplate,
): Promise<Buffer> {
  const fallback = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: hexToRgbObject(template.colorScheme.primary),
    },
  })
    .composite([
      {
        input: svgToBuffer(buildFallbackHeroSvg(width, height, template)),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  if (!imageUrl) {
    return fallback;
  }

  try {
    const imageResponse = await fetchWithTimeout(imageUrl, IMAGE_FETCH_TIMEOUT_MS);
    if (!imageResponse.ok) {
      throw new Error(`Image fetch failed: ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const remoteBuffer = Buffer.from(arrayBuffer);

    return await sharp(remoteBuffer)
      .resize(width, height, {
        fit: 'cover',
        position: 'centre',
      })
      .composite([
        {
          input: svgToBuffer(buildRoundedMaskSvg(width, height, 28)),
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer();
  } catch (error) {
    console.warn(`[PosterGenerator] Hero image fallback used: ${String(error)}`);
    return fallback;
  }
}

function buildPosterTextSvg(
  width: number,
  height: number,
  copy: PosterCopy,
  materials: PosterMaterials,
  template: PosterTemplate,
  layout: {
    heroArea: { left: number; top: number; width: number; height: number };
    panelArea: { left: number; top: number; width: number; height: number };
    qrArea: { left: number; top: number; size: number };
    hasQr: boolean;
  },
): string {
  const headlineLines = wrapText(copy.headline, 18, 2);
  const subheadlineLines = wrapText(copy.subheadline, 32, 2);
  const supplementaryLines = wrapText(copy.supplementary, 40, 2);

  const bulletItems = copy.bullets.slice(0, 3);
  const brandLine = escapeXml(
    materials.category || fixedBrandLine(materials) || '한양맞춤의약연구원 연구장비 공동활용',
  );
  const specLine = escapeXml(
    normalizeFooterLine([
      materials.manufacturer,
      materials.modelNumber,
      materials.specification,
    ]) || '',
  );
  const contactLine = escapeXml(
    normalizeFooterLine([materials.contact]) || '문의 정보는 센터 홈페이지에서 확인하세요.',
  );
  const locationLine = escapeXml(
    normalizeFooterLine([materials.location]) || '센터 운영 기준에 따라 이용 가능합니다.',
  );
  const priceLine = escapeXml(
    normalizeFooterLine([materials.priceInfo]) || '이용 조건 및 비용은 별도 안내됩니다.',
  );

  const qrTitle = layout.hasQr ? escapeXml(copy.cta) : '센터 문의';
  const qrSubtitle = layout.hasQr
    ? 'QR 스캔 후 상세 정보 확인'
    : '홈페이지 URL 미연결';
  const footerTag = layout.hasQr ? 'ONLINE BOOKING' : 'INQUIRY AVAILABLE';

  const headlineSvg = renderLines(headlineLines, {
    x: 72,
    y: 84,
    lineHeight: 72,
    fontSize: 60,
    weight: 800,
    fill: template.colorScheme.text,
  });

  const subheadlineSvg = renderLines(subheadlineLines, {
    x: 72,
    y: 84 + headlineLines.length * 72 + 24,
    lineHeight: 46,
    fontSize: 34,
    weight: 500,
    fill: addAlpha(template.colorScheme.text, 0.95),
  });

  const supplementarySvg = renderLines(supplementaryLines, {
    x: 84,
    y: layout.panelArea.top + layout.panelArea.height - 42,
    lineHeight: 30,
    fontSize: 21,
    weight: 500,
    fill: addAlpha('#FFFFFF', 0.88),
  });

  const bulletSvg = bulletItems
    .map((item, index) => {
      const bulletY = layout.panelArea.top + 54 + index * 54;
      return `
        <circle cx="98" cy="${bulletY - 6}" r="8" fill="${template.colorScheme.accent}" />
        <text x="120" y="${bulletY}" font-size="28" font-weight="700" fill="#FFFFFF"
          font-family="${FONT_STACK}">${escapeXml(item)}</text>
      `;
    })
    .join('');

  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" lang="ko">
    <defs>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000000" flood-opacity="0.22"/>
      </filter>
    </defs>

    <text x="72" y="44" font-size="18" font-weight="700" letter-spacing="3"
      fill="${template.colorScheme.accent}"
      font-family="${FONT_STACK}">${escapeXml(footerTag)}</text>

    ${headlineSvg}
    ${subheadlineSvg}

    <text x="72" y="${layout.heroArea.top - 22}" font-size="18" font-weight="700" letter-spacing="2"
      fill="${addAlpha(template.colorScheme.text, 0.8)}"
      font-family="${FONT_STACK}">${brandLine}</text>

    ${specLine
      ? `<rect x="72" y="${layout.heroArea.top + layout.heroArea.height - 60}" rx="14" ry="14" width="${Math.min(
        layout.heroArea.width - 48,
        Math.max(320, specLine.length * 12),
      )}" height="40" fill="#FFFFFFD9" filter="url(#softShadow)" />
           <text x="92" y="${layout.heroArea.top + layout.heroArea.height - 33}" font-size="20" font-weight="700"
             fill="${template.colorScheme.primary}"
             font-family="${FONT_STACK}">${specLine}</text>`
      : ''
    }

    <text x="84" y="${layout.panelArea.top + 28}" font-size="20" font-weight="700" letter-spacing="2"
      fill="${addAlpha('#FFFFFF', 0.82)}"
      font-family="${FONT_STACK}">KEY BENEFITS</text>

    ${bulletSvg}
    ${supplementarySvg}

    <text x="72" y="${height - 166}" font-size="19" font-weight="700" fill="${addAlpha(
      template.colorScheme.text,
      0.88,
    )}"
      font-family="${FONT_STACK}">${escapeXml(locationLine)}</text>

    <text x="72" y="${height - 132}" font-size="19" font-weight="600" fill="${addAlpha(
      template.colorScheme.text,
      0.82,
    )}"
      font-family="${FONT_STACK}">${escapeXml(contactLine)}</text>

    <text x="72" y="${height - 98}" font-size="19" font-weight="600" fill="${addAlpha(
      template.colorScheme.text,
      0.82,
    )}"
      font-family="${FONT_STACK}">${escapeXml(priceLine)}</text>

    <rect x="${layout.qrArea.left - 20}" y="${layout.qrArea.top - 20}" rx="24" ry="24" width="${layout.qrArea.size + 40
    }" height="${layout.qrArea.size + 40}" fill="#FFFFFF" />
    <text x="${layout.qrArea.left - 6}" y="${layout.qrArea.top - 36}" font-size="24" font-weight="800"
      fill="${template.colorScheme.text}"
      font-family="${FONT_STACK}">${qrTitle}</text>
    <text x="${layout.qrArea.left - 6}" y="${layout.qrArea.top - 10}" font-size="16" font-weight="600"
      fill="${addAlpha(template.colorScheme.text, 0.72)}"
      font-family="${FONT_STACK}">${qrSubtitle}</text>
  </svg>
  `);
}

function buildBackgroundSvg(width: number, height: number, template: PosterTemplate): string {
  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" lang="ko">
    <defs>
      <linearGradient id="bgGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0F172A" />
        <stop offset="50%" stop-color="#1E293B" />
        <stop offset="100%" stop-color="#020617" />
      </linearGradient>
      <linearGradient id="diagonalAccent" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="${addAlpha(template.colorScheme.accent, 0.0)}" />
        <stop offset="100%" stop-color="${addAlpha(template.colorScheme.accent, 0.65)}" />
      </linearGradient>
      <filter id="glassmorphism" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="32" result="blur" />
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="matrix" />
      </filter>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#bgGradient)" />
    <path d="M0 ${height * 0.88} L${width * 0.48} ${height} L0 ${height} Z" fill="${addAlpha(
    template.colorScheme.accent,
    0.25,
  )}" />
    <path d="M${width * 0.52} 0 L${width} 0 L${width} ${height * 0.22} Z" fill="url(#diagonalAccent)" />
    
    <circle cx="${width - 150}" cy="150" r="140" fill="${addAlpha(template.colorScheme.accent, 0.18)}" filter="url(#glassmorphism)" />
    <circle cx="100" cy="${height - 150}" r="220" fill="${addAlpha(template.colorScheme.primary, 0.45)}" filter="url(#glassmorphism)" />

    <rect x="30" y="30" width="${width - 60}" height="${height - 60}" rx="26" ry="26"
      fill="none" stroke="${addAlpha(template.colorScheme.text, 0.15)}" stroke-width="2"/>

    <circle cx="${width - 110}" cy="112" r="42" fill="${addAlpha(template.colorScheme.accent, 0.15)}" />
    <circle cx="${width - 110}" cy="112" r="22" fill="${addAlpha(template.colorScheme.accent, 0.25)}" />

    <circle cx="98" cy="${height - 92}" r="34" fill="${addAlpha(template.colorScheme.text, 0.08)}" />
    <circle cx="98" cy="${height - 92}" r="12" fill="${addAlpha(template.colorScheme.text, 0.12)}" />
  </svg>
  `);
}

function buildFallbackHeroSvg(width: number, height: number, template: PosterTemplate): string {
  const iconX = width / 2;
  const iconY = height / 2;

  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" lang="ko">
    <defs>
      <linearGradient id="heroGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${addAlpha(template.colorScheme.secondary, 0.92)}"/>
        <stop offset="100%" stop-color="${addAlpha(template.colorScheme.primary, 0.98)}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#heroGradient)"/>
    <circle cx="${iconX}" cy="${iconY - 16}" r="86" fill="${addAlpha('#FFFFFF', 0.14)}"/>
    <rect x="${iconX - 54}" y="${iconY - 82}" rx="20" ry="20" width="108" height="164" fill="#FFFFFF1E"/>
    <rect x="${iconX - 26}" y="${iconY - 124}" rx="8" ry="8" width="52" height="52" fill="#FFFFFF24"/>
    <text x="${iconX}" y="${height - 56}" text-anchor="middle" font-size="28" font-weight="800"
      fill="#FFFFFF"
      font-family="${FONT_STACK}">REFERENCE IMAGE PREVIEW</text>
  </svg>
  `);
}

function buildRoundedRectSvg(
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke = '#FFFFFF10',
): string {
  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}"
      fill="${fill}" stroke="${stroke}" stroke-width="2" />
  </svg>
  `);
}

function buildGradientOverlaySvg(
  width: number,
  height: number,
  radius: number,
  stops: Array<{ offset: string; color: string }>,
): string {
  const stopsSvg = stops
    .map((stop) => `<stop offset="${stop.offset}" stop-color="${stop.color}" />`)
    .join('');

  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="heroOverlay" x1="0" y1="0" x2="0" y2="1">
        ${stopsSvg}
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="url(#heroOverlay)"/>
  </svg>
  `);
}

function buildRoundedMaskSvg(width: number, height: number, radius: number): string {
  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#FFFFFF"/>
  </svg>
  `);
}

function renderLines(
  lines: string[],
  options: {
    x: number;
    y: number;
    lineHeight: number;
    fontSize: number;
    weight: number;
    fill: string;
  },
): string {
  return lines
    .map((line, index) => {
      const y = options.y + index * options.lineHeight;
      return `<text x="${options.x}" y="${y}" font-size="${options.fontSize}" font-weight="${options.weight}"
        fill="${options.fill}"
        font-family="${FONT_STACK}">${escapeXml(line)}</text>`;
    })
    .join('');
}

function wrapText(input: string, maxCharsPerLine: number, maxLines: number): string[] {
  const source = (input || '').replace(/\s+/g, ' ').trim();
  if (!source) return [''];

  const tokens = source.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const token of tokens) {
    if ((current + ' ' + token).trim().length <= maxCharsPerLine) {
      current = (current + ' ' + token).trim();
      continue;
    }

    if (!current) {
      const sliced = token.slice(0, maxCharsPerLine);
      lines.push(sliced);
      const rest = token.slice(maxCharsPerLine);
      if (rest) {
        current = rest;
      }
    } else {
      lines.push(current);
      current = token;
    }

    if (lines.length >= maxLines) break;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  return lines.slice(0, maxLines).map((line) => line.trim());
}

function normalizeFooterLine(values: Array<string | undefined>): string {
  return values
    .map((value) => (value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
}

function fixedBrandLine(materials: PosterMaterials): string {
  return materials.equipmentName
    ? `${materials.equipmentName} 활용 안내`
    : '한양맞춤의약연구원 연구장비 공동활용';
}

function addAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const value =
    normalized.length === 3
      ? normalized
        .split('')
        .map((char) => char + char)
        .join('')
      : normalized;

  const clamped = Math.max(0, Math.min(1, alpha));
  const alphaHex = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

  return `#${value}${alphaHex}`;
}

function hexToRgbObject(hex: string): { r: number; g: number; b: number; alpha: number } {
  const normalized = hex.replace('#', '');
  const value =
    normalized.length === 3
      ? normalized
        .split('')
        .map((char) => char + char)
        .join('')
      : normalized;

  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);

  return { r, g, b, alpha: 1 };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function withSvgDocument(svgBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${svgBody}`;
}

function svgToBuffer(svg: string): Buffer {
  return Buffer.from(svg, 'utf8');
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'poster-auto-generator/2.1',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}
