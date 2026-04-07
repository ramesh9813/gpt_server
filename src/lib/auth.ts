import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "./config";
import { UserRole } from "./userRoles";

export type JwtPayload = {
  sub: string;
  role: UserRole;
};

export const hashPassword = async (password: string) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const verifyPassword = async (password: string, hash: string) => {
  return bcrypt.compare(password, hash);
};

export const signAccessToken = (payload: JwtPayload) => {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
};

export const signRefreshToken = (payload: JwtPayload) => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
};

export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
};

export const verifyRefreshToken = (token: string) => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
};

export const hashToken = (token: string) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};
