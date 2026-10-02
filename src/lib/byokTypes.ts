export type ByokProviderId =
  | "openrouter"
  | "openai"
  | "google"
  | "grok"
  | "meta"
  | "nvidia"
  | "deepseek"
  | "qwen"
  | "moonshot"
  | "groq"
  | "mistral"
  | "anthropic"
  | "cleanapis"
  | "infron"
  | "apinex"
  | "codecraft";

export type ByokApiKind = "openai" | "gemini" | "anthropic";

export type ByokProvider = {
  id: ByokProviderId;
  name: string;
  kind: ByokApiKind;
  baseUrl: string;
  keyPattern: RegExp;
  keyHint: string;
  keylessModels: boolean;
  models: string[];
  chatHeaders?: Record<string, string>;
  streamUsage?: boolean;
  allModelsFree?: boolean;
};

export type ByokRequest = {
  provider: ByokProvider;
  model: string;
  apiKey: string;
};

export type ByokModelCatalog = { models: string[]; freeIds: string[] };
