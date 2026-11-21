// Picking the right YouTube upload for a playlist row. Search results are
// scored against the wanted title, artist and length, so a likely-wrong video
// goes to the review list instead of being downloaded.

// song-length numbers above this are milliseconds, not seconds
const MAX_SECONDS_AS_NUMBER = 3600
// longer than this is a compilation / jukebox, not one song
const LONG_VIDEO_SEC = 15 * 60
// how far a video's length may be from the CSV's and still count
const MAX_DURATION_DIFF_SEC = 60
// share of the title's words a confident match must contain
const MIN_CONFIDENT_TITLE_SCORE = 0.8

// Words that mark a different version of a song. They only count against a
// video when the wanted title doesn't contain them ("KALYANI - Remix" may
// match a remix).
const VARIANT_WORDS = [
  'live',
  'cover',
  'remix',
  'karaoke',
  'instrumental',
  '8d',
  'slowed',
  'reverb',
  'sped up',
  'nightcore',
  'lofi',
  'lo fi',
  'acoustic',
  'reaction',
  'teaser',
  'trailer',
  '1 hour',
  'loop',
  'mashup',
  'jukebox',
  'tutorial',
  'status',
  'shorts'
]

// lowercase with accents removed: "Beyoncé" -> "beyonce"
function fold (s) {
  return String(s).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
}

// Loose text for matching: drop bracketed qualifiers like
// "(From "Delhi-6")" or "[2013 Remaster]", drop "feat. …", and collapse
// everything else to single spaces.
function looseText (s) {
  return fold(s)
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Like looseText but keeps bracketed words, which often say "(Live)" or
// "[Slowed + Reverb]"
function plainText (s) {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// "Pritam,KK,Sayeed Quadri" -> ["pritam", "kk", "sayeed quadri"]
function splitArtists (artist) {
  return String(artist)
    .split(/[,;&/]|\s+(?:feat|ft)\.?\s+/i)
    .map(looseText)
    .filter(Boolean)
}

// whole words only: "live" is in "live at wembley", not in "deliver"
function hasWords (text, words) {
  return words !== '' && ` ${text} `.includes(` ${words} `)
}

// yt-search's result (or an already plain one) -> one shape for the app
function normalizeVideo (raw) {
  const videoId = String(raw.videoId)
  return {
    videoId,
    url: raw.url || `https://www.youtube.com/watch?v=${videoId}`,
    title: String(raw.title || ''),
    channel: String(raw.channel ?? raw.author?.name ?? ''),
    durationSec: Number(raw.durationSec ?? raw.seconds ?? raw.duration?.seconds) || null,
    views: Number(raw.views) || null,
    thumbnail: raw.thumbnail || raw.image || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  }
}

function durationScoreFor (diffSec) {
  if (diffSec == null) return 0.5 // unknown: neither helps nor hurts
  if (diffSec <= 10) return 1
  if (diffSec <= 30) return 0.6
  if (diffSec <= MAX_DURATION_DIFF_SEC) return 0.3
  return 0
}

function labelFor (score) {
  if (score >= 0.75) return 'Good match'
  if (score >= 0.5) return 'Possible'
  return 'Unlikely'
}

// How well one video matches the wanted { title, artist, durationSec? }.
// Title words carry most weight, then the artist (in the title or channel),
// then the length; official / "Artist - Topic" uploads get a small bonus and
// other versions (live, cover, slowed…) a penalty.
function scoreCandidate (video, wanted) {
  const videoText = plainText(video.title)
  const channelText = plainText(video.channel || '')
  const wantedText = plainText(wanted.title)

  const titleWords = looseText(wanted.title).split(' ').filter(Boolean)
  const foundWords = titleWords.filter((word) => hasWords(videoText, word))
  const titleScore = titleWords.length ? foundWords.length / titleWords.length : 0

  const artistMatch = splitArtists(wanted.artist || '').some(
    (artist) => hasWords(videoText, artist) || hasWords(channelText, artist)
  )

  const variant = VARIANT_WORDS.filter(
    (word) => hasWords(videoText, word) && !hasWords(wantedText, word)
  )

  const durationDiffSec =
    wanted.durationSec && video.durationSec
      ? Math.abs(wanted.durationSec - video.durationSec)
      : null
  const isTooLong =
    video.durationSec > LONG_VIDEO_SEC && !(wanted.durationSec > LONG_VIDEO_SEC)

  let score = 0.55 * titleScore + 0.25 * (artistMatch ? 1 : 0) + 0.2 * durationScoreFor(durationDiffSec)
  if (channelText.endsWith(' topic')) score += 0.1
  if (/\bofficial (music )?(audio|video)\b/.test(videoText)) score += 0.05
  score -= Math.min(0.5, 0.25 * variant.length)
  if (isTooLong) score -= 0.3
  score = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100

  return {
    score,
    label: labelFor(score),
    titleScore: Math.round(titleScore * 100) / 100,
    artistMatch,
    durationDiffSec,
    variant,
    isTooLong
  }
}

// Safe to download without asking: the title's words are there, it isn't
// another version, and its length (when the CSV has one) is about right.
// The artist only ranks results: label uploads often name the singers,
// not the composer a playlist lists.
function isConfidentMatch (scored) {
  return (
    scored.titleScore >= MIN_CONFIDENT_TITLE_SCORE &&
    scored.variant.length === 0 &&
    !scored.isTooLong &&
    (scored.durationDiffSec == null || scored.durationDiffSec <= MAX_DURATION_DIFF_SEC)
  )
}

// Score every video (each once) and put the best first.
function rankCandidates (videos, wanted) {
  const seen = new Set()
  return videos
    .map(normalizeVideo)
    .filter((video) => {
      if (!video.videoId || seen.has(video.videoId)) return false
      seen.add(video.videoId)
      return true
    })
    .map((video) => ({ ...video, ...scoreCandidate(video, wanted) }))
    .sort((a, b) => b.score - a.score)
}

// "3:45", "1:02:03", "225" (seconds) or "225000" (milliseconds) -> seconds
function parseDurationSec (raw, { fromMs = false } = {}) {
  const text = String(raw ?? '').trim()
  if (!text) return null

  if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
    return text.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  }

  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) return null
  if (fromMs || n > MAX_SECONDS_AS_NUMBER) return Math.round(n / 1000)
  return Math.round(n)
}

// The searches behind "Search wider": the CSV's own wording first, then the
// title without "(From …)" / "feat." with just the main artist, then audio
// and lyrics uploads, the album, and the bare title.
function buildSearchQueries ({ title, artist, album }) {
  const cleanTitle = String(title)
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s+(feat|ft)\.?\s.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const mainArtist = String(artist || '').split(/[,;&/]|\s+(?:feat|ft)\.?\s+/i)[0].trim()

  const queries = [
    `${title} ${artist || ''}`,
    `${cleanTitle} ${mainArtist}`,
    `${cleanTitle} ${mainArtist} official audio`,
    `${cleanTitle} ${mainArtist} lyrics`,
    album ? `${cleanTitle} ${album}` : '',
    cleanTitle
  ]

  const seen = new Set()
  return queries
    .map((query) => query.replace(/\s+/g, ' ').trim())
    .filter((query) => {
      const key = query.toLowerCase()
      if (!query || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

module.exports = {
  looseText,
  splitArtists,
  normalizeVideo,
  scoreCandidate,
  isConfidentMatch,
  rankCandidates,
  parseDurationSec,
  buildSearchQueries
}
