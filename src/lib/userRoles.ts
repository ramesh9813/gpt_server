import { ownerEmails } from "./config";

export type UserRole = "admin" | "owner" | "user";

export const FREE_MODEL_ONLY_ROLE: UserRole = "user";

export const normalizeUserRole = (role: string | null | undefined): UserRole => {
  const normalized = (role || "").trim().toLowerCase();

  if (normalized === "admin") return "admin";
  if (normalized === "owner") return "owner";
  if (normalized === "user") return "user";
  // Legacy roles from before the 3-role model map to the safe default.
  if (normalized === "premium" || normalized === "lite") return "user";

  return "user";
};

export const isOwnerEmail = (email: string | null | undefined): boolean => {
  if (!email) return false;
  return ownerEmails.has(email.trim().toLowerCase());
};

// Owner emails always resolve to owner, even if the stored DB role is stale.
export const effectiveRole = (
  email: string | null | undefined,
  storedRole: string | null | undefined
): UserRole => {
  if (isOwnerEmail(email)) return "owner";
  return normalizeUserRole(storedRole);
};
