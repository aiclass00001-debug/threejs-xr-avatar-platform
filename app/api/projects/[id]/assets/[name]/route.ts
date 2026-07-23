import { getProjectBucket, isProjectId, projectAssetKey } from "../../../../../projectStorage";

export const runtime = "edge";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await context.params;
  if (!isProjectId(id) || !/^(vrm|animation|audio|target|targetData)\.[a-z0-9]{1,6}$/i.test(name)) {
    return Response.json({ error: "Invalid asset path." }, { status: 400 });
  }

  const object = await getProjectBucket().get(projectAssetKey(id, name));
  if (!object) {
    return Response.json({ error: "Asset not found." }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-disposition", "inline");
  headers.set("access-control-allow-origin", "*");
  return new Response(object.body, { headers });
}
