// Reading what the organizer sorts, renames and finds duplicates by from an
// MP3: its ID3 tags, whether a cover picture is embedded, and its length.
// id3-reader.js reads only title, artist and TLEN for song-library.js; this
// reader goes further for organizer/scan.js, and leaves that one untouched.
//
// API (used by organizer/scan.js):
//
//   readSongTags(filePath, { maxTagBytes = 256 KB } = {})
//     -> Promise<{ title, artist, album, year, genre, track, durationSec, hasCover }>
//     title, artist, album, genre  text, '' when missing; several ID3v2.4
//                                  values come back as "A, B" (genre: the
//                                  first), ID3v1 genre numbers as names
//     year         four digits ("2013" from TYER, or TDRC "2013-05-01"), or ''
//     track        a whole number from 1 ("7/12" gives 7), or null
//     durationSec  whole seconds, or null: TLEN, else the frame count a VBR
//                  file's first frame holds (Xing / Info / VBRI), else worked
//                  out from the bitrate and the size of the audio
//     hasCover     an APIC (ID3v2.2: PIC) frame is there
//   Reads ID3v2.2, 2.3 and 2.4 tags from the first maxTagBytes of the file;
//   an ID3v1 tag (the last 128 bytes) fills in title, artist or album when
//   ID3v2 lacks one. A cover too big for maxTagBytes still counts, as long as
//   its frame starts within it. Rejects when the file can't be opened or read.
//
//   parseId3v2(bytes) -> { tags, tagEnd } | null    (bytes: the file's start)
//   parseId3v1(bytes) -> tags | null                (bytes: its last 128)
//   estimateDurationSec(audioBytes, audioLength) -> seconds | null
//     audioBytes: the start of the audio; audioLength: all of its bytes

const fs = require('fs')
const { parseDurationSec } = require('../matching')

// Enough for the text frames and the header of a cover (ffmpeg writes the
// cover last); reading all of a large cover would only slow a scan down
const MAX_TAG_BYTES = 256 * 1024
// how much audio to search for the first MPEG frame (past junk or padding)
const AUDIO_PROBE_BYTES = 16 * 1024
const HEADER_BYTES = 10
const FOOTER_BYTES = 10
const ID3V1_BYTES = 128
// longer than a day is a misread header, not a song
const MAX_DURATION_SEC = 24 * 60 * 60
const MIN_YEAR = 1000
const MAX_YEAR = 2999

// tag header flags
const TAG_UNSYNC = 0x80
const TAG_EXTENDED_HEADER = 0x40 // v2.3 and v2.4
const V22_COMPRESSED = 0x40 // v2.2 had no extended header; this bit meant a never-defined compression
const V24_FOOTER = 0x10

// frame format flags (a frame header's second flag byte)
const V23_COMPRESSED = 0x80
const V23_ENCRYPTED = 0x40
const V23_GROUPED = 0x20
const V24_GROUPED = 0x40
const V24_COMPRESSED = 0x08
const V24_ENCRYPTED = 0x04
const V24_UNSYNC = 0x02
const V24_DATA_LENGTH = 0x01
const MIN_V24_EXTENDED_HEADER = 6

// text encodings (a text frame's first byte)
const LATIN1 = 0
const UTF16_WITH_BOM = 1
const UTF16BE = 2
const UTF8 = 3

// v2.2 frames have 3-letter names and 3-byte sizes, without flags
const FRAME_LAYOUTS = {
  2: { idLength: 3, headerLength: 6, id: /^[A-Z0-9]{3}$/ },
  3: { idLength: 4, headerLength: 10, id: /^[A-Z0-9]{4}$/ },
  4: { idLength: 4, headerLength: 10, id: /^[A-Z0-9]{4}$/ }
}

// frame name (v2.3 / v2.4, and v2.2) -> what it holds. The recording year
// (TDRC, TYER) is preferred to the original release year (TDOR, TORY).
const TEXT_FRAMES = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TALB: 'album',
  TAL: 'album',
  TCON: 'genre',
  TCO: 'genre',
  TRCK: 'track',
  TRK: 'track',
  TLEN: 'length',
  TLE: 'length',
  TDRC: 'year',
  TYER: 'year',
  TYE: 'year',
  TDOR: 'originalYear',
  TORY: 'originalYear',
  TOR: 'originalYear'
}
const COVER_FRAMES = new Set(['APIC', 'PIC'])

