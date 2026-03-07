import { v2 as cloudinary } from 'cloudinary';

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

cloudinary.config({
  cloud_name: getEnv('CLOUDINARY_CLOUD_NAME'),
  api_key: getEnv('CLOUDINARY_API_KEY'),
  api_secret: getEnv('CLOUDINARY_API_SECRET'),
  secure: true,
});

export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
  assetId: string;
}

export async function uploadPosterToCloudinary(
  imageBuffer: Buffer,
  fileName: string,
): Promise<CloudinaryUploadResult> {
  const assetFolder = process.env.CLOUDINARY_ASSET_FOLDER || 'auto-poster';

  const publicId = fileName.replace(/\.[^.]+$/, '');

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        asset_folder: assetFolder,
        public_id: publicId,
        overwrite: true,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        if (!result?.secure_url || !result.public_id || !result.asset_id) {
          reject(new Error('Cloudinary upload succeeded but response is incomplete.'));
          return;
        }

        resolve({
          secureUrl: result.secure_url,
          publicId: result.public_id,
          assetId: result.asset_id,
        });
      },
    );

    stream.end(imageBuffer);
  });
}
