// song-library.js lets a playlist reuse a song already saved in another
// playlist folder on the drive instead of downloading it again. These tests
// write small MP3-ish files with hand-made ID3v2.3 / v2.4 tags into a temp
// folder; nothing touches a real drive or the network.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  readId3Tags,
  buildLibraryIndex,
  findInLibrary,
  copyIntoPlaylist
} = require('../song-library')

// ---------- hand-made ID3v2 tags ----------

// text encodings (a text frame's first byte)
const LATIN1 = 0
const UTF16_WITH_BOM = 1
const UTF16BE = 2
const UTF8 = 3

// tag header flags, and frame format flags (a frame header's second flag byte)
const TAG_UNSYNC = 0x80
const TAG_EXTENDED_HEADER = 0x40
const V23_COMPRESSED = 0x80
const V23_GROUPED = 0x20
const V24_GROUPED = 0x40
const V24_UNSYNC = 0x02
const V24_DATA_LENGTH = 0x01

// 7 bits per byte: the tag size in both versions, and v2.4 frame sizes
function syncsafe (n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

// a plain 32-bit number: v2.3 frame sizes
function uint32 (n) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(n)
  return bytes
}

// "unsynchronised" bytes: a 0x00 after every 0xFF (readers drop it again)
function unsync (bytes) {
  return Buffer.from([...bytes].flatMap((byte) => (byte === 0xff ? [0xff, 0x00] : [byte])))
}

function encodeText (text, encoding) {
  if (encoding === UTF16_WITH_BOM) {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }
  if (encoding === UTF16BE) return Buffer.from(text, 'utf16le').swap16()
  if (encoding === UTF8) return Buffer.from(text, 'utf8')
  return Buffer.from(text, 'latin1')
}

// a text frame's content: the encoding byte, then the text
function textContent (text, encoding = LATIN1) {
  return Buffer.concat([Buffer.from([encoding]), encodeText(text, encoding)])
}

function frame (version, id, content, formatFlags = 0) {
  const size = version === 4 ? syncsafe(content.length) : uint32(content.length)
  return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, formatFlags]), content])
}

function textFrame (version, id, text, encoding = LATIN1) {
  return frame(version, id, textContent(text, encoding))
}

// A frame the reader has to step over. At 200 bytes its size is 00 00 01 48
// as syncsafe but 00 00 00 C8 as a plain number, so a reader that mixes the
// two up loses every frame after it.
function otherFrame (version) {
  return frame(version, 'PRIV', Buffer.alloc(200, 0x61))
}

function id3Tag (version, frames, { flags = 0, extendedHeader = Buffer.alloc(0) } = {}) {
  const padding = Buffer.alloc(32)
  const plain = Buffer.concat([extendedHeader, ...frames, padding])
  // v2.3 unsynchronises the whole tag; v2.4 does it frame by frame
  const body = version === 3 && flags & TAG_UNSYNC ? unsync(plain) : plain
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([version, 0, flags]),
    syncsafe(body.length),
    body
  ])
}

// what follows the tag in a real file: an MPEG audio frame header, then audio
const FAKE_AUDIO = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)])

// a song's tag: some other frame first, then the song's own frames
function songTag (version, { title, artist, lengthMs, encoding = LATIN1 }) {
  const frames = [
    otherFrame(version),
    title != null && textFrame(version, 'TIT2', title, encoding),
    artist != null && textFrame(version, 'TPE1', artist, encoding),
    lengthMs != null && textFrame(version, 'TLEN', String(lengthMs))
  ]
  return id3Tag(version, frames.filter(Boolean))
}

// ---------- temp files ----------

function makeTempFolder (t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'song-library-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return folder
}

function writeFile (filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, bytes)
  return filePath
}

function writeTag (filePath, tag) {
  return writeFile(filePath, Buffer.concat([tag, FAKE_AUDIO]))
}

function writeSong (filePath, version, tags) {
  return writeTag(filePath, songTag(version, tags))
}

