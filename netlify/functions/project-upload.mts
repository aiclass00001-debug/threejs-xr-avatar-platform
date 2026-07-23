import type { Config, Context } from "@netlify/functions";
import type { ProjectAssetSlot } from "../../app/projectTypes";
import { projectAssetSlots } from "../../app/projectUploadRules";
import { CHUNK_SIZE, chunkKey, getProjectStore, isProjectId, jsonError, uploadRecordKey, type UploadRecord } from "./_shared/storage.mts";

export default async (request: Request, context: Context) => {
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  try {
    const { id } = context.params;
    const url = new URL(request.url);
    const slot = url.searchParams.get("slot") as ProjectAssetSlot | null;
    const name = url.searchParams.get("name") ?? "";
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = Number(url.searchParams.get("part"));
    if (!id || !isProjectId(id) || !slot || !projectAssetSlots.includes(slot)) throw new Error("Invalid upload target.");
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("Invalid part number.");

    const store = getProjectStore(context);
    const record = await store.get(uploadRecordKey(id), { type: "json" }) as UploadRecord | null;
    const expected = record?.uploads[slot];
    if (!expected || expected.name !== name || expected.uploadId !== uploadId) throw new Error("Invalid upload session.");
    const expectedPartCount = Math.ceil(expected.size / CHUNK_SIZE);
    if (partNumber > expectedPartCount) throw new Error("Upload part exceeds the declared asset size.");

    const buffer = await request.arrayBuffer();
    const expectedPartSize = partNumber < expectedPartCount
      ? CHUNK_SIZE
      : expected.size - CHUNK_SIZE * (expectedPartCount - 1);
    if (buffer.byteLength !== expectedPartSize) throw new Error("Upload part size does not match the declared asset.");
    await store.set(chunkKey(id, name, uploadId, partNumber), buffer);
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const etag = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    return Response.json({ part: { partNumber, etag } });
  } catch (error) {
    return jsonError(error, "Upload part failed.");
  }
};

export const config: Config = {
  path: "/api/projects/:id/upload",
};
