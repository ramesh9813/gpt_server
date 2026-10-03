// YouTube video transcripts (captions) — no API key needed.
// Technique: YouTube's public InnerTube player endpoint (same approach as
// lstrzepek/obsidian-yt-transcript) returns caption tracks; the chosen
// timedtext track is parsed into exact transcript lines. When the user sends
// a video link asking to transcribe it, the full text is injected so the
// model answers from (or reproduces) the exact words.
import type { WebResult } from "./websearch";

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
  /\b(transcrib\w*|transcript|captions?|subtitles?|exact\s+text|word\s+for\s+word|what\s+(is\s+|was\s+)?said|summar\w*\s+(this\s+)?video|explain\s+(this\s+)?video)\b/i;

// A YouTube link plus a transcribe-style ask — not a "watch this" browse.
export const wantsTranscript = (text: string): boolean => {
  const t = (text || "").trim();
  if (!t) return false;
  return extractYouTubeVideoId(t) !== null && TRANSCRIBE_WORDS_RE.test(t);
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

export const fetchYouTubeTranscript = async (
  videoId: string,
  lang = "en"
): Promise<VideoTranscript | null> => {
  try {
    const playerRes = await fetch(INNERTUBE_PLAYER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": IOS_UA },
      body: JSON.stringify({
        context: {
          ...INNERTUBE_CONTEXT,
          client: { ...INNERTUBE_CONTEXT.client, hl: lang },
        },
        videoId,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!playerRes.ok) return null;
    const player = (await playerRes.json()) as any;
    const status = player?.playabilityStatus?.status;
    if (status === "ERROR" || status === "LOGIN_REQUIRED" || status === "UNPLAYABLE") return null;
    const title =
      typeof player?.videoDetails?.title === "string" && player.videoDetails.title
        ? player.videoDetails.title.slice(0, 200)
        : videoId;
    const tracks: CaptionTrack[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const track = pickCaptionTrack(tracks, lang);
    if (!track?.baseUrl) return null;
    const capRes = await fetch(track.baseUrl, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15000),
    });
    if (!capRes.ok) return null;
    const xml = await capRes.text();
    if (!xml) return null;
    const lines = parseTranscriptXml(xml);
    if (lines.length === 0) return null;
    const text = lines
      .map((l) => l.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TRANSCRIPT_CHARS);
    if (!text) return null;
    return { videoId, title, language: track.languageCode, lines, text };
  } catch {
    return null;
  }
};

export type VideoTranscriptResult = {
  block: string;
  sources: Array<{ title: string; url: string }>;
  lines: number;
};

// "Transcribe this video <link>" → the exact transcript as answer context.
// Same shape as page fetch so gates treat it identically (sources included).
export const fetchVideoTranscriptFor = async (text: string): Promise<VideoTranscriptResult | null> => {
  if (!wantsTranscript(text)) return null;
  const videoId = extractYouTubeVideoId(text);
  if (!videoId) return null;
  const tr = await fetchYouTubeTranscript(videoId);
  if (!tr) return null;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
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
