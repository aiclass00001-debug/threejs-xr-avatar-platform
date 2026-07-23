import type { Config, Context } from "@netlify/functions";
import type { ProjectAssetSlot, UploadAssetInput } from "../../app/projectTypes";
import { cleanProjectName, projectAssetSlots, validateTotalSize, validateUploadAsset } from "../../app/projectUploadRules";
import { getProjectStore, jsonError, uploadRecordKey, type UploadRecord } from "./_shared/storage.mts";

type InitPayload = {
  name?: string;
  assets?: Partial<Record<ProjectAssetSlot, UploadAssetInput>>;
};

export default async (request: Request, context: Context) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const payload = await request.json() as InitPayload;
    if (!payload.assets?.vrm) throw new Error("A VRM file is required.");
    const entries = projectAssetSlots
      .filter(slot => payload.assets?.[slot])
      .map(slot => ({ slot, asset: validateUploadAsset(slot, payload.assets?.[slot]) }));
    validateTotalSize(entries.map(entry => entry.asset));

    const id = crypto.randomUUID().replaceAll("-", "");
    const uploads: UploadRecord["uploads"] = {};
    for (const { slot, asset } of entries) {
      uploads[slot] = {
        ...asset,
        uploadId: crypto.randomUUID().replaceAll("-", ""),
      };
    }
    const record: UploadRecord = {
      id,
      name: cleanProjectName(payload.name),
      createdAt: new Date().toISOString(),
      uploads,
    };
    await getProjectStore(context).setJSON(uploadRecordKey(id), record);
    return Response.json({ projectId: id, name: record.name, uploads }, { status: 201 });
  } catch (error) {
    return jsonError(error, "Could not start project upload.");
  }
};

export const config: Config = {
  path: "/api/projects",
};
