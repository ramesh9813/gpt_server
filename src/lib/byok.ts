// Bring-your-own-key (BYOK) provider registry — façade re-export.
// New code should import from ./byok/* or ./byokTypes directly.
export type { ByokProviderId, ByokApiKind, ByokProvider, ByokRequest, ByokModelCatalog } from "./byokTypes";
export { BYOK_PROVIDERS, getByokProvider } from "./byok/registry";
export { BYOK_USER_AGENT, isFirewallChallengeBody, firewallChallengeMessage, providerStatusError, isByokKeyFormatSupported } from "./byok/utils";
export { parseByokHeaders } from "./byok/parse";
export { fetchByokModels } from "./byok/catalog";
