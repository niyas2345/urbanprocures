import { verifyToken } from "../lib/auth";
import type { ApiResponse, Env } from "../lib/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const corsHeaders = (): Record<string, string> => ({
  "Access-Control-Allow-Origin": "https://urbanprocures.com",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Signature",
});

export const jsonResponse = <T>(data: T, status = 200): Response => {
  const body: ApiResponse<T> = { success: status < 400, data, timestamp: new Date().toISOString() };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
};

export const errorResponse = (error: string, status = 500): Response =>
  new Response(JSON.stringify({ success: false, error, timestamp: new Date().toISOString() }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });

export const requestLogger = (request: Request): void => {
  console.info(JSON.stringify({ method: request.method, path: new URL(request.url).pathname, timestamp: new Date().toISOString() }));
};

export const errorHandler = (error: Error, route: string): Response => {
  const status = error instanceof HttpError ? error.status : 500;
  console.error(JSON.stringify({ route, status, message: error.message, stack: error.stack, timestamp: new Date().toISOString() }));
  return errorResponse(error.message, status);
};

export const authMiddleware = async (
  request: Request,
  env: Env,
): Promise<{ user_id: string; email: string } | Response> => {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
  const payload = await verifyToken(header.slice(7), env);
  return payload ?? errorResponse("Unauthorized", 401);
};

export const readJson = async <T>(request: Request): Promise<T> => {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
};

export const isResponse = (value: unknown): value is Response => value instanceof Response;
