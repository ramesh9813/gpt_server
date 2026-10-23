import crypto from "crypto";
import path from "path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./config";

const endpoint = env.AWS_ENDPOINT_URL_S3.trim();
const region = env.AWS_REGION.trim();
const accessKeyId = env.AWS_ACCESS_KEY_ID.trim();
const secretAccessKey = env.AWS_SECRET_ACCESS_KEY.trim();
const bucket = env.NEON_STORAGE_BUCKET.trim();

export const isObjectStorageConfigured = Boolean(
  endpoint && region && accessKeyId && secretAccessKey && bucket
);

const client = isObjectStorageConfigured
  ? new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    })
  : null;

const requireClient = (): S3Client => {
  if (!client) throw new Error("Object storage is not configured");
  return client;
};

export const buildStorageKey = (userId: string, name: string): string => {
  const rawExt = path.extname(name).toLowerCase();
  const ext = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : "";
  return `attachments/${userId}/${crypto.randomUUID()}${ext}`;
};

export const uploadObject = async (args: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> => {
  await requireClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
      ContentLength: args.body.length
    })
  );
};

export const deleteObject = async (key: string): Promise<void> => {
  await requireClient().send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );
};

const contentDisposition = (filename: string, download: boolean): string => {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `${download ? "attachment" : "inline"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

export const getObjectUrl = async (
  key: string,
  opts: { filename: string; mime: string; download?: boolean }
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: opts.mime,
    ResponseContentDisposition: contentDisposition(opts.filename, opts.download === true)
  });
  return getSignedUrl(requireClient(), command, { expiresIn: 60 * 60 });
};

export const parseDataUrl = (
  dataUrl: string
): { mime: string; buffer: Buffer } | null => {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  try {
    return { mime, buffer: Buffer.from(base64, "base64") };
  } catch {
    return null;
  }
};
