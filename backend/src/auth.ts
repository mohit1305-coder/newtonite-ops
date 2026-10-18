import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { FastifyRequest } from "fastify";
import { config } from "./config";
import { HttpError } from "./errors";

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compareSync(pw, hash);

export const signToken = (userId: string) =>
  jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: "8h" });

/**
 * The token only proves *who* the user is. Roles are always read from the
 * database per request, so changing a membership takes effect immediately.
 */
export function authenticate(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    throw new HttpError(401, "UNAUTHENTICATED", "Missing bearer token");
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string };
    return payload.sub;
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "Invalid or expired token");
  }
}
