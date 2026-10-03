// YouTube video transcripts (captions) — no API key needed.
// Technique: YouTube's public InnerTube player endpoint (same approach as
// lstrzepek/obsidian-yt-transcript) returns caption tracks; the chosen
// timedtext track is parsed into exact transcript lines. When the user sends
// a video link asking to transcribe it, the full text is injected so the
// model answers from (or reproduces) the exact words.
import type { WebResult } from "./websearch";
import { logger } from "./logger";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// YouTube's public embedded-player key (shipped in countless clients).
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`;

// IOS client returns caption URLs that work without extra auth.
const INNERTUBE_CONTEXT = {
  client: { clientName: "IOS", clientVersion: "20.10.38", hl: "en", gl: "US" },
};
const IOS_UA = "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)";

const MAX_TRANSCRIPT_CHARS = 20000;

export type TranscriptLine = { text: string; offsetMs: number };

export const extractYouTubeVideoId = (text: string): string | null => {
  const patterns = [
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/|v\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/watch\?.*[?&]v=)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = (text || "").match(pattern);
    if (match) return match[1];
  }
  return null;
};

const TRANSCRIBE_WORDS_RE =
  /\b(transcrib\w*|transcript|captions?|subtitles?|detail\w*|exact\s+text|word\s+for\s+word|what\s+(is\s+|was\s+)?said|summar\w*(\s+(this\s+)?video)?|explain\s+(this\s+)?video)\b/i;

// A YouTube link plus either explicit transcribe/detail words or just a
// short generic ask ("get this one <url>", "this video?") — both mean the
// user wants the video's content, not a web search. Long messages that merely
// reference a video fall through to normal handling.
export const wantsTranscript = (text: string): boolean => {
  const t = (text || "").trim();
  if (!t) return false;
  if (extractYouTubeVideoId(t) === null) return false;
  if (TRANSCRIBE_WORDS_RE.test(t)) return true;
  const withoutUrls = t
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, " ")
    .replace(/[.,;:!?)\]]+$/, "")
    .trim();
  const words = withoutUrls.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 12;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\n/g, " ")
    .trim();

// Timedtext XML comes as <text start dur> (srv3) or <p t d> — same parser
// shape as the reference implementation.
export const parseTranscriptXml = (xml: string): TranscriptLine[] => {
  const lines: TranscriptLine[] = [];
  const textRe = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(xml)) !== null) {
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, ""));
    if (text) {
      lines.push({
        text,
        offsetMs: Math.round(parseFloat(m[1]) * 1000),
      });
    }
  }
  if (lines.length === 0) {
    const pRe = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = pRe.exec(xml)) !== null) {
      const text = decodeEntities(m[3].replace(/<[^>]+>/g, ""));
      if (text) lines.push({ text, offsetMs: parseInt(m[1], 10) });
    }
  }
  return lines;
};

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string };

// Manual captions beat auto-generated (kind "asr") for the same language;
// otherwise first available track wins.
export const pickCaptionTrack = (tracks: CaptionTrack[], lang: string): CaptionTrack | null => {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const exact = tracks.filter((t) => t.languageCode === lang);
  const prefix = tracks.filter(
    (t) => t.languageCode.startsWith(`${lang}-`) || lang.startsWith(`${t.languageCode}-`)
  );
  for (const pool of [exact, prefix]) {
    const manual = pool.find((t) => t.kind !== "asr");
    if (manual) return manual;
    if (pool.length > 0) return pool[0];
  }
  const manual = tracks.find((t) => t.kind !== "asr");
  return manual ?? tracks[0] ?? null;
};

export type VideoTranscript = {
  videoId: string;
  title: string;
  language: string;
  lines: TranscriptLine[];
  text: string;
};

export type TranscriptFailureReason = "no-captions" | "unreachable" | "unplayable";

export type TranscriptFetchResult =
  | { ok: true; transcript: VideoTranscript }
  | { ok: false; reason: TranscriptFailureReason };

type PlayerData = { title: string; tracks: CaptionTrack[] } | null;

const fetchPlayerViaInnerTube = async (
  videoId: string,
  lang: string,
  preset: "ios" | "tv" = "ios"
): Promise<{ data: any } | null> => {
  const client =
    preset === "tv"
      ? { clientName: "TVHTML5", clientVersion: "7.20241024", hl: lang, gl: "US" }
      : { ...INNERTUBE_CONTEXT.client, hl: lang };
  try {
    const res = await fetch(INNERTUBE_PLAYER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": preset === "tv" ? UA : IOS_UA,
      },
      body: JSON.stringify({ context: { client }, videoId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return { data: await res.json() };
  } catch {
    return null;
  }
};

// Fallback when the player endpoint is throttled/blocked for datacenter
// IPs: the watch page embeds the same caption track list. Balanced-bracket
// scan extracts the captionTracks array without a full JSON parse.
const fetchPlayerViaWatchPage = async (videoId: string): Promise<PlayerData> => {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+1",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html) return null;
    const keyIdx = html.indexOf('"captionTracks":');
    if (keyIdx === -1) return null;
    const start = html.indexOf("[", keyIdx);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length && i < start + 200000; i++) {
      const c = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          try {
            const tracks = JSON.parse(html.slice(start, i + 1));
            if (!Array.isArray(tracks) || tracks.length === 0) return null;
            const titleMatch =
              html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
            return {
              title: titleMatch ? titleMatch[1].slice(0, 200) : videoId,
              tracks,
            };
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
};

const playerDataToTracks = (player: any): { title: string; tracks: CaptionTrack[] } => ({
  title:
    typeof player?.videoDetails?.title === "string" && player.videoDetails.title
      ? player.videoDetails.title.slice(0, 200)
      : "",
  tracks: player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
});

export const fetchYouTubeTranscriptDetailed = async (
  videoId: string,
  lang = "en"
): Promise<TranscriptFetchResult> => {
  // IOS first (caption URLs work without extra auth), then the TV client
  // (often passes bot-checks that fail datacenter IPs on other clients),
  // then the watch-page scrape. First playable response with tracks wins.
  const attempts: Array<{ data: any } | null> = [await fetchPlayerViaInnerTube(videoId, lang, "ios")];
  const firstStatus = attempts[0]?.data?.playabilityStatus?.status;
  if (!attempts[0] || (firstStatus && firstStatus !== "OK")) {
    attempts.push(await fetchPlayerViaInnerTube(videoId, lang, "tv"));
  }
  let title = "";
  let tracks: CaptionTrack[] = [];
  let playable = false;
  let blockedReason = "";
  for (const attempt of attempts) {
    if (!attempt) continue;
    const status = attempt.data?.playabilityStatus?.status;
    if (status && status !== "OK") {
      blockedReason = String(attempt.data?.playabilityStatus?.reason ?? status).slice(0, 200);
      continue;
    }
    playable = true;
    const parsed = playerDataToTracks(attempt.data);
    if (parsed.title) title = parsed.title;
    if (Array.isArray(parsed.tracks) && parsed.tracks.length > 0) {
      tracks = parsed.tracks;
      break;
    }
  }
  if (tracks.length === 0) {
    // InnerTube throttled/empty for this network — try the watch page once.
    const viaWatch = await fetchPlayerViaWatchPage(videoId);
    if (viaWatch) {
      title = viaWatch.title;
      tracks = viaWatch.tracks;
    }
  }
  if (tracks.length === 0) {
    // Log the cause server-side: distinguishes genuine no-captions from
    // datacenter-IP bot gating (Render logs will show the reason).
    logger.warn({ videoId, playable, blockedReason: blockedReason || undefined }, "YouTube transcript unavailable");
    if (!playable && attempts.every((a) => a === null)) return { ok: false, reason: "unreachable" };
    if (!playable) return { ok: false, reason: "unplayable" };
    return { ok: false, reason: "no-captions" };
  }
  const track = pickCaptionTrack(tracks, lang);
  if (!track?.baseUrl) return { ok: false, reason: "no-captions" };
  try {
    const capRes = await fetch(track.baseUrl, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15000),
    });
    if (!capRes.ok) return { ok: false, reason: "unreachable" };
    const xml = await capRes.text();
    if (!xml) return { ok: false, reason: "unreachable" };
    const lines = parseTranscriptXml(xml);
    if (lines.length === 0) return { ok: false, reason: "no-captions" };
    const text = lines
      .map((l) => l.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TRANSCRIPT_CHARS);
    if (!text) return { ok: false, reason: "no-captions" };
    return {
      ok: true,
      transcript: { videoId, title: title || videoId, language: track.languageCode, lines, text },
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
};

export const fetchYouTubeTranscript = async (
  videoId: string,
  lang = "en"
): Promise<VideoTranscript | null> => {
  const r = await fetchYouTubeTranscriptDetailed(videoId, lang);
  return r.ok ? r.transcript : null;
};

export type VideoTranscriptResult = {
  block: string;
  sources: Array<{ title: string; url: string }>;
  lines: number;
};

export type TranscriptUnavailable = {
  unavailable: TranscriptFailureReason;
  url: string;
};

// System instruction when a transcribe ask cannot be fulfilled — names the
// exact cause so the model never falls back to a generic "I can't browse"
// refusal.
export const transcriptUnavailableNote = (reason: TranscriptFailureReason, url: string): string => {
  if (reason === "unreachable") {
    return `The user asked to transcribe this YouTube video (${url}), but YouTube could not be reached from the server just now (network or rate limit). Tell them in one or two sentences to retry in a bit. Do not claim broader inability to browse or process content.`;
  }
  if (reason === "unplayable") {
    return `The user asked to transcribe this YouTube video (${url}), but the video is unavailable, private, or login-restricted. Tell them plainly in one or two sentences. Do not claim broader inability to browse or process content.`;
  }
  return `The user asked to transcribe this YouTube video (${url}), but no captions or subtitles could be retrieved for it. Tell them in one or two sentences that this video has no available captions so you cannot transcribe it. Do not claim broader inability to browse or process content.`;
};

// "Transcribe this video <link>" → the exact transcript as answer context.
// Same shape as page fetch so gates treat it identically (sources included).
// Intent without retrievable captions yields { unavailable } with the reason.
export const fetchVideoTranscriptFor = async (
  text: string
): Promise<VideoTranscriptResult | TranscriptUnavailable | null> => {
  if (!wantsTranscript(text)) return null;
  const videoId = extractYouTubeVideoId(text);
  if (!videoId) return null;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const r = await fetchYouTubeTranscriptDetailed(videoId);
  if (!r.ok) return { unavailable: r.reason, url };
  const tr = r.transcript;
  const block =
    `The user shared this video and asked for its transcript. Below is the exact spoken text ` +
    `("${tr.title}"). When asked to transcribe, reproduce it faithfully and completely; ` +
    `when asked about it, answer from this text. If something is not in the transcript, say so.\n\n${tr.text}`;
  return {
    block,
    sources: [{ title: tr.title, url }],
    lines: tr.lines.length,
  };
};

export type { WebResult };
