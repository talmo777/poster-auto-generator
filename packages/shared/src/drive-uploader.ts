/**
 * Google Drive Uploader
 *
 * 포스터 이미지를 Google Drive에 업로드하고 공유 링크를 생성.
 */

import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';

export function createDriveClient(serviceAccountJson: string): drive_v3.Drive {
    const credentials = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return google.drive({ version: 'v3', auth });
}

export interface UploadResult {
    fileId: string;
    webViewLink: string;
    webContentLink: string;
    thumbnailLink: string;
}

/**
 * 이미지를 Google Drive 폴더에 업로드
 */
export async function uploadImage(
    drive: drive_v3.Drive,
    folderId: string,
    fileName: string,
    imageBuffer: Buffer,
    mimeType = 'image/png',
): Promise<UploadResult> {
    // 파일 업로드
    const fileMetadata = {
        name: fileName,
        parents: [folderId],
    };

    const media = {
        mimeType,
        body: bufferToStream(imageBuffer),
    };

    const res = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, webViewLink, webContentLink, thumbnailLink',
    });

    const fileId = res.data.id!;

    // 공개 읽기 권한 설정
    await setPublicReadable(drive, fileId);

    return {
        fileId,
        webViewLink: res.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`,
        webContentLink: res.data.webContentLink ?? `https://drive.google.com/uc?id=${fileId}`,
        thumbnailLink: res.data.thumbnailLink ?? '',
    };
}

/**
 * 파일을 공개 읽기 가능하게 설정
 */
export async function setPublicReadable(
    drive: drive_v3.Drive,
    fileId: string,
): Promise<void> {
    await drive.permissions.create({
        fileId,
        requestBody: {
            role: 'reader',
            type: 'anyone',
        },
    });
}

// ============================================================
// Utility
// ============================================================

function bufferToStream(buffer: Buffer): Readable {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}
