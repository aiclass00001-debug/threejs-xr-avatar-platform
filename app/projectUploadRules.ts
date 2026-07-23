import type { ProjectAssetSlot, UploadAssetInput } from "./projectTypes";

const MIB = 1024 * 1024;

export const projectAssetSlots: ProjectAssetSlot[] = ["vrm", "animation", "audio", "target", "targetData"];

const limits: Record<ProjectAssetSlot, number> = {
  vrm: 50 * MIB,
  animation: 25 * MIB,
  audio: 25 * MIB,
  target: 10 * MIB,
  targetData: 25 * MIB,
};

const allowed: Record<ProjectAssetSlot, RegExp> = {
  vrm: /\.vrm$/i,
  animation: /\.(fbx|vrma)$/i,
  audio: /\.(mp3|wav|ogg|m4a)$/i,
  target: /\.(jpg|jpeg|png|webp)$/i,
  targetData: /\.mind$/i,
};

const fallbackTypes: Record<ProjectAssetSlot, string> = {
  vrm: "model/gltf-binary",
  animation: "application/octet-stream",
  audio: "audio/mpeg",
  target: "image/jpeg",
  targetData: "application/octet-stream",
};

export function cleanProjectName(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) || "XR AVATAR PROJECT" : "XR AVATAR PROJECT";
}

export function validateUploadAsset(slot: ProjectAssetSlot, value: unknown): UploadAssetInput & { name: string } {
  if (!value || typeof value !== "object") throw new Error(`Missing ${slot} metadata.`);
  const input = value as Partial<UploadAssetInput>;
  const originalName = typeof input.originalName === "string" ? input.originalName.slice(0, 180) : "";
  const size = typeof input.size === "number" ? input.size : 0;
  if (!allowed[slot].test(originalName)) throw new Error(`${originalName || slot} is not a supported ${slot} file.`);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${originalName} has an invalid size.`);
  if (size > limits[slot]) throw new Error(`${originalName} exceeds the ${limits[slot] / MIB} MB limit.`);
  const extension = originalName.toLowerCase().match(/\.[a-z0-9]{1,6}$/)?.[0] ?? "";
  return {
    originalName,
    size,
    contentType: typeof input.contentType === "string" && input.contentType ? input.contentType.slice(0, 120) : fallbackTypes[slot],
    name: `${slot}${extension}`,
  };
}

export function validateTotalSize(assets: Array<{ size: number }>) {
  if (assets.reduce((sum, asset) => sum + asset.size, 0) > 90 * MIB) {
    throw new Error("The project exceeds the 90 MB total limit.");
  }
}
