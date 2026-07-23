import { getProjectBucket, isProjectId, projectAssetKey } from "../../../../projectStorage";
import type { ProjectAssetSlot } from "../../../../projectTypes";
import { projectAssetSlots } from "../../../../projectUploadRules";

export const runtime = "edge";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const slot = url.searchParams.get("slot") as ProjectAssetSlot | null;
    const name = url.searchParams.get("name") ?? "";
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = Number(url.searchParams.get("part"));

    if (!isProjectId(id) || !slot || !projectAssetSlots.includes(slot)) throw new Error("Invalid upload target.");
    if (!new RegExp(`^${slot}\\.[a-z0-9]{1,6}$`, "i").test(name)) throw new Error("Invalid asset name.");
    if (!uploadId || uploadId.length > 512) throw new Error("Invalid upload id.");
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("Invalid part number.");
    if (!request.body) throw new Error("Upload part is empty.");

    const part = await getProjectBucket()
      .resumeMultipartUpload(projectAssetKey(id, name), uploadId)
      .uploadPart(partNumber, request.body);
    return Response.json({ part });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload part failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
