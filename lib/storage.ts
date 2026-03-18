/**
 * Storage abstraction — S3-compatible when STORAGE_URL is set,
 * falls back to local filesystem.
 *
 * STORAGE_URL format: s3://bucket-name (uses AWS_* or S3_ENDPOINT env vars)
 * S3_ENDPOINT: Custom endpoint for MinIO/self-hosted (e.g. http://localhost:9000)
 * S3_ACCESS_KEY, S3_SECRET_KEY: Credentials
 * S3_REGION: Region (default: us-east-1)
 */
import fs from 'fs';
import path from 'path';

let s3Client = null;
let bucket = null;

async function initStorage() {
  const storageUrl = process.env.STORAGE_URL;
  if (!storageUrl || !storageUrl.startsWith('s3://')) return false;

  try {
    const { S3Client } = await import('@aws-sdk/client-s3');
    bucket = storageUrl.replace('s3://', '');

    const config: Record<string, unknown> = {
      region: process.env.S3_REGION || 'us-east-1',
    };

    if (process.env.S3_ENDPOINT) {
      config.endpoint = process.env.S3_ENDPOINT;
      config.forcePathStyle = true; // Required for MinIO
    }

    if (process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) {
      config.credentials = {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      };
    }

    s3Client = new S3Client(config);
    console.log(`[storage] S3 initialized: bucket=${bucket}`);
    return true;
  } catch (err) {
    console.warn('[storage] S3 unavailable, using local filesystem:', err.message);
    s3Client = null;
    return false;
  }
}

function isS3() { return s3Client !== null; }

// Write a buffer to storage
async function putBuffer(key: string, buffer: Buffer, metadata: { contentType?: string } = {}) {
  if (!s3Client) {
    const filePath = _localPath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: metadata.contentType || 'application/octet-stream',
  }));
  return `s3://${bucket}/${key}`;
}

// Get a readable stream from storage
async function getStream(key) {
  if (!s3Client) {
    const filePath = _localPath(key);
    if (!fs.existsSync(filePath)) return null;
    return fs.createReadStream(filePath);
  }

  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return resp.Body; // Readable stream
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Check if key exists + get size
async function stat(key) {
  if (!s3Client) {
    const filePath = _localPath(key);
    try {
      const st = fs.statSync(filePath);
      return { size: st.size, exists: true };
    } catch {
      return { size: 0, exists: false };
    }
  }

  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const resp = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: resp.ContentLength, exists: true };
  } catch {
    return { size: 0, exists: false };
  }
}

// Delete a key
async function del(key) {
  if (!s3Client) {
    const filePath = _localPath(key);
    try { fs.unlinkSync(filePath); } catch {}
    return;
  }

  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  try { await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); } catch {}
}

// Local path helper
const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'downloads');
function _localPath(key) {
  return path.join(DATA_DIR, key);
}

export { initStorage, isS3, putBuffer, getStream, stat, del };
