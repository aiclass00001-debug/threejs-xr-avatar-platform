import type { Config, Context } from "@netlify/functions";
import { getProjectStore, isLaunchCode, isProjectId, jsonError, launchCodeKey, normalizeLaunchCode } from "./_shared/storage.mts";

type LaunchAlias = { projectId?: string; code?: string };

export default async (request: Request, context: Context) => {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const code = normalizeLaunchCode(context.params.code ?? "");
  if (!isLaunchCode(code)) return jsonError("Launch Code 格式錯誤，請輸入 XR- 加六位英數字。", "Launch Code 格式錯誤。");
  const alias = await getProjectStore(context).get(launchCodeKey(code), { type: "json" }) as LaunchAlias | null;
  if (!alias?.projectId) return jsonError("找不到這組 Launch Code。", "找不到這組 Launch Code。", 404);
  if (!isProjectId(alias.projectId)) return jsonError("Launch Code 對應資料已損壞。", "Launch Code 對應資料已損壞。", 500);
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = new URLSearchParams({ project: alias.projectId, mode: "quest" }).toString();
  return Response.json({ code, projectId: alias.projectId, url: `${url.pathname}${url.search}` }, {
    headers: { "cache-control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/launch/:code",
};