// a log function that keeps its lines for the test to look at
function captureLog () {
  const lines = []
  return { lines, log: (...parts) => lines.push(parts.join(' ')) }
}

// ---------- reading tags ----------

describe('readId3Tags', () => {
  test('reads title and artist from an ID3v2.3 tag as ffmpeg writes it (no length)', async (t) => {
    const file = writeSong(path.join(makeTempFolder(t), 'Kesariya.mp3'), 3, {
      title: 'Kesariya',
      artist: 'Pritam, Arijit Singh'
    })

    assert.deepEqual(await readId3Tags(file), {
      title: 'Kesariya',
      artist: 'Pritam, Arijit Singh',
      durationSec: null
    })
  })

  test('reads latin1 accents and UTF-16 text with a byte order mark (either byte order)', async (t) => {
    const folder = makeTempFolder(t)
    const latin1 = writeSong(path.join(folder, 'a.mp3'), 3, { title: 'Déjà Vu', artist: 'Beyoncé' })
    const littleEndian = writeSong(path.join(folder, 'b.mp3'), 3, {
      title: 'तुम ही हो',
      artist: 'Arijit Singh',
      encoding: UTF16_WITH_BOM
    })
    const bigEndianTitle = Buffer.concat([
      Buffer.from([UTF16_WITH_BOM, 0xfe, 0xff]),
      Buffer.from('तुम ही हो', 'utf16le').swap16()
    ])
    const bigEndian = writeTag(
      path.join(folder, 'c.mp3'),
      id3Tag(3, [frame(3, 'TIT2', bigEndianTitle), textFrame(3, 'TPE1', 'Arijit Singh')])
    )
    const hindi = { title: 'तुम ही हो', artist: 'Arijit Singh', durationSec: null }

    assert.deepEqual(await readId3Tags(latin1), { title: 'Déjà Vu', artist: 'Beyoncé', durationSec: null })
    assert.deepEqual(await readId3Tags(littleEndian), hindi)
    assert.deepEqual(await readId3Tags(bigEndian), hindi)
  })

  test('reads an ID3v2.4 tag: syncsafe frame sizes, UTF-8, UTF-16BE and the length in ms', async (t) => {
    const tag = id3Tag(4, [
      otherFrame(4),
      textFrame(4, 'TIT2', 'Déjà Vu', UTF8),
      textFrame(4, 'TPE1', 'Olivia Rodrigo', UTF16BE),
      textFrame(4, 'TLEN', '215000')
    ])
    const file = writeTag(path.join(makeTempFolder(t), 'v24.mp3'), tag)

    assert.deepEqual(await readId3Tags(file), {
      title: 'Déjà Vu',
      artist: 'Olivia Rodrigo',
      durationSec: 215
    })
  })

  test('several artists in one v2.4 frame come back as one list', async (t) => {
    const tag = id3Tag(4, [
      textFrame(4, 'TIT2', 'Kesariya', UTF8),
      textFrame(4, 'TPE1', 'Pritam\u0000Arijit Singh\u0000', UTF8)
    ])
    const file = writeTag(path.join(makeTempFolder(t), 'multi.mp3'), tag)

    assert.equal((await readId3Tags(file)).artist, 'Pritam, Arijit Singh')
  })

  test('unsynchronised tags are read (v2.3: the whole tag, v2.4: each frame)', async (t) => {
    const folder = makeTempFolder(t)
    // the UTF-16 byte order mark FF FE is stored as FF 00 FE
    const v23 = id3Tag(
      3,
      [
        textFrame(3, 'TIT2', 'Tum Hi Ho', UTF16_WITH_BOM),
        textFrame(3, 'TPE1', 'Arijit Singh', UTF16_WITH_BOM)
      ],
      { flags: TAG_UNSYNC }
    )
    const v24 = id3Tag(4, [
      frame(4, 'TIT2', unsync(textContent('Tum Hi Ho', UTF16_WITH_BOM)), V24_UNSYNC),
      frame(4, 'TPE1', unsync(textContent('Arijit Singh', UTF16_WITH_BOM)), V24_UNSYNC)
    ])
    const expected = { title: 'Tum Hi Ho', artist: 'Arijit Singh', durationSec: null }

    assert.deepEqual(await readId3Tags(writeTag(path.join(folder, 'v23.mp3'), v23)), expected)
    assert.deepEqual(await readId3Tags(writeTag(path.join(folder, 'v24.mp3'), v24)), expected)
  })

  test('an extended header is stepped over', async (t) => {
    const folder = makeTempFolder(t)
    const frames = (version) => [
      textFrame(version, 'TIT2', 'Kesariya'),
      textFrame(version, 'TPE1', 'Arijit Singh')
    ]
    // v2.3 counts the extended header without its 4 size bytes, v2.4 with them
    const v23 = id3Tag(3, frames(3), {
      flags: TAG_EXTENDED_HEADER,
      extendedHeader: Buffer.concat([uint32(6), Buffer.alloc(6)])
    })
    const v24 = id3Tag(4, frames(4), {
      flags: TAG_EXTENDED_HEADER,
      extendedHeader: Buffer.concat([syncsafe(6), Buffer.from([1, 0])])
    })

    assert.equal((await readId3Tags(writeTag(path.join(folder, 'v23.mp3'), v23))).title, 'Kesariya')
    assert.equal((await readId3Tags(writeTag(path.join(folder, 'v24.mp3'), v24))).title, 'Kesariya')
  })

  test('group ids and a v2.4 data length are stepped over; compressed frames are not misread', async (t) => {
    const folder = makeTempFolder(t)
    const title = textContent('Kesariya')
    const artist = textContent('Arijit Singh')
    const groupId = Buffer.from([0x80])
    const grouped = id3Tag(4, [
      // group id first, then the data length, then the text
      frame(4, 'TIT2', Buffer.concat([groupId, syncsafe(title.length), title]), V24_GROUPED | V24_DATA_LENGTH),
      frame(4, 'TPE1', Buffer.concat([groupId, artist]), V24_GROUPED)
    ])
    const groupedV23 = id3Tag(3, [
      textFrame(3, 'TIT2', 'Kesariya'),
      frame(3, 'TPE1', Buffer.concat([groupId, artist]), V23_GROUPED)
    ])
    const compressed = id3Tag(3, [
      frame(3, 'TIT2', Buffer.concat([uint32(50), Buffer.from('not text')]), V23_COMPRESSED),
      textFrame(3, 'TPE1', 'Arijit Singh')
    ])
    const expected = { title: 'Kesariya', artist: 'Arijit Singh', durationSec: null }

    assert.deepEqual(await readId3Tags(writeTag(path.join(folder, 'g24.mp3'), grouped)), expected)
    assert.deepEqual(await readId3Tags(writeTag(path.join(folder, 'g23.mp3'), groupedV23)), expected)
    assert.equal(await readId3Tags(writeTag(path.join(folder, 'zip.mp3'), compressed)), null)
  })

  test('only the first 128 KB is read: a title behind a huge cover picture is not found', async (t) => {
    const folder = makeTempFolder(t)
    const cover = frame(3, 'APIC', Buffer.alloc(200 * 1024, 0x01))
    const songFrames = [textFrame(3, 'TIT2', 'Kesariya'), textFrame(3, 'TPE1', 'Arijit Singh')]
    // ffmpeg writes the text frames first, then the cover
    const coverLast = writeTag(path.join(folder, 'last.mp3'), id3Tag(3, [...songFrames, cover]))
    const coverFirst = writeTag(path.join(folder, 'first.mp3'), id3Tag(3, [cover, ...songFrames]))

    assert.equal((await readId3Tags(coverLast)).title, 'Kesariya')
    assert.equal(await readId3Tags(coverFirst), null)
  })

  test('a file without a usable tag reads as null, quietly and without an error', async (t) => {
    const folder = makeTempFolder(t)
    const { lines, log } = captureLog()
    const files = {
      noTag: writeFile(path.join(folder, 'no-tag.mp3'), FAKE_AUDIO),
      empty: writeFile(path.join(folder, 'empty.mp3'), Buffer.alloc(0)),
      shortHeader: writeFile(path.join(folder, 'short.mp3'), Buffer.from('ID3')),
      brokenSize: writeFile(
        path.join(folder, 'broken-size.mp3'),
        Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0, 0xff, 0xff, 0xff, 0xff]), FAKE_AUDIO])
      ),
      v22: writeTag(path.join(folder, 'v22.mp3'), id3Tag(2, [textFrame(3, 'TIT2', 'Old')])),
      noTitle: writeTag(path.join(folder, 'no-title.mp3'), id3Tag(3, [textFrame(3, 'TPE1', 'Arijit Singh')])),
      junkFrames: writeTag(path.join(folder, 'junk.mp3'), id3Tag(3, [Buffer.alloc(64, 0xee)])),
      unknownEncoding: writeTag(
        path.join(folder, 'encoding-9.mp3'),
        id3Tag(3, [frame(3, 'TIT2', Buffer.from([9, 0x41, 0x42])), textFrame(3, 'TPE1', 'Someone')])
      ),
      cutOff: writeFile(
        path.join(folder, 'cut-off.mp3'),
        songTag(3, { title: 'Kesariya', artist: 'Arijit Singh' }).subarray(0, 230)
      ),
      badExtendedHeader: writeTag(
        path.join(folder, 'bad-ext.mp3'),
        id3Tag(4, [textFrame(4, 'TIT2', 'Kesariya')], {
          flags: TAG_EXTENDED_HEADER,
          extendedHeader: syncsafe(2)
        })
      )
    }

    for (const [name, file] of Object.entries(files)) {
      assert.equal(await readId3Tags(file, { log }), null, name)
    }
    assert.deepEqual(lines, [])
  })

  test('a file that cannot be read is null too, with a log line', async (t) => {
    const folder = makeTempFolder(t)
    const { lines, log } = captureLog()

    assert.equal(await readId3Tags(path.join(folder, 'Gone.mp3'), { log }), null)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Gone\.mp3/)
  })
})

