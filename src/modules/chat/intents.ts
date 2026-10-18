// Turn-intent detectors — split from chat.service.ts. No logic changes.
const IMAGE_INTENT = /\b(generat\w*|creat\w*|draw\w*|paint\w*|design\w*|render\w*|mak\w*|produc\w*)\b.{0,50}\b(image|picture|photo|artwork|logo|illustration|avatar|banner|drawing|painting|wallpaper|icon)\b|\b(image|picture|photo|logo)\s+of\b|\bdraw\s+me\b/i;

const SEARCH_GUARD_RE = /\bsearch\b/i;

export const wantsImageGeneration = (text: string): boolean => {
  const t = text || "";
  if (SEARCH_GUARD_RE.test(t)) return false;
  return IMAGE_INTENT.test(t);
};

const VIDEO_INTENT =
  /\b(generat\w*|creat\w*|mak\w*|develop\w*|build\w*|produc\w*|direct\w*)\b.{0,50}\b(video|clip|animation|movie|reel|short film|footage)\b|\bvideo\s+of\b/i;

export const wantsVideo = (text: string): boolean => {
  const t = text || "";
  if (SEARCH_GUARD_RE.test(t)) return false;
  return VIDEO_INTENT.test(t);
};

// Alias kept for discoverability alongside wantsImageGeneration.
export const wantsVideoGeneration = wantsVideo;

export const MAX_VIDEOS = 3;
