import "server-only";

export type ProjectBucketObject = {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
};

export type ProjectBucket = {
  get(key: string): Promise<ProjectBucketObject | null>;
  put(
    key: string,
    value: string | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  createMultipartUpload(
    key: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<{ key: string; uploadId: string; abort(): Promise<void> }>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    uploadPart(partNumber: number, value: ReadableStream): Promise<{ partNumber: number; etag: string }>;
    complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
    abort(): Promise<void>;
  };
};

type RuntimeGlobal = typeof globalThis & {
  __XR_SITE_ENV__?: { BUCKET?: ProjectBucket };
};

export function getProjectBucket() {
  const bucket = (globalThis as RuntimeGlobal).__XR_SITE_ENV__?.BUCKET;
  if (!bucket) {
    throw new Error(
      "Cloudflare R2 binding `BUCKET` is unavailable. Set the `r2` field in .openai/hosting.json to `BUCKET`.",
    );
  }
  return bucket;
}

export function isProjectId(value: string) {
  return /^[a-f0-9]{32}$/.test(value);
}

export function projectManifestKey(id: string) {
  return `projects/${id}/project.json`;
}

export function projectAssetKey(id: string, name: string) {
  return `projects/${id}/assets/${name}`;
}

export function normalizeLaunchCode(value: string) {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.startsWith("XR") ? `XR-${compact.slice(2)}` : `XR-${compact}`;
}

export function isLaunchCode(value: string) {
  return /^XR-[A-Z0-9]{6}$/.test(value);
}

export function launchCodeKey(code: string) {
  return `launch-codes/${code}.json`;
}

export async function createLaunchCode(bucket: ProjectBucket, projectId: string) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const suffix = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
    const code = `XR-${suffix}`;
    if (await bucket.get(launchCodeKey(code))) continue;
    await bucket.put(launchCodeKey(code), JSON.stringify({ projectId, code }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return code;
  }
  throw new Error("Could not allocate a unique Quest launch code.");
}
