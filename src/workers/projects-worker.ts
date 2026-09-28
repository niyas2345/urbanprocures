import { Router } from "itty-router";
import { createProject, deleteProject, getProject, getProjectsByUser, updateProject } from "../lib/kv";
import type { Env, Project } from "../lib/types";
import { authMiddleware, errorHandler, HttpError, isResponse, jsonResponse, readJson, requestLogger } from "./middleware";

const router = Router();

const requireAuth = async (request: Request, env: Env) => {
  const auth = await authMiddleware(request, env);
  if (isResponse(auth)) throw new HttpError(401, "Unauthorized");
  return auth;
};

router.get("/api/projects", async (request: Request, env: Env) => {
  const auth = await requireAuth(request, env);
  return jsonResponse(await getProjectsByUser(env, auth.user_id));
});

router.post("/api/projects", async (request: Request, env: Env) => {
  const auth = await requireAuth(request, env);
  const body = await readJson<{ name: string; description?: string }>(request);
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "Missing project name");
  const now = new Date().toISOString();
  const project: Project = {
    id: crypto.randomUUID(),
    user_id: auth.user_id,
    name,
    description: String(body.description ?? ""),
    status: "active",
    created_at: now,
    updated_at: now,
    supplier_ids: [],
    quotation_ids: [],
  };
  await createProject(env, auth.user_id, project);
  return jsonResponse({ project }, 201);
});

router.get("/api/projects/:projectId", async (request: Request, env: Env, ctx: { params: { projectId: string } }) => {
  const auth = await requireAuth(request, env);
  const project = await getProject(env, auth.user_id, ctx.params.projectId);
  if (!project) throw new HttpError(404, "Project not found");
  if (project.user_id !== auth.user_id) throw new HttpError(403, "Not project owner");
  return jsonResponse({ project });
});

router.put("/api/projects/:projectId", async (request: Request, env: Env, ctx: { params: { projectId: string } }) => {
  const auth = await requireAuth(request, env);
  const current = await getProject(env, auth.user_id, ctx.params.projectId);
  if (!current) throw new HttpError(404, "Project not found");
  const body = await readJson<Partial<Project>>(request);
  const project = await updateProject(env, auth.user_id, ctx.params.projectId, {
    name: body.name ?? current.name,
    description: body.description ?? current.description,
    status: body.status ?? current.status,
  });
  return jsonResponse({ project });
});

router.delete("/api/projects/:projectId", async (request: Request, env: Env, ctx: { params: { projectId: string } }) => {
  const auth = await requireAuth(request, env);
  if (!(await getProject(env, auth.user_id, ctx.params.projectId))) throw new HttpError(404, "Project not found");
  await deleteProject(env, auth.user_id, ctx.params.projectId);
  return jsonResponse({ deleted: true });
});

router.all("*", () => jsonResponse({ error: "Not found" }, 404));

export default {
  fetch: (request: Request, env: Env): Promise<Response> => {
    requestLogger(request);
    return router.fetch(request, env).catch((error: Error) => errorHandler(error, new URL(request.url).pathname));
  },
};
