import bcrypt from "bcryptjs";
import type { AuthPayload, Env, LoginRequest, RegisterRequest, User } from "./types";

export type { AuthPayload, LoginRequest, RegisterRequest, User };

const enc = new TextEncoder();

const b64url = (value: string | ArrayBuffer): string => {
  const bytes = typeof value === "string" ? enc.encode(value) : new Uint8Array(value);
  let raw = "";
  bytes.forEach((byte) => {
    raw += String.fromCharCode(byte);
  });
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromB64url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const sign = async (input: string, secret: string): Promise<string> =>
  b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(input)));

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, 10);

export const verifyPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

export const validateEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const createToken = async (payload: AuthPayload, env: Env): Promise<string> => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${await sign(unsigned, env.JWT_SECRET)}`;
};

export const issueToken = (userId: string, email: string, env: Env): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return createToken({ user_id: userId, email, iat: now, exp: now + 24 * 60 * 60 }, env);
};

export const generateRefreshToken = (userId: string, env: Env): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return createToken({ user_id: userId, email: "", iat: now, exp: now + 7 * 24 * 60 * 60 }, env);
};

export const verifyToken = async (token: string, env: Env): Promise<{ user_id: string; email: string } | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const unsigned = `${header}.${body}`;
  if ((await sign(unsigned, env.JWT_SECRET)) !== signature) return null;

  try {
    const payload = JSON.parse(fromB64url(body)) as AuthPayload;
    if (!payload.user_id || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { user_id: payload.user_id, email: payload.email };
  } catch {
    return null;
  }
};
