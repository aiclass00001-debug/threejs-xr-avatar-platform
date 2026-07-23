import { getProjectBucket, projectAssetKey } from "../../projectStorage";
import type { ProjectAssetSlot, UploadAssetInput } from "../../projectTypes";
import { cleanProjectName, projectAssetSlots, validateTotalSize, validateUploadAsset } from "../../projectUploadRules";

export const runtime = "edge";

type InitPayload = {
  name?: string;
  assets?: Partial<Record<ProjectAssetSlot, UploadAssetInput>>;
};

export async function POST(request: Request) {
  const created: Array<{ abort(): Promise<void> }> = [];
  try {
    const payload = await request.json() as InitPayload;
    if (!payload.assets?.vrm) {
      return Response.json({ error: "A VRM file is required." }, { status: 400 });
    }

    const entries = projectAssetSlots
      .filter(slot => payload.assets?.[slot])
      .map(slot => ({ slot, asset: validateUploadAsset(slot, payload.assets?.[slot]) }));
    validateTotalSize(entries.map(entry => entry.asset));

    const id = crypto.randomUUID().replaceAll("-", "");
    const bucket = getProjectBucket();
    const uploads: Partial<Record<ProjectAssetSlot, UploadAssetInput & { name: string; uploadId: string }>> = {};

    for (const { slot, asset } of entries) {
      const upload = await bucket.createMultipartUpload(projectAssetKey(id, asset.name), {
        httpMetadata: { contentType: asset.contentType },
        customMetadata: { originalName: asset.originalName },
      });
      created.push(upload);
      uploads[slot] = { ...asset, uploadId: upload.uploadId };
    }

    return Response.json({ projectId: id, name: cleanProjectName(payload.name), uploads }, { status: 201 });
  } catch (error) {
    await Promise.allSettled(created.map(upload => upload.abort()));
    const message = error instanceof Error ? error.message : "Could not start project upload.";
    return Response.json({ error: message }, { status: 400 });
  }
}