const NO_TAGS = {
  title: '',
  artist: '',
  album: '',
  year: '',
  genre: '',
  track: null,
  lengthSec: null,
  hasCover: false
}

// Genre numbers from ID3v1 (0-79) and Winamp (80-191). TCON may still say
// "(17)" or "17" for Rock. Number 133 is left out on purpose.
const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore Techno',
  'Terror', 'Indie', 'BritPop', '', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'J-Pop', 'Synthpop', 'Abstract', 'Art Rock',
  'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro',
  'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band', 'Krautrock',
  'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk', 'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock',
  'Trop Rock', 'World Music', 'Neoclassical', 'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock', 'G-Funk', 'Dubstep',
  'Garage Rock', 'Psybient'
]
// "(17)", "(13)(17)", "(4)Eurodisco", "(RX)": references, then maybe words
const GENRE_REFERENCES = /^((?:\((?:\d{1,3}|RX|CR)\))+)(.*)$/is

// ---------- MPEG audio frames ----------

// kbps by bitrate index: MPEG-1 and MPEG-2 / 2.5, each by layer
const BITRATES_KBPS = {
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  }
}
// Hz by sample rate index, by the header's version bits (3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5)
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
const FRAME_HEADER_BYTES = 4
const VERSION_RESERVED = 1
const BITRATE_FREE = 0
const BITRATE_BAD = 15
const SAMPLE_RATE_RESERVED = 3
const CHANNELS_MONO = 3
// a VBR header sits after the frame header and the side information
const SIDE_INFO_BYTES = { mpeg1: { stereo: 32, mono: 17 }, mpeg2: { stereo: 17, mono: 9 } }
const VBRI_OFFSET = 32
const XING_HAS_FRAME_COUNT = 0x0001

// ---------- reading a file ----------

async function readSongTags (filePath, { maxTagBytes = MAX_TAG_BYTES } = {}) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const head = await readAt(handle, 0, Math.min(size, maxTagBytes))
    const v2 = parseId3v2(head)
    const v2Tags = v2 ? v2.tags : NO_TAGS
    const audioStart = Math.min(v2 ? v2.tagEnd : 0, size)

    // ffmpeg writes both tags from the same data, so ID3v1 is only worth a
    // read when ID3v2 left something out (or there is none)
    const needsV1 = !(v2Tags.title && v2Tags.artist && v2Tags.album)
    const hasRoomForV1 = size - audioStart >= ID3V1_BYTES
    const v1 = needsV1 && hasRoomForV1 ? parseId3v1(await readAt(handle, size - ID3V1_BYTES, ID3V1_BYTES)) : null

    const durationSec =
      v2Tags.lengthSec ?? (await estimateFromFile(handle, head, audioStart, v1 ? size - ID3V1_BYTES : size))
    return combineTags(v2Tags, v1, durationSec)
  } finally {
    await handle.close()
  }
}

