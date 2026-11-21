// Reading a song's title, artist and length from the ID3v2 tag at the start
// of an MP3, so a song already saved on the drive can be recognised without
// trusting its file name. Used by song-library.js, which re-exports it.
//
// readId3Tags(filePath, { log = console.log } = {})
//   -> Promise<{ title, artist, durationSec } | null>
//   Reads only the start of the file (128 KB at most). Understands ID3v2.3
//   (what the app's ffmpeg writes: -id3v2_version 3) and ID3v2.4 tags, with
//   text in latin1, UTF-16 with a byte order mark, UTF-16BE or UTF-8.
//     title        TIT2, never empty
//     artist       TPE1, '' when the tag has none; several v2.4 values are
//                  joined as "A, B"
//     durationSec  TLEN (milliseconds) in whole seconds, or null
//   Resolves null when there's nothing to match on: no ID3v2.3/2.4 tag, a
//   broken tag, or no title within the first 128 KB; also when the file
//   can't be read (that one is logged). Never rejects.

const fs = require('fs')
const { parseDurationSec } = require('./matching')

// ffmpeg puts the text frames before the cover picture, so the title and
// artist come early; reading on through a big cover would only slow down
// scanning a drive full of songs
const MAX_TAG_BYTES = 128 * 1024
const HEADER_BYTES = 10
const FRAME_HEADER_BYTES = 10

// tag header flags
const TAG_UNSYNC = 0x80
const TAG_EXTENDED_HEADER = 0x40

// frame format flags (a frame header's second flag byte)
const V23_COMPRESSED = 0x80
const V23_ENCRYPTED = 0x40
const V23_GROUPED = 0x20 // a group id byte comes before the content
const V24_GROUPED = 0x40 // a group id byte comes before the content
const V24_COMPRESSED = 0x08
const V24_ENCRYPTED = 0x04
const V24_UNSYNC = 0x02
const V24_DATA_LENGTH = 0x01 // a 4-byte length comes before the content

// the smallest v2.4 extended header: its 4 size bytes and 2 flag bytes
const MIN_V24_EXTENDED_HEADER = 6

// frame names are four capital letters or digits; anything else (padding
// zeros, junk) means there are no more frames
const FRAME_ID = /^[A-Z0-9]{4}$/
const WANTED_FRAMES = new Set(['TIT2', 'TPE1', 'TLEN'])

// text encodings (a text frame's first byte)
const LATIN1 = 0
const UTF16_WITH_BOM = 1
const UTF16BE = 2
const UTF8 = 3

async function readId3Tags (filePath, { log = console.log } = {}) {
  try {
    return parseId3Tag(await readTagBytes(filePath))
  } catch (err) {
    log(`Could not read the tags of ${filePath}:`, err.message)
    return null
  }
}

// The start of the file: the 10-byte header, then as much of the tag as the
// header says it holds, MAX_TAG_BYTES in all at most
async function readTagBytes (filePath) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const head = await readAt(handle, 0, HEADER_BYTES)
    const header = parseHeader(head)
    if (!header) return head

    const restLength = Math.min(header.size, MAX_TAG_BYTES - HEADER_BYTES)
    return Buffer.concat([head, await readAt(handle, HEADER_BYTES, restLength)])
  } finally {
    await handle.close()
  }
}