// ---------- the library: finding a song already on the drive ----------

describe('buildLibraryIndex + findInLibrary on a drive', () => {
  const { lines, log } = captureLog()
  let drive
  let index

  before(async () => {
    drive = fs.mkdtempSync(path.join(os.tmpdir(), 'song-library-drive-'))
    // the app's own songs: ID3v2.3 as ffmpeg writes them, without a length
    writeSong(path.join(drive, 'World', 'Kesariya.mp3'), 3, {
      title: 'Kesariya',
      artist: 'Pritam, Arijit Singh'
    })
    // a song from elsewhere: ID3v2.4 with its length
    writeSong(path.join(drive, 'Hollywood', 'Levitating.mp3'), 4, {
      title: 'Levitating',
      artist: 'Dua Lipa',
      lengthMs: 203000,
      encoding: UTF8
    })
    // the playlist being filled: excluded, though it comes first by path
    writeSong(path.join(drive, 'India', 'Kesariya.mp3'), 3, {
      title: 'Kesariya',
      artist: 'Pritam, Arijit Singh'
    })
    // never reused: a macOS "._" twin and a half-done download
    writeSong(path.join(drive, 'World', '._Kesariya.mp3'), 3, { title: 'Hidden Twin', artist: 'Ghost' })
    writeSong(path.join(drive, 'World', '.zipify-work-1a2b', 'track_1.mp3'), 3, {
      title: 'Half Done',
      artist: 'Ghost'
    })
    // two folders down is scanned, three is not
    writeSong(path.join(drive, 'Car', 'Mix', 'Shallow.mp3'), 3, { title: 'Shallow', artist: 'Lady Gaga' })
    writeSong(path.join(drive, 'Car', 'Mix', 'Old', 'Too Deep.mp3'), 3, { title: 'Too Deep', artist: 'Ghost' })
    // an MP3 without tags, and a tagged file that isn't an MP3
    writeFile(path.join(drive, 'Untagged.mp3'), FAKE_AUDIO)
    writeTag(path.join(drive, 'World', 'cover.jpg'), songTag(3, { title: 'Not A Song', artist: 'Ghost' }))

    index = await buildLibraryIndex(drive, { excludeFolder: path.join(drive, 'India'), log })
  })

  after(() => fs.rmSync(drive, { recursive: true, force: true }))

  test('counts the MP3s it looked at and the songs it can match on', () => {
    assert.equal(index.rootFolder, path.resolve(drive))
    assert.equal(index.fileCount, 4) // Untagged, Kesariya, Levitating, Shallow
    assert.equal(index.songCount, 3)
    assert.equal(index.isTruncated, false)
    assert.deepEqual(lines, [])
  })

  test('finds a song saved in another playlist folder (same title, same artist)', () => {
    const match = findInLibrary(index, { title: 'Kesariya', artist: 'Arijit Singh,Pritam', durationSec: 268 })

    assert.deepEqual(match, {
      path: path.join(drive, 'World', 'Kesariya.mp3'),
      title: 'Kesariya',
      artist: 'Pritam, Arijit Singh'
    })
  })

  test('the same title by a different artist is not reused', () => {
    assert.equal(findInLibrary(index, { title: 'Kesariya', artist: 'Shreya Ghoshal', durationSec: null }), null)
  })

  test('a length more than 10 s off is not reused; within 10 s, or unknown, is', () => {
    const levitating = { title: 'Levitating', artist: 'Dua Lipa' } // 203 s on the drive

    assert.equal(findInLibrary(index, { ...levitating, durationSec: 214 }), null)
    assert.equal(findInLibrary(index, { ...levitating, durationSec: 192 }), null)
    assert.equal(findInLibrary(index, { ...levitating, durationSec: 213 })?.title, 'Levitating')
    assert.equal(findInLibrary(index, { ...levitating, durationSec: null })?.title, 'Levitating')
  })

  test('hidden files, work folders, the excluded playlist and folders past maxDepth are left out', () => {
    for (const title of ['Hidden Twin', 'Half Done', 'Too Deep', 'Not A Song']) {
      assert.equal(findInLibrary(index, { title, artist: 'Ghost' }), null, title)
    }
    assert.equal(
      findInLibrary(index, { title: 'Shallow', artist: 'Lady Gaga' })?.path,
      path.join(drive, 'Car', 'Mix', 'Shallow.mp3')
    )
  })
})

