import { createLaunchCode, getProjectBucket, isProjectId, projectAssetKey, projectManifestKey } from "../../../../projectStorage";
import type { ProjectAssetSlot, PublishedProject, UploadSession } from "../../../../projectTypes";
import { cleanProjectName, projectAssetSlots, validateTotalSize, validateUploadAsset } from "../../../../projectUploadRules";

export const runtime = "edge";

type CompletePayload = {
  name?: string;
  uploads?: Partial<Record<ProjectAssetSlot, UploadSession>>;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isProjectId(id)) throw new Error("Invalid project id.");
    const payload = await request.json() as CompletePayload;
    if (!payload.uploads?.vrm) throw new Error("A VRM upload is required.");

    const entries = projectAssetSlots.filter(slot => payload.uploads?.[slot]).map(slot => {
      const upload = payload.uploads?.[slot] as UploadSession;
      const asset = validateUploadAsset(slot, upload);
      if (upload.name !== asset.name || !upload.uploadId || upload.uploadId.length > 512) throw new Error(`Invalid ${slot} upload session.`);
      const parts = Array.isArray(upload.parts) ? upload.parts : [];
      if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1 || !part.etag || part.etag.length > 256)) {
        throw new Error(`Invalid ${slot} upload parts.`);
      }
      return { slot, upload, asset, parts };
    });
    validateTotalSize(entries.map(entry => entry.asset));

    const bucket = getProjectBucket();
    const assets: PublishedProject["assets"] = {};
    for (const { slot, upload, asset, parts } of entries) {
      await bucket.resumeMultipartUpload(projectAssetKey(id, asset.name), upload.uploadId).complete(parts);
      assets[slot] = {
        ...asset,
        url: `/api/projects/${id}/assets/${encodeURIComponent(asset.name)}`,
      };
    }

    const launchCode = await createLaunchCode(bucket, id);
    const project: PublishedProject = {
      id,
      version: 1,
      name: cleanProjectName(payload.name),
      createdAt: new Date().toISOString(),
      launchCode,
      assets,
    };
    await bucket.put(projectManifestKey(id), JSON.stringify(project), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project completion failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
