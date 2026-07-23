import { getProjectBucket, isProjectId, projectManifestKey } from "../../../projectStorage";

export const runtime = "edge";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isProjectId(id)) {
    return Response.json({ error: "Invalid project id." }, { status: 400 });
  }

  const object = await getProjectBucket().get(projectManifestKey(id));
  if (!object) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