describe('buildLibraryIndex edge cases', () => {
  test('the playlist being filled is skipped even when its path is spelled in another case', async (t) => {
    const drive = makeTempFolder(t)
    const tags = { title: 'Kesariya', artist: 'Arijit Singh' }
    writeSong(path.join(drive, 'India', 'Kesariya.mp3'), 3, tags)
    writeSong(path.join(drive, 'World', 'Kesariya.mp3'), 3, tags)

    const index = await buildLibraryIndex(drive, { excludeFolder: path.join(drive, 'INDIA') })

    assert.equal(findInLibrary(index, tags).path, path.join(drive, 'World', 'Kesariya.mp3'))
  })

  test('excluding the folder itself leaves nothing to index', async (t) => {
    const drive = makeTempFolder(t)
    writeSong(path.join(drive, 'Kesariya.mp3'), 3, { title: 'Kesariya', artist: 'Arijit Singh' })

    const index = await buildLibraryIndex(drive, { excludeFolder: drive })

    assert.equal(index.fileCount, 0)
  })

  test('a missing drive gives an empty index and a log line, not an error', async (t) => {
    const { lines, log } = captureLog()
    const unplugged = path.join(makeTempFolder(t), 'Unplugged')

    const index = await buildLibraryIndex(unplugged, { log })

    assert.equal(index.songCount, 0)
    assert.equal(findInLibrary(index, { title: 'Kesariya', artist: 'Arijit Singh' }), null)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Unplugged/)
  })

  // chmod can't lock a folder on Windows, and root can read any folder anyway
  const canLockFolders = process.platform !== 'win32' && process.getuid?.() !== 0

  test(
    'an unreadable folder is skipped with a log line; the rest is still indexed',
    { skip: !canLockFolders && 'folders cannot be locked here' },
    async (t) => {
      const drive = makeTempFolder(t)
      const { lines, log } = captureLog()
      writeSong(path.join(drive, 'World', 'Kesariya.mp3'), 3, { title: 'Kesariya', artist: 'Arijit Singh' })
      const locked = path.join(drive, 'Locked')
      writeSong(path.join(locked, 'Secret.mp3'), 3, { title: 'Secret', artist: 'Ghost' })

      fs.chmodSync(locked, 0o000)
      let index
      try {
        index = await buildLibraryIndex(drive, { log })
      } finally {
        fs.chmodSync(locked, 0o755) // so the temp folder can be removed
      }

      assert.equal(index.songCount, 1)
      assert.equal(lines.length, 1)
      assert.match(lines[0], /Locked/)
    }
  )

  test('stops after maxFiles MP3s and says the index is incomplete', async (t) => {
    const drive = makeTempFolder(t)
    const { lines, log } = captureLog()
    for (const name of ['A', 'B', 'C']) {
      writeSong(path.join(drive, `${name}.mp3`), 3, { title: name, artist: 'Someone' })
    }

    const index = await buildLibraryIndex(drive, { maxFiles: 2, log })

    assert.equal(index.fileCount, 2)
    assert.equal(index.isTruncated, true)
    assert.equal(lines.length, 1)
  })

  test('exactly maxFiles MP3s is a complete index', async (t) => {
    const drive = makeTempFolder(t)
    for (const name of ['A', 'B']) {
      writeSong(path.join(drive, `${name}.mp3`), 3, { title: name, artist: 'Someone' })
    }

    const index = await buildLibraryIndex(drive, { maxFiles: 2 })

    assert.equal(index.fileCount, 2)
    assert.equal(index.isTruncated, false)
  })

  test('a tag reader that fails skips only that file, with a log line', async (t) => {
    const drive = makeTempFolder(t)
    const { lines, log } = captureLog()
    writeFile(path.join(drive, 'World', 'Bad.mp3'), FAKE_AUDIO)
    writeFile(path.join(drive, 'World', 'Good.mp3'), FAKE_AUDIO)
    const readTags = async (filePath) => {
      if (filePath.endsWith('Bad.mp3')) throw new Error('drive went away')
      return { title: 'Good', artist: 'Someone', durationSec: null }
    }

    const index = await buildLibraryIndex(drive, { readTags, log })

    assert.equal(index.songCount, 1)
    assert.equal(
      findInLibrary(index, { title: 'Good', artist: 'Someone' })?.path,
      path.join(drive, 'World', 'Good.mp3')
    )
    assert.equal(lines.length, 1)
    assert.match(lines[0], /drive went away/)
  })
})

