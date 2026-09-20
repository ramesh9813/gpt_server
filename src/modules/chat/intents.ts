// Turn-intent detectors — split from chat.service.ts. No logic changes.
const IMAGE_INTENT = /\b(generat\w*|creat\w*|draw\w*|paint\w*|design\w*|render\w*|mak\w*|produc\w*)\b.{0,50}\b(image|picture|photo|artwork|logo|illustration|avatar|banner|drawing|painting|wallpaper|icon)\b|\b(image|picture|photo|logo)\s+of\b|\bdraw\s+me\b/i;

export const wantsImageGeneration = (text: string): boolean =>
  IMAGE_INTENT.test(text || "");

const VIDEO_INTENT =
  /\b(generat\w*|creat\w*|mak\w*|develop\w*|build\w*|produc\w*|direct\w*)\b.{0,50}\b(video|clip|animation|movie|reel|short film|footage)\b|\bvideo\s+of\b/i;

export const wantsVideo = (text: string): boolean =>
  VIDEO_INTENT.test(text || "");

// Alias kept for discoverability alongside wantsImageGeneration.
export const wantsVideoGeneration = wantsVideo;

export const MAX_VIDEOS = 3;