async function readAt (handle, position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

// The length from the audio itself. Its start is usually within what was
// already read; after a large cover it takes one more small read.
async function estimateFromFile (handle, head, audioStart, audioEnd) {
  const length = Math.max(0, Math.min(AUDIO_PROBE_BYTES, audioEnd - audioStart))
  const audio =
    audioStart + length <= head.length
      ? head.subarray(audioStart, audioStart + length)
      : await readAt(handle, audioStart, length)
  return estimateDurationSec(audio, audioEnd - audioStart)
}

function combineTags (v2, v1, durationSec) {
  const pick = (field) => v2[field] || v1?.[field] || ''
  return {
    title: pick('title'),
    artist: pick('artist'),
    album: pick('album'),
    year: pick('year'),
    genre: pick('genre'),
    track: v2.track ?? v1?.track ?? null,
    durationSec: durationSec ?? null,
    hasCover: v2.hasCover
  }
}

// ---------- ID3v2 ----------

// bytes from the start of a file -> { tags, tagEnd } | null. tagEnd is
// where the audio starts, even when the tag itself can't be read.
function parseId3v2 (bytes) {
  const header = parseHeader(bytes)
  if (!header) return null

  const hasFooter = header.version === 4 && hasFlag(header.flags, V24_FOOTER)
  const tagEnd = HEADER_BYTES + header.size + (hasFooter ? FOOTER_BYTES : 0)
  const area = framesArea(bytes, header)
  if (!area) return { tags: NO_TAGS, tagEnd }

  const isCutShort = bytes.length < HEADER_BYTES + header.size
  return { tags: tagsFromFrames(framesIn(area, header.version, isCutShort), header), tagEnd }
}

// "ID3", version, revision, flags, then the tag's size after the header
function parseHeader (bytes) {
  if (bytes.length < HEADER_BYTES || bytes.toString('latin1', 0, 3) !== 'ID3') return null
  const version = bytes[3]
  if (!FRAME_LAYOUTS[version]) return null
  const size = readSyncsafe(bytes, 6)
  return size === null ? null : { version, flags: bytes[5], size }
}

// ID3 sizes use 7 bits a byte so they never look like the start of audio
function readSyncsafe (bytes, offset) {
  const four = bytes.subarray(offset, offset + 4)
  if (four.length < 4 || four.some((byte) => byte > 0x7f)) return null
  return four.reduce((total, byte) => total * 128 + byte, 0)
}

// The frames: the tag after its header and any extended header, with the
// whole-tag unsynchronisation of v2.2 / v2.3 undone. null when unreadable.
function framesArea (bytes, header) {
  if (header.version === 2 && hasFlag(header.flags, V22_COMPRESSED)) return null
  const stored = bytes.subarray(HEADER_BYTES, HEADER_BYTES + header.size)
  const isWholeTagUnsynced = header.version < 4 && hasFlag(header.flags, TAG_UNSYNC)
  const body = isWholeTagUnsynced ? removeUnsync(stored) : stored
  if (header.version === 2 || !hasFlag(header.flags, TAG_EXTENDED_HEADER)) return body

  const skip = extendedHeaderLength(body, header.version)
  return skip === null || skip > body.length ? null : body.subarray(skip)
}

// v2.3 gives the extended header's size without its own 4 size bytes; v2.4
// includes them, syncsafe
function extendedHeaderLength (body, version) {
  if (body.length < 4) return null
  if (version === 3) return 4 + body.readUInt32BE(0)
  const size = readSyncsafe(body, 0)
  return size !== null && size >= MIN_V24_EXTENDED_HEADER ? size : null
}

// Each frame as { id, formatFlags, data }. When the read stopped inside the
// tag (a big cover), the frame running past it comes as { id, isCut: true }:
// enough to know a cover is there. Stops at padding, junk or a broken size.
function * framesIn (area, version, isCutShort) {
  const layout = FRAME_LAYOUTS[version]
  let offset = 0
  while (offset + layout.headerLength <= area.length) {
    const id = area.toString('latin1', offset, offset + layout.idLength)
    if (!layout.id.test(id)) return

    const size = frameSize(area, offset + layout.idLength, version)
    const start = offset + layout.headerLength
    if (size === null) return
    if (start + size > area.length) {
      if (isCutShort) yield { id, isCut: true }
      return
    }

    yield { id, formatFlags: version === 2 ? 0 : area[offset + 9], data: area.subarray(start, start + size) }
    offset = start + size
  }
}

function frameSize (area, offset, version) {
  if (version === 2) return area.readUIntBE(offset, 3)
  if (version === 3) return area.readUInt32BE(offset)
  return readSyncsafe(area, offset)
}

// The first readable frame of each kind, as text values, then the tags
function tagsFromFrames (frames, header) {
  let values = {}
  let hasCover = false
  for (const frame of frames) {
    if (COVER_FRAMES.has(frame.id)) hasCover = hasCover || frame.isCut === true || frame.data.length > 0
    const field = TEXT_FRAMES[frame.id]
    if (!field || frame.isCut || field in values) continue
    const content = frameContent(frame, header)
    const texts = content ? decodeTextFrame(content) : []
    if (texts.length) values = { ...values, [field]: texts }
  }

  const first = (field) => values[field]?.[0] ?? ''
  return {
    title: (values.title ?? []).join(', '),
    artist: (values.artist ?? []).join(', '),
    album: (values.album ?? []).join(', '),
    year: yearFrom(first('year')) || yearFrom(first('originalYear')),
    genre: genreName(first('genre')),
    track: trackFrom(first('track')),
    lengthSec: parseDurationSec(first('length'), { fromMs: true }) || null,
    hasCover
  }
}

// A frame's content without what its flags put in front of it. null for a
// compressed or encrypted frame: rare, and not worth undoing for a tag.
function frameContent ({ formatFlags, data }, header) {
  if (header.version === 2) return data
  if (header.version === 3) {
    if (hasFlag(formatFlags, V23_COMPRESSED | V23_ENCRYPTED)) return null
    return hasFlag(formatFlags, V23_GROUPED) ? data.subarray(1) : data
  }

  if (hasFlag(formatFlags, V24_COMPRESSED | V24_ENCRYPTED)) return null
  const groupBytes = hasFlag(formatFlags, V24_GROUPED) ? 1 : 0
  const lengthBytes = hasFlag(formatFlags, V24_DATA_LENGTH) ? 4 : 0
  const content = data.subarray(groupBytes + lengthBytes)
  const isUnsynced = hasFlag(formatFlags, V24_UNSYNC) || hasFlag(header.flags, TAG_UNSYNC)
  return isUnsynced ? removeUnsync(content) : content
}

// A text frame: an encoding byte, then text. v2.4 separates values with NULs.
// trim() also drops a UTF-16 byte order mark (U+FEFF counts as whitespace).
function decodeTextFrame (content) {
  if (content.length === 0) return []
  return decodeText(content.subarray(1), content[0])
    .split('\u0000')
    .map((value) => value.trim())
    .filter(Boolean)
}

function decodeText (bytes, encoding) {
  if (encoding === LATIN1) return bytes.toString('latin1')
  if (encoding === UTF16_WITH_BOM) return decodeUtf16WithBom(bytes)
  if (encoding === UTF16BE) return decodeUtf16be(bytes)
  if (encoding === UTF8) return bytes.toString('utf8')
  return ''
}

// Without a byte order mark, UTF-16 is almost always little-endian (Windows)
function decodeUtf16WithBom (bytes) {
  const isBigEndian = bytes[0] === 0xfe && bytes[1] === 0xff
  return isBigEndian ? decodeUtf16be(bytes) : evenLength(bytes).toString('utf16le')
}

// Node has no UTF-16BE decoder: swap each byte pair of a copy
function decodeUtf16be (bytes) {
  return Buffer.from(evenLength(bytes)).swap16().toString('utf16le')
}

function evenLength (bytes) {
  return bytes.subarray(0, bytes.length - (bytes.length % 2))
}

// Undo "unsynchronisation": a 0x00 a writer put after each 0xFF
function removeUnsync (bytes) {
  const out = Buffer.alloc(bytes.length)
  let length = 0
  for (let i = 0; i < bytes.length; i++) {
    out[length++] = bytes[i]
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++
  }
  return out.subarray(0, length)
}

function hasFlag (flags, flag) {
  return (flags & flag) !== 0
}

// ---------- tag values ----------

// "2013", "2013-05-01", "c. 1999" -> the year; anything else -> ''
function yearFrom (text) {
  const match = /(?:^|\D)(\d{4})(?!\d)/.exec(String(text))
  const year = match ? Number(match[1]) : 0
  return year >= MIN_YEAR && year <= MAX_YEAR ? match[1] : ''
}

// "7/12" -> 7; "0" or no number -> null
function trackFrom (text) {
  const match = /^\s*(\d{1,5})/.exec(String(text))
  const track = match ? Number(match[1]) : 0
  return track >= 1 ? track : null
}

function genreName (raw) {
  const text = String(raw).trim()
  const references = GENRE_REFERENCES.exec(text)
  if (references) {
    const words = references[2].trim()
    return words ? unescapeGenre(words) : genreForReference(references[1].match(/\d{1,3}|RX|CR/i)[0])
  }
  return /^\d{1,3}$/.test(text) ? genreForReference(text) : unescapeGenre(text)
}

// a genre that really starts with "(" is written "(("
function unescapeGenre (text) {
  return text.startsWith('((') ? text.slice(1) : text
}

function genreForReference (reference) {
  const upper = reference.toUpperCase()
  if (upper === 'RX') return 'Remix'
  if (upper === 'CR') return 'Cover'
  return ID3V1_GENRES[Number(reference)] ?? ''
}

// ---------- ID3v1 ----------

// "TAG", then fixed-width latin1 fields; ID3v1.1 ends the comment with a
// zero byte and the track number
function parseId3v1 (bytes) {
  if (bytes.length !== ID3V1_BYTES || bytes.toString('latin1', 0, 3) !== 'TAG') return null
  const field = (start, length) => bytes.toString('latin1', start, start + length).split('\u0000')[0].trim()
  const hasTrack = bytes[125] === 0 && bytes[126] !== 0
  return {
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: yearFrom(field(93, 4)),
    genre: genreForReference(String(bytes[127])),
    track: hasTrack ? bytes[126] : null
  }
}

// ---------- the length from the audio ----------

function estimateDurationSec (audioBytes, audioLength) {
  const first = findFirstFrame(audioBytes)
  if (!first) return null
  const frameCount = vbrFrameCount(audioBytes, first)
  const seconds = frameCount
    ? (frameCount * first.samplesPerFrame) / first.sampleRate
    : ((audioLength - first.offset) * 8) / first.bitrate
  const rounded = Math.round(seconds)
  return Number.isFinite(rounded) && rounded >= 1 && rounded <= MAX_DURATION_SEC ? rounded : null
}

function findFirstFrame (bytes) {
  for (let offset = 0; offset + FRAME_HEADER_BYTES <= bytes.length; offset++) {
    const frame = parseFrameHeader(bytes, offset)
    if (frame && isFollowedByFrame(bytes, frame)) return frame
  }
  return null
}

// A real frame is followed by another of its kind; four bytes that merely
// look like a header almost never are. At the end of what was read there is
// nothing to compare with, so the frame is taken as it is.
function isFollowedByFrame (bytes, frame) {
  const next = frame.offset + frame.frameLength
  if (next + FRAME_HEADER_BYTES > bytes.length) return true
  const following = parseFrameHeader(bytes, next)
  return (
    following !== null &&
    following.versionBits === frame.versionBits &&
    following.layer === frame.layer &&
    following.sampleRate === frame.sampleRate
  )
}

// 11 sync bits, version, layer, then bitrate, sample rate, padding, channels
function parseFrameHeader (bytes, offset) {
  if (offset + FRAME_HEADER_BYTES > bytes.length) return null
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null
  const versionBits = (bytes[offset + 1] >> 3) & 0x03
  const layerBits = (bytes[offset + 1] >> 1) & 0x03
  const bitrateIndex = bytes[offset + 2] >> 4
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03
  const isValid =
    versionBits !== VERSION_RESERVED &&
    layerBits !== 0 &&
    bitrateIndex !== BITRATE_FREE &&
    bitrateIndex !== BITRATE_BAD &&
    sampleRateIndex !== SAMPLE_RATE_RESERVED
  if (!isValid) return null

  const isMpeg1 = versionBits === 3
  const layer = 4 - layerBits
  const bitrate = BITRATES_KBPS[isMpeg1 ? 1 : 2][layer][bitrateIndex] * 1000
  const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex]
  const padding = (bytes[offset + 2] >> 1) & 0x01
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && !isMpeg1 ? 576 : 1152
  const frameLength =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding
  const isMono = bytes[offset + 3] >> 6 === CHANNELS_MONO
  return { offset, versionBits, layer, isMpeg1, isMono, bitrate, sampleRate, samplesPerFrame, frameLength }
}

// The frame count a VBR file's first frame holds (Xing / Info from LAME, or
// VBRI from Fraunhofer encoders), or null
function vbrFrameCount (bytes, frame) {
  const sideInfo = SIDE_INFO_BYTES[frame.isMpeg1 ? 'mpeg1' : 'mpeg2'][frame.isMono ? 'mono' : 'stereo']
  const xing = frame.offset + FRAME_HEADER_BYTES + sideInfo
  const xingId = bytes.toString('latin1', xing, xing + 4)
  if ((xingId === 'Xing' || xingId === 'Info') && xing + 12 <= bytes.length) {
    return hasFlag(bytes.readUInt32BE(xing + 4), XING_HAS_FRAME_COUNT) ? bytes.readUInt32BE(xing + 8) : null
  }

  const vbri = frame.offset + FRAME_HEADER_BYTES + VBRI_OFFSET
  const isVbri = bytes.toString('latin1', vbri, vbri + 4) === 'VBRI' && vbri + 18 <= bytes.length
  return isVbri ? bytes.readUInt32BE(vbri + 14) : null
}

module.exports = { readSongTags, parseId3v2, parseId3v1, estimateDurationSec }
