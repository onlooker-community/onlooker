import { verifyJwt } from "../utils/crypto";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Extract JWT token from Authorization header
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Require a valid JWT token in the request
 * Throws ApiError if missing or invalid
 */
export async function requireAuth(
  request: Request,
  env: WorkerEnv,
): Promise<{ userId: string; email: string }> {
  const token = extractToken(request);
  if (!token) {
    throw new ApiError(401, "unauthorized", "Missing authorization token");
  }

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || payload.type !== "access") {
    throw new ApiError(401, "invalid_token", "Invalid or expired token");
  }

  return {
    userId: payload.sub,
    email: payload.email,
  };
}

/**
 * Optional auth - returns auth context if valid, null otherwise
 */
export async function optionalAuth(
  request: Request,
  env: WorkerEnv,
): Promise<{ userId: string; email: string } | null> {
  const token = extractToken(request);
  if (!token) return null;

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || payload.type !== "access") return null;

  return {
    userId: payload.sub,
    email: payload.email,
  };
}
