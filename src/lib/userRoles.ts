import { ownerEmails, adminEmails } from "./config";

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

export const isAdminEmail = (email: string | null | undefined): boolean => {
  if (!email) return false;
  return adminEmails.has(email.trim().toLowerCase());
};

// The role an email address is pinned to via env lists, if any.
export const emailPinnedRole = (
  email: string | null | undefined
): UserRole | null => {
  if (isOwnerEmail(email)) return "owner";
  if (isAdminEmail(email)) return "admin";
  return null;
};

// Owner/admin emails always resolve to their pinned role, even if the stored
// DB role is stale. Everyone else is whatever their stored role says.
export const effectiveRole = (
  email: string | null | undefined,
  storedRole: string | null | undefined
): UserRole => {
  return emailPinnedRole(email) ?? normalizeUserRole(storedRole);
};
