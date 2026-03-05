/**
 * Crypto Utils
 *
 * AES-256-GCM 기반 암호화/복호화.
 * API Key 등 민감 정보를 내부 시트에 저장할 때 사용.
 * 복호화 키(ENCRYPTION_KEY)는 GitHub Secrets에만 존재.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * 환경변수에서 암호화 키를 가져옴
 */
export function getEncryptionKey(): Buffer {
    const keyHex = process.env.ENCRYPTION_KEY;
    if (!keyHex) {
        throw new Error('ENCRYPTION_KEY environment variable is not set');
    }
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) {
        throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return key;
}

/**
 * 평문을 AES-256-GCM으로 암호화하여 base64 문자열 반환
 * 형식: base64(IV + ciphertext + authTag)
 */
export function encrypt(plaintext: string, key: Buffer): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // IV(12) + encrypted + authTag(16)
    const combined = Buffer.concat([iv, encrypted, authTag]);
    return combined.toString('base64');
}

/**
 * base64 blob을 복호화하여 평문 반환
 */
export function decrypt(blob: string, key: Buffer): string {
    const combined = Buffer.from(blob, 'base64');

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(combined.length - TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

/**
 * 랜덤 암호화 키 생성 (초기 설정 시 사용)
 */
export function generateEncryptionKey(): string {
    return randomBytes(32).toString('hex');
}
