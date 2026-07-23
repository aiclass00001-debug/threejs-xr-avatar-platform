import { getDeployStore, getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";
import type { ProjectAssetSlot, UploadAssetInput } from "../../../app/projectTypes";

export const CHUNK_SIZE = 5 * 1024 * 1024;
export const STORE_NAME = "xr-avatar-projects";

export type UploadDescriptor = UploadAssetInput & {
  name: string;
  uploadId: string;
};

export type UploadRecord = {
  id: string;
  name: string;
  createdAt: string;
  uploads: Partial<Record<ProjectAssetSlot, UploadDescriptor>>;
};

export function getProjectStore(context: Context) {
  return context.deploy?.context === "production"
    ? getStore(STORE_NAME, { consistency: "strong" })
    : getDeployStore(STORE_NAME);
}

export function isProjectId(value: string) {
  return /^[a-f0-9]{32}$/.test(value);
}

export function normalizeLaunchCode(value: string) {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.startsWith("XR") ? `XR-${compact.slice(2)}` : `XR-${compact}`;
}

export function isLaunchCode(value: string) {
  return /^XR-[A-Z0-9]{6}$/.test(value);
}

export function uploadRecordKey(id: string) {
  return `uploads/${id}.json`;
}

export function projectManifestKey(id: string) {
  return `projects/${id}/project.json`;
}

export function launchCodeKey(code: string) {
  return `launch-codes/${code}.json`;
}

export function chunkKey(id: string, name: string, uploadId: string, partNumber: number) {
  return `projects/${id}/chunks/${name}/${uploadId}/${String(partNumber).padStart(5, "0")}`;
}

export async function createLaunchCode(store: ReturnType<typeof getStore>, projectId: string) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const suffix = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
    const code = `XR-${suffix}`;
    if (await store.get(launchCodeKey(code))) continue;
    await store.setJSON(launchCodeKey(code), { projectId, code });
    return code;
  }
  throw new Error("Could not allocate a unique Quest launch code.");
}

export function jsonError(error: unknown, fallback: string, status = 400) {
  const message = error instanceof Error ? error.message : fallback;
  return Response.json({ error: message }, { status });
}
