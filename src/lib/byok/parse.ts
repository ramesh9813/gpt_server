import type { Request } from "express";
import { getByokProvider } from "./registry";
import type { ByokRequest } from "../byokTypes";

export const parseByokHeaders = (req: Request): ByokRequest | { error: string } | null => {
  const providerRaw = String(req.headers["x-byok-provider"] ?? "").trim();
  if (!providerRaw) return null;
  const provider = getByokProvider(providerRaw);
  if (!provider) return { error: `Unknown provider "${providerRaw}".` };
  let model = String(req.headers["x-byok-model"] ?? "").trim();
  const prefix = `${provider.id}:`.toLowerCase();
  if (model.toLowerCase().startsWith(prefix)) model = model.slice(prefix.length).trim();
  if (!model || model.length > 200) return { error: "A model must be selected for the custom provider." };
  const apiKey = String(req.headers["x-byok-key"] ?? "").trim();
  if (!apiKey || apiKey.length > 600) return { error: `A valid ${provider.name} API key is required.` };
  return { provider, model, apiKey };
};
