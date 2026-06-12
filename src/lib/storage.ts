// Thin R2 (S3-compatible) wrapper. Bucket: finance-engine-v2.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gunzipSync, gzipSync } from "node:zlib";

const BUCKET = process.env.R2_BUCKET ?? "finance-engine-v2";

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("R2 env vars missing (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
    client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  }
  return client;
}

export async function putJsonGz(key: string, data: unknown): Promise<void> {
  const body = gzipSync(Buffer.from(JSON.stringify(data)));
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "application/json", ContentEncoding: "gzip" }));
}

export async function getJsonGz<T>(key: string): Promise<T | null> {
  try {
    const resp = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = Buffer.from(await resp.Body!.transformToByteArray());
    const text = gunzipSync(bytes).toString("utf-8");
    return JSON.parse(text) as T;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

export function candleKey(symbol: string, tf: string): string {
  return `candles/${symbol.replace("/", "-")}_${tf}.json.gz`;
}

export function artifactKey(candidateHash: string, kind: string): string {
  return `artifacts/${candidateHash}/${kind}.json.gz`;
}
