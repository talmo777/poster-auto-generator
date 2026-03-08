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

export function generateSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

export async function ensureLocalFont() {
  const fontDir = path.join(os.tmpdir(), 'poster-fonts');
  const fontConfigPath = path.join(fontDir, 'fonts.conf');

  if (!fs.existsSync(fontDir)) {
    fs.mkdirSync(fontDir, { recursive: true });
  }

  const fontFiles = ['NotoSansKR-Regular.otf', 'NotoSansKR-Bold.otf'];
  for (const fontFile of fontFiles) {
    const filePath = path.join(fontDir, fontFile);
    if (!fs.existsSync(filePath)) {
      console.log(`[PosterGenerator] Downloading ${fontFile} to ${filePath}...`);
      const fontUrls = [
        `https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/${fontFile}`,
        `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/KR/${fontFile}`,
      ];
      let downloaded = false;
      for (const fontUrl of fontUrls) {
        try {
          const response = await fetchWithTimeout(fontUrl, 30000);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(filePath, Buffer.from(buffer));
            console.log(`[PosterGenerator] Font downloaded from ${fontUrl}`);
            downloaded = true;
            break;
          }
          console.warn(`[PosterGenerator] Font URL returned ${response.status}: ${fontUrl}`);
        } catch (e) {
          console.warn(`[PosterGenerator] Font download failed from ${fontUrl}:`, e);
        }
      }
      if (!downloaded) {
        console.error(
          `[PosterGenerator] All font download URLs failed for ${fontFile}. Korean text may not render correctly. ` +
          'Check network connectivity or install fonts-noto-cjk system package as a fallback.',
        );
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

  try {
    const { execFileSync } = await import('child_process');
    execFileSync('fc-cache', ['-f', fontDir], { stdio: 'ignore', timeout: 10000 });
  } catch {
    // fc-cache may not be available on all systems
  }
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
    left: 60,
    top: 200,
    width: width - 120,
    height: Math.round(height * 0.31),
  };
}

function getPanelArea(width: number, height: number) {
  return {
    left: 56,
    top: Math.round(height * 0.545),
    width: width - 112,
    height: Math.round(height * 0.175),
  };
}

function getQrArea(width: number, height: number) {
  return {
    left: width - 216,
    top: height - 210,
    size: 120,
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
  const supplementaryLines = wrapText(copy.supplementary, layout.hasQr ? 34 : 44, 2);

  const bulletItems = copy.bullets.slice(0, 3);

  const equipParts = [materials.equipmentName, materials.manufacturer].filter(Boolean);
  const equipmentLabel = escapeXml(equipParts.join(' | ') || '연구장비');

  const locationText = escapeXml(
    (materials.location || '').replace(/\s+/g, ' ').trim() || '센터 운영 기준에 따라 이용 가능',
  );
  const contactText = escapeXml(
    (materials.contact || '').replace(/\s+/g, ' ').trim() || '센터 홈페이지에서 확인하세요',
  );
  const priceText = materials.priceInfo
    ? escapeXml((materials.priceInfo || '').replace(/\s+/g, ' ').trim())
    : '';

  const headlineSvg = renderLines(headlineLines, {
    x: 72,
    y: 82,
    lineHeight: 72,
    fontSize: 58,
    weight: 700,
    fill: template.colorScheme.text,
  });

  const subheadlineY = 82 + headlineLines.length * 72 + 14;
  const subheadlineSvg = renderLines(subheadlineLines, {
    x: 72,
    y: subheadlineY,
    lineHeight: 42,
    fontSize: 30,
    weight: 500,
    fill: addAlpha(template.colorScheme.text, 0.85),
  });

  const equipBarY = layout.heroArea.top + layout.heroArea.height + 14;
  const equipBarWidth = Math.min(
    layout.heroArea.width,
    Math.max(360, equipmentLabel.length * 14 + 80),
  );
  const equipBarX = (width - equipBarWidth) / 2;

  const bulletSvg = bulletItems
    .map((item, index) => {
      const bulletY = layout.panelArea.top + 52 + index * 56;
      return `
        <circle cx="98" cy="${bulletY - 6}" r="9" fill="${template.colorScheme.accent}" />
        <text x="124" y="${bulletY}" font-size="28" font-weight="700" fill="#FFFFFF"
          font-family="${FONT_STACK}">${escapeXml(item)}</text>
      `;
    })
    .join('');

  const footerY = layout.panelArea.top + layout.panelArea.height + 40;

  const suppY = footerY + (priceText ? 116 : 80);
  const supplementarySvg = renderLines(supplementaryLines, {
    x: 72,
    y: suppY,
    lineHeight: 24,
    fontSize: 16,
    weight: 500,
    fill: addAlpha(template.colorScheme.text, 0.62),
  });

  return withSvgDocument(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" lang="ko">
    <defs>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000000" flood-opacity="0.22"/>
      </filter>
    </defs>

    ${headlineSvg}
    ${subheadlineSvg}

    <rect x="${equipBarX}" y="${equipBarY}" rx="8" ry="8"
      width="${equipBarWidth}" height="44" fill="#FFFFFFEE" filter="url(#softShadow)" />
    <text x="${width / 2}" y="${equipBarY + 30}" text-anchor="middle"
      font-size="21" font-weight="700" fill="${template.colorScheme.primary}"
      font-family="${FONT_STACK}">${equipmentLabel}</text>

    <circle cx="${width / 2}" cy="${equipBarY + 68}" r="8" fill="${template.colorScheme.accent}" />

    ${bulletSvg}

    <text x="72" y="${footerY}" font-size="20" font-weight="700"
      fill="${addAlpha(template.colorScheme.text, 0.9)}"
      font-family="${FONT_STACK}">설치장소 : ${locationText}</text>

    <text x="72" y="${footerY + 36}" font-size="20" font-weight="700"
      fill="${addAlpha(template.colorScheme.text, 0.9)}"
      font-family="${FONT_STACK}">담당자 : ${contactText}</text>

    ${priceText ? `<text x="72" y="${footerY + 72}" font-size="19" font-weight="600"
      fill="${addAlpha(template.colorScheme.text, 0.78)}"
      font-family="${FONT_STACK}">${priceText}</text>` : ''}

    ${supplementarySvg}

    ${layout.hasQr ? `
    <rect x="${layout.qrArea.left - 16}" y="${layout.qrArea.top - 16}" rx="20" ry="20"
      width="${layout.qrArea.size + 32}" height="${layout.qrArea.size + 32}" fill="#FFFFFF" />
    <text x="${layout.qrArea.left + layout.qrArea.size / 2}" y="${layout.qrArea.top + layout.qrArea.size + 36}"
      text-anchor="middle" font-size="17" font-weight="700"
      fill="${template.colorScheme.text}"
      font-family="${FONT_STACK}">홈페이지 바로가기</text>
    ` : ''}
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
  return Buffer.from(`\uFEFF${svg}`, 'utf8');
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
