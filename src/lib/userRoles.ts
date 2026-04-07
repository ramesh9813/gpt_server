export type UserRole = "owner" | "premium" | "lite" | "user";

export const FREE_MODEL_ONLY_ROLE: UserRole = "user";

export const normalizeUserRole = (role: string | null | undefined): UserRole => {
  const normalized = (role || "").trim().toLowerCase();

  if (normalized === "owner") return "owner";
  if (normalized === "premium") return "premium";
  if (normalized === "lite") return "lite";
  if (normalized === "admin") return "owner";

  return "user";
};
