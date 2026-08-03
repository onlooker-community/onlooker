import type { D1Database } from "@cloudflare/workers-types";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name?: string;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

/**
 * Create a new user in the database
 */
export async function createUser(
  db: D1Database,
  email: string,
  passwordHash: string,
  name?: string,
): Promise<{ id: string; email: string; name?: string }> {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  const result = await db
    .prepare(
      `
      INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .bind(userId, email, passwordHash, name || null, false, now, now)
    .run();

  if (!result.success) {
    throw new Error(`Failed to create user: ${result.error}`);
  }

  return { id: userId, email, name };
}

/**
 * Get user by email address
 */
export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<User | null> {
  const result = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first();

  return (result as unknown as User) || null;
}

/**
 * Get user by ID
 */
export async function getUserById(
  db: D1Database,
  userId: string,
): Promise<Omit<User, "password_hash"> | null> {
  const result = await db
    .prepare("SELECT id, email, name, email_verified, created_at, updated_at FROM users WHERE id = ?")
    .bind(userId)
    .first();

  return (result as Omit<User, "password_hash">) || null;
}

/**
 * Store a refresh token
 */
export async function storeRefreshToken(
  db: D1Database,
  userId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  const tokenId = crypto.randomUUID();
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();

  const result = await db
    .prepare(
      `
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .bind(tokenId, userId, tokenHash, expiresAt.toISOString(), now)
    .run();

  if (!result.success) {
    throw new Error(`Failed to store refresh token: ${result.error}`);
  }
}

/**
 * Get refresh token
 */
export async function getRefreshToken(
  db: D1Database,
  token: string,
): Promise<{ user_id: string; expires_at: string } | null> {
  const tokenHash = await hashToken(token);

  const result = await db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first();

  if (!result) return null;

  // Check if expired
  const expiresAt = new Date(result.expires_at as string);
  if (expiresAt < new Date()) {
    return null;
  }

  return {
    user_id: result.user_id as string,
    expires_at: result.expires_at as string,
  };
}

/**
 * Revoke (delete) a refresh token
 */
export async function revokeRefreshToken(
  db: D1Database,
  token: string,
): Promise<void> {
  const tokenHash = await hashToken(token);

  const result = await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .run();

  if (!result.success) {
    throw new Error(`Failed to revoke token: ${result.error}`);
  }
}

/**
 * Simple hash for token comparison (not password - tokens use SHA256)
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
