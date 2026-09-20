// Artifact interactive-HTML turn — intent detector + system prompt + brand style.
// Normal streaming path (no special SSE events); the client renders the
// ```html:artifact fence as an interactive preview.
// Brand tokens below mirror gpt_client/src/theme/brands/*.css (light values in
// `colors`, dark values in `dark`). No new dependencies.

export const ARTIFACT_INTENT = /\b(simulation|simulator|interactive visualization|artifact)\b/i;

export const wantsArtifact = (text: string): boolean => ARTIFACT_INTENT.test(text || "");

export const ARTIFACT_SYSTEM_PROMPT =
  "You are generating an interactive artifact. " +
  "Output ONE complete self-contained HTML document inside a single fenced code block tagged ```html:artifact and closed with ```. " +
  "Rules: inline all CSS in <style> and all JS in <script> so the document works standalone; " +
  "Tailwind via CDN is allowed but the page must degrade gracefully offline (core layout and rendering must work without it). " +
  "Include real interactive features: controls such as sliders/buttons/inputs that drive live Canvas or SVG rendering, " +
  "plus a legend and live value readouts. " +
  "Keep prose outside the fence to at most one short intro line; " +
  "never split the code across multiple fences — exactly one ```html:artifact block.";

// Light-mode values live in `colors`; dark-mode values live in `dark`.
// `radius` is the brand's large radius token (card/composer roundness).
export type BrandColors = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
};

export type BrandStyle = {
  fonts: { ui: string; response: string; mono: string };
  colors: BrandColors;
  dark: BrandColors;
  radius: string;
};

export const BRAND_STYLE_GUIDE: Record<string, BrandStyle> = {
  default: {
    fonts: {
      ui: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      response: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    },
    colors: { bg: "#ffffff", surface: "#f4f4f4", text: "#0d0d0d", muted: "#6b7280", accent: "#0f766e", border: "#e5e7eb" },
    dark: { bg: "#212121", surface: "#2f2f2f", text: "#ececf1", muted: "#a1a1aa", accent: "#5eead4", border: "#383838" },
    radius: "12px",
  },
  chatgpt: {
    fonts: {
      ui: '"Söhne", ui-sans-serif, -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      response: '"Söhne", ui-sans-serif, -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      mono: '"Söhne Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    colors: { bg: "#ffffff", surface: "#f4f4f4", text: "#0d0d0d", muted: "#8f8f8f", accent: "#0e7c61", border: "#e5e7eb" },
    dark: { bg: "#212121", surface: "#2f2f2f", text: "#ececf1", muted: "#a1a1aa", accent: "#4ade80", border: "#383838" },
    radius: "16px",
  },
  claude: {
    fonts: {
      ui: '"Styrene B", "Anthropic Sans", system-ui, -apple-system, sans-serif',
      response: '"Tiempos Text", "Copernicus", "Anthropic Serif", ui-serif, Georgia, serif',
      mono: '"Anthropic Mono", "JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace',
    },
    colors: { bg: "#faf9f5", surface: "#ece9e0", text: "#1f1e1d", muted: "#6b6560", accent: "#9a4a2e", border: "#e3ddd0" },
    dark: { bg: "#1f1e1d", surface: "#2a2725", text: "#f5f4ef", muted: "#c4b8a8", accent: "#e0a080", border: "#3d3835" },
    radius: "16px",
  },
  gemini: {
    fonts: {
      ui: '"Google Sans Text", "Google Sans", Roboto, Arial, sans-serif',
      response: '"Google Sans Text", "Google Sans", Roboto, Arial, sans-serif',
      mono: '"Google Sans Code", "Roboto Mono", Consolas, "Courier New", monospace',
    },
    colors: { bg: "#ffffff", surface: "#f0f4f9", text: "#1f1f1f", muted: "#5f6368", accent: "#1a73e8", border: "#dfe3ea" },
    dark: { bg: "#131314", surface: "#282a2c", text: "#e3e3e3", muted: "#9aa0a6", accent: "#a8c7fa", border: "#444746" },
    radius: "28px",
  },
  grok: {
    fonts: {
      ui: '"Universal Sans", Inter, Roboto, "Open Sans", Arial, system-ui, sans-serif',
      response: '"Universal Sans", Inter, Roboto, "Open Sans", Arial, system-ui, sans-serif',
      mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    colors: { bg: "#ffffff", surface: "#eff3f4", text: "#000000", muted: "#536471", accent: "#0b6cab", border: "#cfd9de" },
    dark: { bg: "#000000", surface: "#16181c", text: "#ffffff", muted: "#8b98a5", accent: "#1d9bf0", border: "#2f3336" },
    radius: "16px",
  },
  deepseek: {
    fonts: {
      ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
      response: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
      mono: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace',
    },
    colors: { bg: "#ffffff", surface: "#f2f2f7", text: "#1a1a2e", muted: "#5b5b7a", accent: "#3b4fd8", border: "#e2e2ec" },
    dark: { bg: "#1a1b26", surface: "#242636", text: "#e6e6f0", muted: "#9aa0b4", accent: "#7c8aff", border: "#34374e" },
    radius: "12px",
  },
};

export const normalizeBrandId = (raw?: string | null): string => {
  const b = (raw || "").trim().toLowerCase();
  if (b && Object.prototype.hasOwnProperty.call(BRAND_STYLE_GUIDE, b)) return b;
  return "default";
};

// Full system prompt for artifact turns: base prompt + exact brand style +
// compact 75vh / minimal-content fit rules. `userPrompt` is the optional
// caller-supplied systemPrompt, appended as additional instructions.
export const buildArtifactPrompt = (brandId?: string | null, userPrompt?: string): string => {
  const id = normalizeBrandId(brandId);
  const s = BRAND_STYLE_GUIDE[id] || BRAND_STYLE_GUIDE["default"];
  const extra = (userPrompt || "").trim();
  const style =
    `\n\nApp style (match exactly): brand "${id}". ` +
    `fonts UI ${s.fonts.ui}; response font ${s.fonts.response}; mono font ${s.fonts.mono}. ` +
    `Light mode: background ${s.colors.bg}; surface ${s.colors.surface}; text ${s.colors.text}; ` +
    `muted ${s.colors.muted}; accent ${s.colors.accent}; border ${s.colors.border}. ` +
    `Dark mode: background ${s.dark.bg}; surface ${s.dark.surface}; text ${s.dark.text}; ` +
    `muted ${s.dark.muted}; accent ${s.dark.accent}; border ${s.dark.border}. ` +
    `Border-radius ${s.radius}. ` +
    `Define CSS variables for the light values and override them inside ` +
    `@media (prefers-color-scheme: dark) with the dark values, so the artifact supports BOTH light and dark mode. ` +
    `Layout must be compact/minimal and fit within 75vh height; the root container must use max-height: 75vh with ` +
    `internal scroll if needed (overflow: auto on the content region, never page-level scroll). ` +
    `Use minimal content (no filler text): only the controls, canvas/SVG, legend, and live readouts the user asked for; ` +
    `no lorem ipsum, no extra sections, tight spacing and small headings. ` +
    `Flat layout: do NOT render your own title/header block (the host card already shows the title), ` +
    `do NOT wrap content in an outer card, border, or shadow container, and do NOT set a page-level background color ` +
    `(use transparent so it blends seamlessly). ` +
    `Content must fill the full width with 1rem inner padding; canvas/SVG elements use width 100%.`;
  return extra
    ? `${ARTIFACT_SYSTEM_PROMPT}${style}\n\nAdditional instructions:\n${extra}`
    : `${ARTIFACT_SYSTEM_PROMPT}${style}`;
};
