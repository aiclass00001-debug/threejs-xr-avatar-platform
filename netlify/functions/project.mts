import type { Config, Context } from "@netlify/functions";
import { getProjectStore, isProjectId, jsonError, projectManifestKey } from "./_shared/storage.mts";

export default async (request: Request, context: Context) => {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const { id } = context.params;
  if (!id || !isProjectId(id)) return jsonError("Invalid project id.", "Invalid project id.");
  const project = await getProjectStore(context).get(projectManifestKey(id), { type: "json" });
  if (!project) return jsonError("Project not found.", "Project not found.", 404);
  return Response.json(project, {
    headers: { "cache-control": "public, max-age=60" },
  });
};

export const config: Config = {
  path: "/api/projects/:id",
};
