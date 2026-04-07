import "express";
import { UserRole } from "../lib/userRoles";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      role: UserRole;
    };
  }
}
