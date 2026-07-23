import type { Config, Context } from "@netlify/functions";
import type { ProjectAssetSlot, PublishedProject } from "../../app/projectTypes";
import { projectAssetSlots } from "../../app/projectUploadRules";
import { chunkKey, getProjectStore, isProjectId, jsonError, projectManifestKey, uploadRecordKey, type UploadRecord } from "./_shared/storage.mts";

export default async (request: Request, context: Context) => {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const { id, name, part } = context.params;
  const partNumber = Number(part);
  if (!id || !isProjectId(id) || !name || !Number.isSafeInteger(partNumber) || partNumber < 1) {
    return jsonError("Invalid asset path.", "Invalid asset path.");
  }
  const store = getProjectStore(context);
  const [project, record] = await Promise.all([
    store.get(projectManifestKey(id), { type: "json" }) as Promise<PublishedProject | null>,
    store.get(uploadRecordKey(id), { type: "json" }) as Promise<UploadRecord | null>,
  ]);
  const slot = projectAssetSlots.find(candidate => project?.assets[candidate]?.name === name) as ProjectAssetSlot | undefined;
  const asset = slot ? project?.assets[slot] : undefined;
  const upload = slot ? record?.uploads[slot] : undefined;
  const chunk = asset?.chunks?.find(candidate => candidate.partNumber === partNumber);
  if (!asset || !upload || !chunk) return jsonError("Asset not found.", "Asset not found.", 404);
  const buffer = await store.get(chunkKey(id, name, upload.uploadId, partNumber), { type: "arrayBuffer" }) as ArrayBuffer | null;
  if (!buffer) return jsonError("Asset chunk not found.", "Asset chunk not found.", 404);
  return new Response(buffer, {
    headers: {
      "content-type": asset.contentType,
      "content-length": String(buffer.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": "inline",
    },
  });
};

export const config: Config = {
  path: "/api/projects/:id/assets/:name/:part",
};
