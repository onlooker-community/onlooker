import * as jose from "jose";
import * as bcrypt from "bcryptjs";

export interface JwtPayload {
  sub: string; // user ID
  email: string;
  type: "access" | "refresh"; // token type
  iat: number;
  exp: number;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Verify a password against a bcrypt hash
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Sign a JWT token
 */
export async function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  expiresInMinutes: number,
): Promise<string> {
  const secretKey = await jose.importSPKI(
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    "HS256",
  );

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInMinutes}m`)
    .sign(secretKey);
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  try {
    const secretKey = await jose.importSPKI(
      `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
      "HS256",
    );

    const verified = await jose.jwtVerify(token, secretKey);
    return verified.payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Generate a random refresh token
 */
export function generateRefreshToken(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