// ---------- the matching rules ----------

// An index over made-up files whose tags come from `tagsByFile`
// ("World/a.mp3" -> tags), to try the matching rules without ID3 bytes
async function indexWithTags (t, tagsByFile) {
  const drive = makeTempFolder(t)
  for (const file of Object.keys(tagsByFile)) writeFile(path.join(drive, file), FAKE_AUDIO)
  const readTags = async (filePath) =>
    tagsByFile[path.relative(drive, filePath).split(path.sep).join('/')] ?? null
  return { drive, index: await buildLibraryIndex(drive, { readTags }) }
}

describe('findInLibrary matching rules', () => {
  test('when several songs match, the first by path wins (the same answer every run)', async (t) => {
    const tags = { title: 'Kesariya', artist: 'Arijit Singh', durationSec: null }
    // the scan reads the top folder's own files before its subfolders, but
    // "<drive>/Car/…" comes before "<drive>/Kesariya.mp3" by path
    const { drive, index } = await indexWithTags(t, {
      'Kesariya.mp3': tags,
      'World/Kesariya.mp3': tags,
      'Hollywood/Kesariya.mp3': tags,
      'Car/Kesariya.mp3': tags
    })

    assert.equal(findInLibrary(index, tags).path, path.join(drive, 'Car', 'Kesariya.mp3'))
  })

  test('titles match ignoring case, accents and bracketed extras', async (t) => {
    const { index } = await indexWithTags(t, {
      'World/Kesariya.mp3': {
        title: 'Kesariya (From "Brahmastra")',
        artist: 'Pritam, Arijit Singh',
        durationSec: 268
      },
      'World/Deja Vu.mp3': { title: 'Déjà Vu', artist: 'Olivia Rodrigo', durationSec: null }
    })

    assert.equal(
      findInLibrary(index, { title: 'KESARIYA', artist: 'arijit singh', durationSec: 270 })?.title,
      'Kesariya (From "Brahmastra")'
    )
    assert.equal(findInLibrary(index, { title: 'Deja Vu', artist: 'OLIVIA RODRIGO' })?.title, 'Déjà Vu')
  })

  test('artists must match as whole words; featured artists count', async (t) => {
    const { index } = await indexWithTags(t, {
      'World/Fallin.mp3': { title: "Fallin'", artist: 'Alicia Keys', durationSec: null },
      'India/Kesariya.mp3': { title: 'Kesariya', artist: 'Pritam feat. Arijit Singh', durationSec: null }
    })

    assert.equal(findInLibrary(index, { title: "Fallin'", artist: 'Ali' }), null)
    assert.equal(findInLibrary(index, { title: "Fallin'", artist: 'Alicia Keys' })?.artist, 'Alicia Keys')
    assert.equal(
      findInLibrary(index, { title: 'Kesariya', artist: 'Arijit Singh' })?.artist,
      'Pritam feat. Arijit Singh'
    )
  })

  test('another version of the song (live, remix…) does not stand in for it', async (t) => {
    const { index } = await indexWithTags(t, {
      'World/Kesariya (Remix).mp3': { title: 'Kesariya (Remix)', artist: 'Arijit Singh', durationSec: null },
      'World/Levitating.mp3': { title: 'Levitating', artist: 'Dua Lipa', durationSec: null }
    })

    assert.equal(findInLibrary(index, { title: 'Kesariya', artist: 'Arijit Singh' }), null)
    assert.equal(
      findInLibrary(index, { title: 'Kesariya (Remix)', artist: 'Arijit Singh' })?.title,
      'Kesariya (Remix)'
    )
    assert.equal(findInLibrary(index, { title: 'Levitating (Live)', artist: 'Dua Lipa' }), null)
  })

  test('nothing to match on finds nothing', async (t) => {
    const { index } = await indexWithTags(t, {
      'World/Kesariya.mp3': { title: 'Kesariya', artist: 'Arijit Singh', durationSec: null }
    })

    assert.equal(findInLibrary(index, { title: '', artist: 'Arijit Singh' }), null)
    assert.equal(findInLibrary(index, { title: 'Kesariya', artist: '' }), null)
    assert.equal(findInLibrary(index, {}), null)
    assert.equal(findInLibrary(null, { title: 'Kesariya', artist: 'Arijit Singh' }), null)
  })
})

