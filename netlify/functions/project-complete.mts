import type { Config, Context } from "@netlify/functions";
import type { ProjectAssetSlot, PublishedProject, UploadSession } from "../../app/projectTypes";
import { cleanProjectName, projectAssetSlots, validateTotalSize, validateUploadAsset } from "../../app/projectUploadRules";
import { CHUNK_SIZE, chunkKey, createLaunchCode, getProjectStore, isProjectId, jsonError, projectManifestKey, uploadRecordKey, type UploadRecord } from "./_shared/storage.mts";

type CompletePayload = {
  name?: string;
  uploads?: Partial<Record<ProjectAssetSlot, UploadSession>>;
};

export default async (request: Request, context: Context) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const { id } = context.params;
    if (!id || !isProjectId(id)) throw new Error("Invalid project id.");
    const payload = await request.json() as CompletePayload;
    if (!payload.uploads?.vrm) throw new Error("A VRM upload is required.");
    const store = getProjectStore(context);
    const record = await store.get(uploadRecordKey(id), { type: "json" }) as UploadRecord | null;
    if (!record) throw new Error("Upload session expired.");

    const entries = projectAssetSlots.filter(slot => payload.uploads?.[slot]).map(slot => {
      const upload = payload.uploads?.[slot] as UploadSession;
      const expected = record.uploads[slot];
      const asset = validateUploadAsset(slot, upload);
      if (!expected || expected.name !== asset.name || expected.uploadId !== upload.uploadId) {
        throw new Error(`Invalid ${slot} upload session.`);
      }
      const expectedCount = Math.ceil(asset.size / CHUNK_SIZE);
      const parts = Array.isArray(upload.parts) ? upload.parts : [];
      if (parts.length !== expectedCount || parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
        throw new Error(`Invalid ${slot} upload parts.`);
      }
      return { slot, upload, asset, parts };
    });
    validateTotalSize(entries.map(entry => entry.asset));

    const assets: PublishedProject["assets"] = {};
    for (const { slot, upload, asset, parts } of entries) {
      for (const part of parts) {
        const exists = await store.getMetadata(chunkKey(id, asset.name, upload.uploadId, part.partNumber));
        if (!exists) throw new Error(`${asset.originalName} part ${part.partNumber} is missing.`);
      }
      assets[slot] = {
        ...asset,
        url: "",
        chunks: parts.map(part => ({
          partNumber: part.partNumber,
          size: Math.min(CHUNK_SIZE, asset.size - CHUNK_SIZE * (part.partNumber - 1)),
          url: `/api/projects/${id}/assets/${encodeURIComponent(asset.name)}/${part.partNumber}`,
        })),
      };
    }

    const launchCode = await createLaunchCode(store as ReturnType<typeof getProjectStore>, id);
    const project: PublishedProject = {
      id,
      version: 1,
      name: cleanProjectName(payload.name),
      createdAt: new Date().toISOString(),
      launchCode,
      assets,
    };
    await store.setJSON(projectManifestKey(id), project);
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return jsonError(error, "Project completion failed.");
  }
};

export const config: Config = {
  path: "/api/projects/:id/complete",
};
