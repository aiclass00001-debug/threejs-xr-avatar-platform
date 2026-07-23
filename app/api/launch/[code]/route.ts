import { getProjectBucket, isLaunchCode, isProjectId, launchCodeKey, normalizeLaunchCode } from "../../../projectStorage";

export const runtime = "edge";

type LaunchAlias = { projectId?: string; code?: string };

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await context.params;
  const code = normalizeLaunchCode(rawCode);
  if (!isLaunchCode(code)) {
    return Response.json({ error: "Launch Code 格式錯誤，請輸入 XR- 加六位英數字。" }, { status: 400 });
  }

  const object = await getProjectBucket().get(launchCodeKey(code));
  if (!object) return Response.json({ error: "找不到這組 Launch Code。" }, { status: 404 });

  const alias = await new Response(object.body).json() as LaunchAlias;
  if (!alias.projectId || !isProjectId(alias.projectId)) {
    return Response.json({ error: "Launch Code 對應資料已損壞。" }, { status: 500 });
  }

  const url = new URL(request.url);
  url.pathname = "/";
  url.search = new URLSearchParams({ project: alias.projectId, mode: "quest" }).toString();
  return Response.json({ code, projectId: alias.projectId, url: `${url.pathname}${url.search}` }, {
    headers: { "cache-control": "no-store" },
  });
}