// ---------- copying a song into the playlist ----------

describe('copyIntoPlaylist', () => {
  // a song on the drive and the playlist folder it's copied into
  function setUp (t) {
    const drive = makeTempFolder(t)
    const source = writeFile(path.join(drive, 'World', 'Kesariya.mp3'), Buffer.from('the whole song'))
    const target = path.join(drive, 'India', 'Kesariya.mp3')
    fs.mkdirSync(path.dirname(target))
    return { source, target, part: `${target}.part` }
  }

  function failure (code) {
    return Object.assign(new Error(`${code}: simulated`), { code })
  }

  test('copies the song in and leaves no .part behind', async (t) => {
    const { source, target, part } = setUp(t)

    await copyIntoPlaylist(source, target)

    assert.equal(fs.readFileSync(target, 'utf8'), 'the whole song')
    assert.equal(fs.readFileSync(source, 'utf8'), 'the whole song')
    assert.equal(fs.existsSync(part), false)
  })

  test('never overwrites a file that is already there', async (t) => {
    const { source, target, part } = setUp(t)
    fs.writeFileSync(target, 'a different song')

    await assert.rejects(copyIntoPlaylist(source, target), { code: 'EEXIST' })

    assert.equal(fs.readFileSync(target, 'utf8'), 'a different song')
    assert.equal(fs.existsSync(part), false)
  })

  test('nor one that turns up while the song is being copied', async (t) => {
    const { source, target, part } = setUp(t)
    const fsImpl = {
      ...fs.promises,
      copyFile: async (from, to, mode) => {
        fs.writeFileSync(target, 'a different song')
        return fs.promises.copyFile(from, to, mode)
      }
    }

    await assert.rejects(copyIntoPlaylist(source, target, { fsImpl }), { code: 'EEXIST' })

    assert.equal(fs.readFileSync(target, 'utf8'), 'a different song')
    assert.equal(fs.existsSync(part), false)
  })

  test('a copy that fails half-way removes its .part and passes the error on', async (t) => {
    const { source, target, part } = setUp(t)
    const fsImpl = {
      ...fs.promises,
      copyFile: async (from, to) => {
        fs.writeFileSync(to, 'the who')
        throw failure('ENOSPC')
      }
    }

    await assert.rejects(copyIntoPlaylist(source, target, { fsImpl }), { code: 'ENOSPC' })

    assert.equal(fs.existsSync(part), false)
    assert.equal(fs.existsSync(target), false)
  })

  test('a rename that fails removes the .part and passes the error on', async (t) => {
    const { source, target, part } = setUp(t)
    const fsImpl = {
      ...fs.promises,
      rename: async () => {
        throw failure('EIO')
      }
    }

    await assert.rejects(copyIntoPlaylist(source, target, { fsImpl }), { code: 'EIO' })

    assert.equal(fs.existsSync(part), false)
    assert.equal(fs.existsSync(target), false)
  })

  test('a target that cannot be checked removes the .part and passes the error on', async (t) => {
    const { source, target, part } = setUp(t)
    const fsImpl = {
      ...fs.promises,
      lstat: async () => {
        throw failure('EACCES')
      }
    }

    await assert.rejects(copyIntoPlaylist(source, target, { fsImpl }), { code: 'EACCES' })

    assert.equal(fs.existsSync(part), false)
    assert.equal(fs.existsSync(target), false)
  })

  test('a .part file it did not write is left alone', async (t) => {
    const { source, target, part } = setUp(t)
    fs.writeFileSync(part, 'another copy in progress')

    await assert.rejects(copyIntoPlaylist(source, target), { code: 'EEXIST' })

    assert.equal(fs.readFileSync(part, 'utf8'), 'another copy in progress')
    assert.equal(fs.existsSync(target), false)
  })

  test('when even the clean-up fails, the copy error is the one passed on (the clean-up is logged)', async (t) => {
    const { source, target } = setUp(t)
    const { lines, log } = captureLog()
    const fsImpl = {
      ...fs.promises,
      rename: async () => {
        throw failure('EIO')
      },
      rm: async () => {
        throw failure('EBUSY')
      }
    }

    await assert.rejects(copyIntoPlaylist(source, target, { fsImpl, log }), { code: 'EIO' })

    assert.equal(lines.length, 1)
    assert.match(lines[0], /\.part/)
  })
})
