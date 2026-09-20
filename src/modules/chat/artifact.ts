// Artifact interactive-HTML turn — intent detector + system prompt.
// Normal streaming path (no special SSE events); the client renders the
// ```html:artifact fence as an interactive preview.

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
