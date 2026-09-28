import { Router } from "itty-router";
import { generateRefreshToken, hashPassword, issueToken, validateEmail, verifyPassword, verifyToken } from "../lib/auth";
import { createUser, getUser, getUserByEmail } from "../lib/kv";
import type { Env, LoginRequest, RegisterRequest, User } from "../lib/types";
import { authMiddleware, errorHandler, HttpError, isResponse, jsonResponse, readJson, requestLogger } from "./middleware";

const sanitizeUser = (user: User) => {
  const safeUser: Omit<User, "password_hash"> & { password_hash?: string } = { ...user };
  delete safeUser.password_hash;
  return safeUser;
};
const router = Router();

router.post("/api/auth/register", async (request: Request, env: Env) => {
  const body = await readJson<RegisterRequest>(request);
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();
  if (!validateEmail(email)) throw new HttpError(400, "Invalid email format");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (!name) throw new HttpError(400, "Missing name");
  if (await getUserByEmail(env, email)) throw new HttpError(400, "Email already exists");

  const now = new Date().toISOString();
  const user: User = {
    id: crypto.randomUUID(),
    email,
    name,
    password_hash: await hashPassword(password),
    role: "user",
    created_at: now,
    updated_at: now,
  };
  await createUser(env, user);
  const token = await issueToken(user.id, user.email, env);
  const refresh_token = await generateRefreshToken(user.id, env);
  return jsonResponse({ user: sanitizeUser(user), token, refresh_token });
});

router.post("/api/auth/login", async (request: Request, env: Env) => {
  const body = await readJson<LoginRequest>(request);
  const email = String(body.email ?? "").trim().toLowerCase();
  const user = validateEmail(email) ? await getUserByEmail(env, email) : null;
  if (!user || !(await verifyPassword(String(body.password ?? ""), user.password_hash))) throw new HttpError(401, "Invalid email or password");
  const token = await issueToken(user.id, user.email, env);
  const refresh_token = await generateRefreshToken(user.id, env);
  return jsonResponse({ user: sanitizeUser(user), token, refresh_token });
});

router.post("/api/auth/refresh", async (request: Request, env: Env) => {
  const body = await readJson<{ refresh_token: string }>(request);
  const payload = await verifyToken(body.refresh_token, env);
  if (!payload) throw new HttpError(401, "Invalid refresh token");
  const user = await getUser(env, payload.user_id);
  if (!user) throw new HttpError(404, "User not found");
  return jsonResponse({ token: await issueToken(user.id, user.email, env) });
});

router.get("/api/auth/me", async (request: Request, env: Env) => {
  const auth = await authMiddleware(request, env);
  if (isResponse(auth)) return auth;
  const user = await getUser(env, auth.user_id);
  if (!user) throw new HttpError(404, "User not found");
  return jsonResponse({ user: sanitizeUser(user) });
});

router.all("*", () => jsonResponse({ error: "Not found" }, 404));

export default {
  fetch: (request: Request, env: Env): Promise<Response> => {
    requestLogger(request);
    return router.fetch(request, env).catch((error: Error) => errorHandler(error, new URL(request.url).pathname));
  },
};