async function readAt (handle, position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

// bytes from the start of a file -> { title, artist, durationSec } | null
function parseId3Tag (bytes) {
  const header = parseHeader(bytes)
  const frames = header && framesArea(bytes, header)
  if (!frames) return null

  const texts = readWantedFrames(frames, header)
  if (!texts.TIT2) return null
  return {
    title: texts.TIT2,
    artist: texts.TPE1 || '',
    durationSec: parseDurationSec(texts.TLEN, { fromMs: true }) || null
  }
}

// "ID3", version, revision, flags, then the size of everything after the
// header. Only v2.3 and v2.4 are read: v2.2 (three-letter frame names) is
// long obsolete and there is no later version.
function parseHeader (bytes) {
  if (bytes.length < HEADER_BYTES || bytes.toString('latin1', 0, 3) !== 'ID3') return null
  const version = bytes[3]
  if (version !== 3 && version !== 4) return null
  const size = readSyncsafe(bytes, 6)
  return size === null ? null : { version, flags: bytes[5], size }
}

// ID3 sizes use 7 bits per byte so they can never look like the start of
// audio; a byte with its top bit set means it isn't a valid size
function readSyncsafe (bytes, offset) {
  const four = bytes.subarray(offset, offset + 4)
  if (four.length < 4 || four.some((byte) => byte > 0x7f)) return null
  return four.reduce((total, byte) => total * 128 + byte, 0)
}

// The frames: the tag after its header and any extended header, with v2.3's
// whole-tag unsynchronisation undone. null when the extended header is broken.
function framesArea (bytes, header) {
  const stored = bytes.subarray(HEADER_BYTES, HEADER_BYTES + header.size)
  const isWholeTagUnsynced = header.version === 3 && hasFlag(header.flags, TAG_UNSYNC)
  const body = isWholeTagUnsynced ? removeUnsync(stored) : stored
  if (!hasFlag(header.flags, TAG_EXTENDED_HEADER)) return body

  const skip = extendedHeaderLength(body, header.version)
  return skip === null || skip > body.length ? null : body.subarray(skip)
}

// v2.3 gives the extended header's size without its own 4 size bytes; v2.4
// includes them, and writes the size syncsafe
function extendedHeaderLength (body, version) {
  if (body.length < 4) return null
  if (version === 3) return 4 + body.readUInt32BE(0)
  const size = readSyncsafe(body, 0)
  return size !== null && size >= MIN_V24_EXTENDED_HEADER ? size : null
}

// Each frame as { id, formatFlags, data }. v2.4 frame sizes are syncsafe,
// v2.3 ones plain 32-bit numbers. Stops at the padding, at junk, or at a
// frame cut off by the end of what was read.
function * framesIn (area, version) {
  let offset = 0
  while (offset + FRAME_HEADER_BYTES <= area.length) {
    const id = area.toString('latin1', offset, offset + 4)
    if (!FRAME_ID.test(id)) return

    const size = version === 4 ? readSyncsafe(area, offset + 4) : area.readUInt32BE(offset + 4)
    const start = offset + FRAME_HEADER_BYTES
    if (size === null || start + size > area.length) return

    yield { id, formatFlags: area[offset + 9], data: area.subarray(start, start + size) }
    offset = start + size
  }
}

// The text of the first readable title, artist and length frames, by name
function readWantedFrames (area, header) {
  let texts = {}
  for (const frame of framesIn(area, header.version)) {
    if (!WANTED_FRAMES.has(frame.id) || frame.id in texts) continue
    const content = frameContent(frame, header)
    if (content) texts = { ...texts, [frame.id]: decodeTextFrame(content) }
  }
  return texts
}

// A frame's content without the extra bytes its flags put in front of it.
// null for a compressed or encrypted frame: rare, and not worth inflating or
// decrypting just to read a title.
function frameContent ({ formatFlags, data }, header) {
  if (header.version === 3) {
    if (hasFlag(formatFlags, V23_COMPRESSED | V23_ENCRYPTED)) return null
    return hasFlag(formatFlags, V23_GROUPED) ? data.subarray(1) : data
  }

  if (hasFlag(formatFlags, V24_COMPRESSED | V24_ENCRYPTED)) return null
  const groupBytes = hasFlag(formatFlags, V24_GROUPED) ? 1 : 0
  const lengthBytes = hasFlag(formatFlags, V24_DATA_LENGTH) ? 4 : 0
  const content = data.subarray(groupBytes + lengthBytes)
  // v2.4 unsynchronises frame by frame; the header flag means "all of them"
  const isUnsynced = hasFlag(formatFlags, V24_UNSYNC) || hasFlag(header.flags, TAG_UNSYNC)
  return isUnsynced ? removeUnsync(content) : content
}

// A text frame: one encoding byte, then the text. v2.4 separates several
// values with NULs ("Pritam\0Arijit Singh"); they come back as "A, B".
// trim() also drops the byte order mark a UTF-16 value starts with (it
// decodes to U+FEFF, which JavaScript counts as whitespace).
function decodeTextFrame (content) {
  if (content.length === 0) return ''
  return decodeText(content.subarray(1), content[0])
    .split('\u0000')
    .map((value) => value.trim())
    .filter(Boolean)
    .join(', ')
}

function decodeText (bytes, encoding) {
  if (encoding === LATIN1) return bytes.toString('latin1')
  if (encoding === UTF16_WITH_BOM) return decodeUtf16WithBom(bytes)
  if (encoding === UTF16BE) return decodeUtf16be(bytes)
  if (encoding === UTF8) return bytes.toString('utf8')
  return '' // no such encoding: the frame can't be read
}

// The byte order mark (FE FF or FF FE) says which way round the bytes are;
// it decodes along with the text and is trimmed off afterwards. Writers that
// leave it out are almost always little-endian (Windows).
function decodeUtf16WithBom (bytes) {
  const isBigEndian = bytes[0] === 0xfe && bytes[1] === 0xff
  return isBigEndian ? decodeUtf16be(bytes) : evenLength(bytes).toString('utf16le')
}

// Node has no UTF-16BE decoder: swap each byte pair (in a copy) and read
// the result as little-endian
function decodeUtf16be (bytes) {
  return Buffer.from(evenLength(bytes)).swap16().toString('utf16le')
}

// a stray last byte from a broken writer would make swap16 throw
function evenLength (bytes) {
  return bytes.subarray(0, bytes.length - (bytes.length % 2))
}

// Undo "unsynchronisation": a writer may put a 0x00 after each 0xFF so no
// tag bytes look like the start of audio to old players
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

module.exports = { readId3Tags }
