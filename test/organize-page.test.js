const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { looseText, scoreCandidate } = require('../matching')

// The Organize page (organize.html, organize.js, organize.css). organize.js
// is a classic page script: its function declarations become globals of the
// page, which is how these tests reach its helpers. The second half drives
// the whole page on a small stand-in for the browser and the server.

const REPO = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8')

// values made inside the page's context have that context's prototypes, so
// they're compared as plain JSON
const plain = (value) => JSON.parse(JSON.stringify(value))

// organize.js wires itself up only when its markup is there; without any
// elements its helpers can be tested on their own
function loadHelpers () {
  const context = { document: { getElementById: () => null }, setTimeout, clearTimeout }
  context.window = context
  vm.createContext(context)
  vm.runInContext(read('organize.js'), context, { filename: 'organize.js' })
  return context
}

const page = loadHelpers()
const constant = (name) => vm.runInContext(name, page)

const ROOT = '/Volumes/PEN'

// a scanned song the way the server describes it (the id stands in for its hash)
function song (relPath, tags = {}) {
  const parts = relPath.split('/')
  const fileName = parts.pop()
  return {
    id: relPath.replace(/[^A-Za-z0-9]/g, '_'),
    path: `${ROOT}/${relPath}`,
    relPath,
    folder: parts.join('/'),
    fileName,
    size: 4_000_000,
    title: '',
    artist: '',
    album: '',
    year: '',
    genre: '',
    track: '',
    durationSec: 200,
    hasCover: true,
    tagged: Boolean(tags.title && tags.artist),
    ...tags
  }
}

const SONGS = [
  song('Tum Hi Ho.mp3', {
    title: 'Tum Hi Ho', artist: 'Arijit Singh', album: 'Aashiqui 2', year: '2013', genre: 'Bollywood', track: '3/12', durationSec: 262
  }),
  song('Hindi/Channa Mereya.mp3', {
    title: 'Channa Mereya', artist: 'Pritam, Arijit Singh', album: 'Ae Dil Hai Mushkil', year: '2016-10-28', genre: 'bollywood', track: '2', durationSec: 289, size: 9_000_000
  }),
  song('Hindi/2010/Tum Hi Ho (2).mp3', {
    title: 'Tum Hi Ho (Reprise)', artist: 'Arijit Singh feat. Mithoon', album: 'Aashiqui 2', year: '2013', genre: 'Bollywood', track: '12', durationSec: 266
  }),
  song('Rock/Bohemian Rhapsody.mp3', {
    title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', year: '1975', genre: 'Rock', track: '11', durationSec: 355, size: 8_000_000
  }),
  song('Rock/Live/Bohemian Rhapsody.mp3', {
    title: 'Bohemian Rhapsody', artist: 'Queen', album: 'Live Killers', year: '1979', genre: 'Rock', durationSec: 420
  }),
  song('Unsorted/07 - Kesariya.mp3', { durationSec: null, size: 3_000_000 }),
  song('Unsorted/Kesariya.mp3', { durationSec: 268 }),
  song('Halo.mp3', { title: 'Halo', artist: 'Beyoncé', year: '2008', genre: 'Pop', durationSec: 261, size: 2_000_000 })
]

const library = page.buildLibrary('scan-1', ROOT, 4, SONGS)
const entryAt = (relPath) => library.entries.find((entry) => entry.song.relPath === relPath)
const relPaths = (entries) => plain(entries.map((entry) => entry.song.relPath))

// the songs a set of filters shows, in the library's order
function shown (filters) {
  const matches = page.songMatcher({ ...page.emptyFilters(), ...filters })
  return relPaths(library.entries.filter(matches))
}

function sorted (key, isDescending = false) {
  return relPaths(page.sortEntries(library.entries, { key, isDescending }))
}

// --- the rules the page shares with matching.js and the server's planner ---

test('loose titles match matching.js', () => {
  const titles = [
    'Tum Hi Ho (From "Aashiqui 2")',
    'Halo [2008 Remaster]',
    'Song feat. Someone Else',
    'KALYANI - Remix',
    '  Spaces   and_punctuation!! ',
    'Ünïcödé Ñame'
  ]
  for (const title of titles) assert.equal(page.looseText(title), looseText(title), title)
})

test('the main artist is the name before a comma or "feat.", as the planner reads it', () => {
  assert.equal(page.mainArtistKey('Pritam, Arijit Singh'), 'pritam')
  // "&" and "/" stay: "Simon & Garfunkel" and "AC/DC" are one act each
  assert.equal(page.mainArtistKey('Simon & Garfunkel'), 'simon garfunkel')
  assert.equal(page.mainArtistKey('AC/DC'), 'ac dc')
  assert.equal(page.mainArtistKey('Daft Punk feat. Pharrell Williams'), 'daft punk')
  assert.equal(page.mainArtistKey('Daft Punk (featuring Pharrell)'), 'daft punk')
  assert.equal(page.mainArtistKey(' ; Lead; Other'), 'lead')
  assert.equal(page.mainArtistKey(''), '')
  // the artist filter lists each name once, without the bracket "(feat." leaves
  assert.deepEqual(plain(page.artistNames('Song Artist (feat. KK), KK, song artist')), ['Song Artist', 'KK'])
})

test('version words are the ones matching.js knows, read both ways as the planner does', () => {
  const listed = /const VARIANT_WORDS = \[([\s\S]*?)\]/.exec(read('matching.js'))[1]
  const variantWords = [...listed.matchAll(/'([^']*)'/g)].map((match) => match[1])
  assert.deepEqual(plain(constant('VERSION_WORDS')), variantWords)

  const titles = [
    'Tum Hi Ho',
    'Tum Hi Ho (Live)',
    'Tum Hi Ho - Live at Wembley',
    'Tum Hi Ho (Remix)',
    'Deliver Us',
    'Kesariya (Slowed + Reverb)',
    'Kesariya slowed reverb',
    'Kesariya [Lo-Fi]'
  ]
  const variantOnly = (a, b) => scoreCandidate({ title: a }, { title: b }).variant.length
  for (const a of titles) {
    for (const b of titles) {
      const isSameVersion = variantOnly(a, b) === 0 && variantOnly(b, a) === 0
      assert.equal(page.versionOf(a) === page.versionOf(b), isSameVersion, `${a} / ${b}`)
    }
  }
})

// --- the scanned songs ---

test('a scanned song keeps only known fields, and songs without a usable id are left out', () => {
  const scanned = page.buildLibrary('scan-x', ROOT, 4, [
    null,
    { id: 'bad id!' },
    'not a song',
    { id: 'ok1', fileName: ' x.mp3 ', size: '12', durationSec: 'soon', tagged: 'yes', title: ' T ', artist: 5 }
  ])

  assert.equal(scanned.entries.length, 1)
  const kept = scanned.entries[0].song
  assert.equal(kept.title, 'T')
  assert.equal(kept.artist, '5')
  assert.equal(kept.fileName, 'x.mp3')
  assert.equal(kept.size, 12)
  assert.equal(kept.durationSec, null)
  assert.equal(kept.album, '')
  assert.equal(kept.tagged, true) // worked out from the title and artist, as "yes" isn't a yes/no
  assert.equal(page.buildLibrary('scan-y', ROOT, 4, 'nothing').entries.length, 0)
})

test('an untagged song goes by its file name, without the track number this app adds', () => {
  assert.equal(entryAt('Unsorted/07 - Kesariya.mp3').title, 'Kesariya')
  assert.equal(entryAt('Tum Hi Ho.mp3').title, 'Tum Hi Ho')
  assert.equal(entryAt('Hindi/2010/Tum Hi Ho (2).mp3').track, 12)
  assert.equal(entryAt('Hindi/Channa Mereya.mp3').year, 2016)
})

test('songs with the same loose title and main artist, and about the same length, look like duplicates', () => {
  const duplicates = relPaths(library.entries.filter((entry) => entry.isDuplicate))

  assert.deepEqual(duplicates, [
    'Tum Hi Ho.mp3', // and its reprise: brackets and "feat." don't count, 4 s apart
    'Hindi/2010/Tum Hi Ho (2).mp3'
  ])
  // the live Bohemian Rhapsody is 65 s longer: a different recording
  assert.equal(entryAt('Rock/Live/Bohemian Rhapsody.mp3').isDuplicate, false)
  // songs without a title and artist are never called copies: the server won't set them aside
  assert.equal(entryAt('Unsorted/Kesariya.mp3').isDuplicate, false)
})

test('a live take is no copy, and lengths that drift apart make separate recordings', () => {
  const take = (relPath, title, durationSec) => song(relPath, { title, artist: 'Arijit Singh', durationSec })
  const scanned = page.buildLibrary('scan-z', ROOT, 4, [
    take('a.mp3', 'Kesariya', 200),
    take('b.mp3', 'Kesariya (Live)', 200),
    take('c.mp3', 'Kesariya', 208),
    take('d.mp3', 'Kesariya', 216), // 8 s from c but 16 s from a: a recording of its own
    take('e.mp3', 'Kesariya [Live]', null), // an unknown length can't rule it out
    // a title without an artist: two "Intro"s are most likely different songs
    song('f.mp3', { title: 'Intro', durationSec: 60 }),
    song('g.mp3', { title: 'Intro', durationSec: 60 }),
    // the same length, but one is the live take: not a copy of the other
    take('h.mp3', 'Channa Mereya', 289),
    take('i.mp3', 'Channa Mereya (Live)', 289)
  ])

  assert.deepEqual(relPaths(scanned.entries.filter((entry) => entry.isDuplicate)), ['a.mp3', 'b.mp3', 'c.mp3', 'e.mp3'])
})

test('the summary counts songs, size, artists, albums, folders, untagged songs and duplicates', () => {
  assert.deepEqual(plain(library.summary), {
    songs: 8,
    bytes: 38_000_000,
    artists: 5, // Arijit Singh, Pritam, Mithoon, Queen, Beyoncé: each singer once
    albums: 4,
    folders: 6,
    untagged: 2,
    duplicates: 2
  })
  assert.equal(library.isCapped, false)
})

// --- filters ---

test('search finds every word across title, artist, album and file name, ignoring case and accents', () => {
  assert.deepEqual(shown({ text: 'tum  HO' }), ['Tum Hi Ho.mp3', 'Hindi/2010/Tum Hi Ho (2).mp3'])
  assert.deepEqual(shown({ text: 'BEYONCÉ' }), ['Halo.mp3'])
  assert.deepEqual(shown({ text: 'kesariya' }), ['Unsorted/07 - Kesariya.mp3', 'Unsorted/Kesariya.mp3'])
  assert.deepEqual(shown({ text: 'opera queen' }), ['Rock/Bohemian Rhapsody.mp3'])
})

test('the artist filter finds a singer in duets too, and "No artist tag" finds the rest', () => {
  assert.deepEqual(shown({ artist: 'is:arijit singh' }), [
    'Tum Hi Ho.mp3',
    'Hindi/Channa Mereya.mp3',
    'Hindi/2010/Tum Hi Ho (2).mp3'
  ])
  assert.deepEqual(shown({ artist: 'none' }), ['Unsorted/07 - Kesariya.mp3', 'Unsorted/Kesariya.mp3'])
  assert.deepEqual(shown({ genre: 'is:bollywood' }).length, 3) // any letter case
})

test('the folder filter includes the folders inside the chosen one; "Only the top folder" does not', () => {
  assert.deepEqual(shown({ folder: 'is:Hindi' }), ['Hindi/Channa Mereya.mp3', 'Hindi/2010/Tum Hi Ho (2).mp3'])
  assert.deepEqual(shown({ folder: 'is:Rock/Live' }), ['Rock/Live/Bohemian Rhapsody.mp3'])
  assert.deepEqual(shown({ folder: 'none' }), ['Tum Hi Ho.mp3', 'Halo.mp3'])
})

test('year and length ranges leave out songs without a year or a known length', () => {
  assert.deepEqual(shown({ yearFrom: '2010', yearTo: '2016' }), [
    'Tum Hi Ho.mp3',
    'Hindi/Channa Mereya.mp3',
    'Hindi/2010/Tum Hi Ho (2).mp3'
  ])
  assert.deepEqual(shown({ yearFrom: '2014' }), ['Hindi/Channa Mereya.mp3'])
  assert.deepEqual(shown({ minLength: '4.5' }), [
    'Hindi/Channa Mereya.mp3',
    'Rock/Bohemian Rhapsody.mp3',
    'Rock/Live/Bohemian Rhapsody.mp3'
  ])
  assert.deepEqual(shown({ maxLength: '4,4' }), ['Tum Hi Ho.mp3', 'Halo.mp3']) // a comma works too
})

test('untagged-only and duplicates-only narrow the list, and filters add up', () => {
  assert.deepEqual(shown({ isUntaggedOnly: true }), ['Unsorted/07 - Kesariya.mp3', 'Unsorted/Kesariya.mp3'])
  assert.deepEqual(shown({ isDuplicatesOnly: true, folder: 'is:Hindi' }), ['Hindi/2010/Tum Hi Ho (2).mp3'])
  assert.equal(shown({}).length, 8)
  assert.equal(page.activeFilterCount({ ...page.emptyFilters(), text: 'x', isUntaggedOnly: true }), 2)
})

test('filter lists name each value once with its song count, and count the songs without one', () => {
  const filters = constant('CHOICE_FILTERS')
  const choices = (name) => plain(page.filterChoices(library.entries, filters[name]))

  assert.deepEqual(choices('artist'), {
    choices: [
      { key: 'arijit singh', label: 'Arijit Singh', count: 3 },
      { key: 'beyonce', label: 'Beyoncé', count: 1 },
      { key: 'mithoon', label: 'Mithoon', count: 1 },
      { key: 'pritam', label: 'Pritam', count: 1 },
      { key: 'queen', label: 'Queen', count: 2 }
    ],
    blanks: 2
  })
  assert.deepEqual(choices('genre').choices.map((choice) => [choice.label, choice.count]), [
    ['Bollywood', 3], // the first spelling seen names the choice
    ['Pop', 1],
    ['Rock', 2]
  ])
  assert.deepEqual(choices('folder').choices.map((choice) => [choice.key, choice.count]), [
    ['Hindi', 2],
    ['Hindi/2010', 1],
    ['Rock', 2],
    ['Rock/Live', 1],
    ['Unsorted', 2]
  ])
  assert.equal(choices('folder').blanks, 2)
})

// --- sorting, selection and pages ---

test('the table starts in drive order: folder by folder, then track number and file name', () => {
  assert.deepEqual(sorted('folder'), [
    'Tum Hi Ho.mp3', // the top folder first, track 3 before no track
    'Halo.mp3',
    'Hindi/Channa Mereya.mp3',
    'Hindi/2010/Tum Hi Ho (2).mp3',
    'Rock/Bohemian Rhapsody.mp3',
    'Rock/Live/Bohemian Rhapsody.mp3',
    'Unsorted/07 - Kesariya.mp3',
    'Unsorted/Kesariya.mp3'
  ])
})

test('sorting puts songs without the value last both ways, and breaks ties by drive order', () => {
  assert.deepEqual(sorted('year'), [
    'Rock/Bohemian Rhapsody.mp3',
    'Rock/Live/Bohemian Rhapsody.mp3',
    'Halo.mp3',
    'Tum Hi Ho.mp3',
    'Hindi/2010/Tum Hi Ho (2).mp3',
    'Hindi/Channa Mereya.mp3',
    'Unsorted/07 - Kesariya.mp3',
    'Unsorted/Kesariya.mp3'
  ])
  assert.deepEqual(sorted('year', true).slice(0, 3), ['Hindi/Channa Mereya.mp3', 'Tum Hi Ho.mp3', 'Hindi/2010/Tum Hi Ho (2).mp3'])
  assert.deepEqual(sorted('year', true).slice(-2), ['Unsorted/07 - Kesariya.mp3', 'Unsorted/Kesariya.mp3'])
  assert.deepEqual(sorted('length', true), [
    'Rock/Live/Bohemian Rhapsody.mp3',
    'Rock/Bohemian Rhapsody.mp3',
    'Hindi/Channa Mereya.mp3',
    'Unsorted/Kesariya.mp3',
    'Hindi/2010/Tum Hi Ho (2).mp3',
    'Tum Hi Ho.mp3',
    'Halo.mp3',
    'Unsorted/07 - Kesariya.mp3'
  ])
  assert.deepEqual(sorted('title').slice(0, 4), [
    'Rock/Bohemian Rhapsody.mp3',
    'Rock/Live/Bohemian Rhapsody.mp3',
    'Hindi/Channa Mereya.mp3',
    'Halo.mp3'
  ])
})

test('clicking the same column again flips the order; another column starts A to Z', () => {
  assert.deepEqual(plain(page.nextSort({ key: 'title', isDescending: false }, 'title')), { key: 'title', isDescending: true })
  assert.deepEqual(plain(page.nextSort({ key: 'title', isDescending: true }, 'size')), { key: 'size', isDescending: false })
})

test('shift-click ticks every row between the two, in the table order', () => {
  const entries = page.sortEntries(library.entries, { key: 'folder', isDescending: false })
  const ids = plain(entries.map((entry) => entry.song.id))

  assert.deepEqual(plain(page.idsBetween(entries, ids[5], ids[2])), ids.slice(2, 6))
  assert.deepEqual(plain(page.idsBetween(entries, 'gone', ids[3])), [ids[3]])

  const ticked = page.withIds(new Set(['a']), ['b', 'c'], true)
  assert.deepEqual([...page.invertIds(ticked, ['a', 'd'])].sort(), ['b', 'c', 'd'])
  assert.deepEqual([...page.withIds(ticked, ['a', 'b'], false)], ['c'])
})

test('pages hold 200 songs and a page past the end shows the last one', () => {
  assert.deepEqual(plain(page.pageInfo(450, 0)), { page: 0, pageCount: 3, start: 0, end: 200 })
  assert.deepEqual(plain(page.pageInfo(450, 9)), { page: 2, pageCount: 3, start: 400, end: 450 })
  assert.deepEqual(plain(page.pageInfo(0, 3)), { page: 0, pageCount: 1, start: 0, end: 0 })
})

test('the counts under the table say what is ticked, shown and hidden', () => {
  const all = (5000).toLocaleString()
  assert.equal(page.selectionText(0, 0), 'No songs selected')
  assert.equal(page.selectionText(1, 0), '1 song selected')
  assert.equal(page.selectionText(12, 1), '12 songs selected · 1 more is hidden by the filters and left out')
  assert.equal(page.tableStatusText(page.pageInfo(450, 1), 450, 450), 'Showing 201–400 of 450 songs.')
  assert.equal(page.tableStatusText(page.pageInfo(12, 0), 12, 5000), `Showing 1–12 of 12 matching songs (${all} in all).`)
  assert.equal(page.tableStatusText(page.pageInfo(0, 0), 0, 5000), `No songs match the filters (${all} songs in all).`)
})

// --- plans ---

const FORM = {
  groupBy: 'artist-album',
  sortTarget: '   ',
  sortMode: 'move',
  pattern: ' {artist} - {title} ',
  playlistName: ' Road trip ',
  playlistTarget: '/Volumes/PEN/Playlists',
  playlistMode: 'copy',
  numberTracks: true,
  writePlaylist: false,
  keep: 'newest'
}

test('each tab asks for its own options, leaving out an empty folder so the server picks its default', () => {
  assert.deepEqual(plain(page.planOptions('sort', FORM)), { groupBy: 'artist-album', mode: 'move' })
  assert.deepEqual(plain(page.planOptions('rename', FORM)), { pattern: '{artist} - {title}' })
  assert.deepEqual(plain(page.planOptions('playlist', FORM)), {
    name: 'Road trip',
    mode: 'copy',
    numberTracks: true,
    writePlaylist: false,
    targetFolder: '/Volumes/PEN/Playlists'
  })
  assert.deepEqual(plain(page.planOptions('dedupe', FORM)), { keep: 'newest' })
  assert.deepEqual(plain(page.planRequest('scan-1', 'dedupe', FORM, ['b', 'a'])), {
    scanId: 'scan-1',
    songIds: ['b', 'a'], // in the table's order
    action: 'dedupe',
    options: { keep: 'newest' }
  })
})

test('a request is checked before it goes to the server', () => {
  const request = (action, options, songIds = ['a', 'b']) => ({ scanId: 's', action, options, songIds })

  assert.match(page.requestProblem(request('sort', { groupBy: 'artist', mode: 'copy' }, [])), /Tick the songs/)
  assert.match(page.requestProblem(request('dedupe', { keep: 'largest' }, ['a'])), /at least two/)
  assert.match(page.requestProblem(request('sort', { groupBy: 'artist', mode: 'copy', targetFolder: 'Music' })), /full path/)
  assert.match(page.requestProblem(request('rename', { pattern: 'My song' })), /\{title\}/)
  assert.match(page.requestProblem(request('rename', { pattern: '{title} {mood}' })), /\{mood\}/)
  assert.match(page.requestProblem(request('playlist', { name: '', mode: 'copy' })), /name/)
  assert.equal(page.requestProblem(request('sort', { groupBy: 'artist', mode: 'copy', targetFolder: 'E:\\Music' })), null)
  assert.equal(page.requestProblem(request('rename', { pattern: '{track} - {title}' })), null)
})

test('the rename example fills in the tags and pads track numbers to the highest one', () => {
  const tumHiHo = entryAt('Tum Hi Ho.mp3')
  const halo = entryAt('Halo.mp3')

  assert.deepEqual(plain(page.renameExample(tumHiHo, '{track} - {artist} - {title}', 2)), {
    name: '03 - Arijit Singh - Tum Hi Ho.mp3'
  })
  assert.deepEqual(plain(page.renameExample(tumHiHo, '{track}. {title} ({year})', 3)), { name: '003. Tum Hi Ho (2013).mp3' })
  // the first tag the song lacks, as the server reports it; an unchanged name is skipped too
  assert.deepEqual(plain(page.renameExample(halo, '{title} - {album} - {track}', 2)), { skip: 'it has no album tag' })
  assert.deepEqual(plain(page.renameExample(halo, '{track} {title}', 2)), { skip: 'it has no track number tag' })
  assert.deepEqual(plain(page.renameExample(halo, '{title}', 2)), { skip: 'it already has that name' })

  const withTrack = (track) => page.songEntry(page.cleanSong(song(`t${track}.mp3`, { track })))
  assert.equal(page.trackWidth([withTrack(9)]), 2)
  assert.equal(page.trackWidth([withTrack(3), withTrack(150)]), 3)
  assert.equal(page.trackWidth([withTrack('1200/1300')]), 4)
  assert.equal(page.trackWidth([halo]), 2) // no track numbers at all
})

test('the rename example makes names a FAT32 drive takes, the way the server does', () => {
  const named = (fileName, title, artist = 'X') => page.songEntry(page.cleanSong(song(fileName, { title, artist })))
  const odd = named('odd.mp3', '...AC/DC: Live? <1979>', 'AC|DC')

  assert.deepEqual(plain(page.renameExample(odd, '{title}', 2)), { name: 'AC DC Live 1979.mp3' })
  assert.deepEqual(plain(page.renameExample(odd, '{artist}. ', 2)), { name: 'AC DC.mp3' })
  assert.deepEqual(plain(page.renameExample(named('LOUD.MP3', 'Loud Song'), '{title}', 2)), { name: 'Loud Song.MP3' })
  assert.deepEqual(plain(page.renameExample(named('a.mp3', 'con'), '{title}', 2)), { name: 'con_.mp3' }) // a Windows device name
  assert.deepEqual(plain(page.renameExample(named('b.mp3', '...'), '{title}', 2)), { skip: 'the new name would be empty' })

  const long = page.renameExample(named('c.mp3', 'x'.repeat(300)), '{title}', 2).name
  assert.equal(long, `${'x'.repeat(196)}.mp3`) // 200 characters with the extension
  const emoji = page.renameExample(named('d.mp3', `${'a'.repeat(195)}😀😀`), '{title}', 2).name
  assert.equal(emoji, `${'a'.repeat(195)}.mp3`) // never half an emoji
})

test('the rename example line warns about songs that would be skipped', () => {
  const tumHiHo = entryAt('Tum Hi Ho.mp3')
  const halo = entryAt('Halo.mp3')

  assert.deepEqual(plain(page.renameExampleText([tumHiHo], '{artist} - {title}')), {
    text: 'Example: "Tum Hi Ho.mp3" becomes "Arijit Singh - Tum Hi Ho.mp3".',
    kind: ''
  })
  assert.equal(
    page.renameExampleText([tumHiHo, halo], '{album} - {title}').text,
    'Example: "Tum Hi Ho.mp3" becomes "Aashiqui 2 - Tum Hi Ho.mp3". 1 ticked song lacks a tag it uses and would be skipped.'
  )
  assert.equal(page.renameExampleText([halo, tumHiHo], '{album}').text, '"Halo.mp3" would be skipped: it has no album tag.')
  assert.equal(
    page.renameExampleText([halo, entryAt('Unsorted/Kesariya.mp3')], '{album}').text,
    '"Halo.mp3" would be skipped: it has no album tag. 1 other ticked song lacks a tag it uses too.'
  )
  assert.equal(page.renameExampleText([], '{title}').kind, '')
  assert.equal(page.renameExampleText([halo], 'no tags').kind, 'warn')
})

test('the playlist tab says which order the songs go in', () => {
  assert.match(page.orderText({ key: 'year', isDescending: true }), /by year, newest first/)
  assert.match(page.orderText({ key: 'title', isDescending: false }), /by title, A to Z/)
})

test('a plan from the server is checked and given a known shape', () => {
  assert.throws(() => page.cleanPlan({ operations: [] }), /shape/)
  assert.throws(() => page.cleanPlan({ planId: 'p', operations: 'all of them' }), /shape/)
  assert.deepEqual(
    plain(page.cleanPlan({ planId: 7, operations: [{ kind: 'copy', to: '/x' }, null], summary: { copies: '1', moves: -2 } })),
    {
      planId: '7',
      operations: [{ kind: 'copy', to: '/x' }],
      conflicts: [],
      summary: { copies: 1, moves: 0, renames: 0, folders: 0, skipped: 0 }
    }
  )
})

test('plan rows show paths from the scanned folder, and only the names for a rename', () => {
  const describe = (operation, root = ROOT) => {
    const { label, from, to } = page.describeOperation(operation, root)
    return [label, from, to]
  }

  assert.deepEqual(describe({ kind: 'copy', from: `${ROOT}/Hindi/a.mp3`, to: `${ROOT}/Organized/Arijit Singh/a.mp3` }), [
    'Copy',
    'Hindi/a.mp3',
    'Organized/Arijit Singh/a.mp3'
  ])
  assert.deepEqual(describe({ kind: 'rename', from: `${ROOT}/Hindi/old.mp3`, to: `${ROOT}/Hindi/new.mp3` }), ['Rename', 'old.mp3', 'new.mp3'])
  assert.deepEqual(describe({ kind: 'mkdir', to: `${ROOT}/Organized` }, `${ROOT}/`), ['New folder', '', 'Organized'])
  assert.deepEqual(describe({ kind: 'write-m3u', to: ROOT }), ['Playlist file', '', '(the scanned folder)'])
  // a folder whose name merely starts the same is not inside the scanned one
  assert.deepEqual(describe({ kind: 'move', from: `${ROOT}2/a.mp3`, to: '/Volumes/OTHER/a.mp3' }), [
    'Move',
    '/Volumes/PEN2/a.mp3',
    '/Volumes/OTHER/a.mp3'
  ])
})

test('the plan summary only counts what would happen', () => {
  const plan = {
    summary: { copies: 3, moves: 0, renames: 0, folders: 1, skipped: 2 },
    operations: [{ kind: 'mkdir' }, { kind: 'copy' }, { kind: 'copy' }, { kind: 'copy' }, { kind: 'write-m3u' }],
    conflicts: []
  }

  assert.deepEqual(plain(page.planCounts(plan)), [
    { value: '3', words: 'songs to copy', kind: 'info' },
    { value: '1', words: 'new folder', kind: '' },
    { value: '1', words: 'playlist file', kind: 'ok' },
    { value: '2', words: 'songs skipped', kind: 'warn' }
  ])
})

test('moving or renaming asks first; copying does not', () => {
  const plan = (...kinds) => ({ operations: kinds.map((kind) => ({ kind })) })

  assert.equal(page.confirmText(plan('mkdir', 'copy', 'write-m3u')), null)
  assert.match(page.confirmText(plan('move', 'move')), /This will move 2 songs on the drive\. Nothing is deleted/)
  assert.match(page.confirmText(plan('move', 'rename')), /move 1 song and rename 1 song/)
})

test('an expired or out-of-date scan or preview says to scan again', () => {
  const failure = (message, status) => Object.assign(new Error(message), { status })
  assert.match(page.planErrorText(failure('That scan has expired.', 404)), /expired\. Click Scan/)
  assert.match(page.planErrorText(failure('The folder changed since the scan.', 409)), /since the scan\. Click Scan/)
  assert.equal(page.planErrorText(failure('Bad options.', 400)), 'Bad options.')
})

// --- changes: how an apply or undo ended, and whether it can be undone ---

test('the last change says how far it got and how it ended', () => {
  const record = (fields) => page.changeRecord({ journalPath: `${ROOT}/.zipify-organizer/journal-1.json`, ...fields })

  assert.equal(page.changeResult(record({ status: 'running', done: 3, total: 10 })).text, 'Working… 3 of 10 changes done.')
  assert.deepEqual(plain(page.changeResult(record({ status: 'done', done: 10, total: 10 }))), {
    text: 'Done: 10 changes made.',
    kind: 'ok'
  })
  const failed = [{ operation: { kind: 'copy' }, error: 'disk full' }, { operation: {}, error: '' }]
  assert.match(page.changeResult(record({ status: 'done', done: 10, total: 10, failed })).text, /2 of 10 changes didn't work/)
  assert.equal(page.changeResult(record({ status: 'error', done: 4, total: 10 })).kind, 'fail')
  assert.match(page.changeResult(record({ status: 'lost' })).text, /use Undo/)
  assert.doesNotMatch(page.changeResult(record({ status: 'lost', journalPath: '' })).text, /Undo/)
  assert.equal(page.changeResult(record({ kind: 'undo', status: 'done' })).text, 'Undone: everything is back as it was.')
  assert.match(page.changeResult(record({ status: 'remembered', at: 0 })).text, /You can still undo it\.$/)
  assert.match(page.changeResult(record({ status: 'refused', error: 'Plan not found.' })).text, /didn't start: Plan not found\./)
  assert.equal(page.failureText(failed[0], ROOT), 'Copy — disk full')
})

test('an apply can be undone once it stops; an undo only when it left something behind', () => {
  const record = (fields) => page.changeRecord({ journalPath: `${ROOT}/.zipify-organizer/journal-1.json`, ...fields })
  const failed = [{ operation: {}, error: 'busy' }]

  assert.equal(page.canUndo(record({ status: 'running' })), false)
  assert.equal(page.canUndo(record({ status: 'done' })), true)
  assert.equal(page.canUndo(record({ status: 'error' })), true)
  assert.equal(page.canUndo(record({ status: 'remembered' })), true)
  assert.equal(page.canUndo(record({ status: 'refused', journalPath: '' })), false)
  assert.equal(page.canUndo(record({ kind: 'undo', status: 'done' })), false)
  assert.equal(page.canUndo(record({ kind: 'undo', status: 'done', failed })), true)
  assert.equal(page.canUndo(record({ kind: 'undo', status: 'lost' })), true)
  assert.equal(page.canUndo(null), false)
})

// --- the three files fit together ---

const HTML = read('organize.html')
const CSS = read('organize.css')
const SCRIPT = read('organize.js')
const HTML_IDS = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])

test('organize.js never builds markup from strings', () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
})

test('every element organize.js looks up is in organize.html, and no id is used twice', () => {
  const listed = (name) => Object.values(constant(name))
  const fromTemplates = [
    ...constant('ACTIONS').flatMap((action) => [`tab-${action}`, `panel-${action}`]),
    ...Object.keys(constant('SORT_VALUES')).flatMap((key) => [`head-${key}`, `sort-${key}`]),
    ...constant('TOKENS').map((token) => `token-${token}`)
  ]
  const used = new Set([
    ...[...SCRIPT.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
    ...listed('TYPED_FILTERS'),
    ...listed('PICKED_FILTERS'),
    ...listed('FILTER_BOXES'),
    ...listed('ACTION_INPUT_IDS'),
    ...listed('KEEP_CHOICES'),
    ...listed('CHOOSE_BUTTON_IDS'),
    ...fromTemplates,
    'organizePage'
  ])

  const missing = [...used].filter((id) => !HTML_IDS.includes(id))
  assert.deepEqual(missing, [])
  assert.deepEqual(HTML_IDS.filter((id, i) => HTML_IDS.indexOf(id) !== i), [])
  // each Choose… button names a field that exists
  for (const target of HTML.matchAll(/data-target="([^"]+)"/g)) assert.ok(HTML_IDS.includes(target[1]), target[1])
})

test('organize.html loads app.css, then organize.css, then organize.js', () => {
  const appCss = HTML.indexOf('href="app.css"')
  const organizeCss = HTML.indexOf('href="organize.css"')

  assert.ok(appCss > 0 && organizeCss > appCss)
  assert.match(HTML, /<script src="organize\.js"><\/script>/)
  assert.match(HTML, /<h1>Organize your <span>songs<\/span><\/h1>/)
  assert.match(HTML, /href="index\.html">← Back to downloads</)
})

test('every class the page uses is styled by app.css or organize.css', () => {
  const styles = read('app.css') + CSS
  const fromHtml = [...HTML.matchAll(/\sclass="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))
  const fromScript = [...SCRIPT.matchAll(/\bel\("\w+", "([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))
  const unstyled = [...new Set([...fromHtml, ...fromScript])].filter(
    (name) => !new RegExp(`\\.${name.replace(/-/g, '\\-')}(?![\\w-])`).test(styles)
  )

  assert.deepEqual(unstyled, [])
})

test('organize.css takes every color from the app.css tokens, so dark mode follows', () => {
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(rules, /\brgba?\(|\bhsla?\(/)
})

// --- the whole page, on a stand-in for the browser ---

// Just enough of the DOM for organize.js: elements, their children and
// attributes, classes, bubbling events and [data-focus="…"] lookups.
class FakeElement {
  constructor (tag, document) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = document
    this.childNodes = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.listeners = new Map()
    this.classes = new Set()
    this.id = ''
    this.type = ''
    this.value = ''
    this.checked = false
    this.disabled = false
    this.indeterminate = false
    this.open = false
    this.scrollTop = 0
    const classes = this.classes
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const isOn = force === undefined ? !classes.has(name) : Boolean(force)
        if (isOn) classes.add(name)
        else classes.delete(name)
        return isOn
      }
    }
  }

  get className () {
    return [...this.classes].join(' ')
  }

  set className (value) {
    this.classes.clear()
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classes.add(name)
  }

  get children () {
    return this.childNodes.filter((node) => node instanceof FakeElement)
  }

  get textContent () {
    return this.childNodes.map((node) => (typeof node === 'string' ? node : node.textContent)).join('')
  }

  set textContent (value) {
    this.replaceChildren(String(value))
  }

  append (...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.remove()
        node.parentNode = this
      }
      if (node !== '') this.childNodes.push(node)
    }
  }

  replaceChildren (...nodes) {
    for (const child of this.children) child.parentNode = null
    this.childNodes = []
    this.append(...nodes)
  }

  remove () {
    if (!this.parentNode) return
    this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this)
    this.parentNode = null
  }

  setAttribute (name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = value
    if (name === 'id') this.id = String(value)
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] = String(value)
    }
  }

  getAttribute (name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  removeAttribute (name) {
    this.attributes.delete(name)
  }

  addEventListener (type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  focus () {
    this.ownerDocument.activeElement = this
  }

  scrollIntoView () {}

  querySelector (selector) {
    const match = /^\[data-focus="([^"]*)"\]$/.exec(selector)
    if (!match) throw new Error(`the stand-in DOM can't look up "${selector}"`)
    return this.find((node) => node.dataset.focus === match[1])
  }

  find (isWanted) {
    for (const child of this.children) {
      if (isWanted(child)) return child
      const found = child.find(isWanted)
      if (found) return found
    }
    return null
  }
}

// the elements with an id in organize.html, made when the script first asks
// for them, with the attributes the markup gives them
function fakeDocument (html) {
  const known = new Map()
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attributes = Object.fromEntries(
      [...match[2].matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)].map((attr) => [attr[1], attr[2] ?? ''])
    )
    if (attributes.id) known.set(attributes.id, { tag: match[1], attributes })
  }

  const made = new Map()
  const document = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, document),
    getElementById (id) {
      if (!known.has(id)) return null
      if (!made.has(id)) {
        const { tag, attributes } = known.get(id)
        const element = new FakeElement(tag, document)
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
        element.type = attributes.type ?? ''
        element.value = attributes.value ?? ''
        element.checked = 'checked' in attributes
        element.disabled = 'disabled' in attributes
        element.open = 'open' in attributes
        made.set(id, element)
      }
      return made.get(id)
    }
  }
  return document
}

// An event on an element, passed up through its parents like a real one.
// Resolves once every handler it started (async ones too) has finished.
function fire (target, type, details = {}) {
  if (type === 'click' && target.type === 'checkbox') target.checked = !target.checked
  const event = {
    type,
    target,
    key: details.key,
    shiftKey: Boolean(details.shiftKey),
    preventDefault () {}
  }
  const running = []
  for (let node = target; node; node = node.parentNode) {
    for (const listener of node.listeners.get(type) ?? []) running.push(listener(event))
  }
  return Promise.all(running)
}

async function until (isReady, what) {
  for (let i = 0; i < 2000; i++) {
    if (isReady()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const JOURNAL = `${ROOT}/.zipify-organizer/journal-2026-11-21.json`

// The organizer routes, answering the way the contract says: a scan or a
// change reports "scanning"/"running" once, then that it's done.
// applyAnswer: what POST /organizer/apply answers ([0] = no answer at all)
function fakeServer ({ songs = SONGS, plan = movePlan, missingRoutes = false, applyAnswer, truncated = false } = {}) {
  const polls = new Map()
  let scans = 0
  const pollCount = (url) => {
    polls.set(url, (polls.get(url) ?? 0) + 1)
    return polls.get(url)
  }
  return (url, method, body) => {
    if (url === '/drives') return [200, [{ path: ROOT, name: 'PEN', freeBytes: 2 * 1024 ** 3 }]]
    if (url === '/pick-folder') return [200, { path: `${ROOT}/Picked` }]
    if (missingRoutes) return [404, undefined]
    if (url === '/organizer/scan' && method === 'POST') return [200, { scanId: `scan-${++scans}` }]
    if (url.startsWith('/organizer/scan/')) {
      if (pollCount(url) === 1) return [200, { status: 'scanning', scanned: 5, found: 3, root: ROOT, truncated: false }]
      return [200, { status: 'done', scanned: 9, found: songs.length, root: ROOT, truncated, songs }]
    }
    if (url === '/organizer/plan') return [200, plan(body)]
    if (url === '/organizer/apply') return applyAnswer ?? [200, { applyId: 'apply-1' }]
    if (url === '/organizer/undo') return [200, { applyId: 'undo-1' }]
    if (url.startsWith('/organizer/apply/')) {
      const total = 2
      if (pollCount(url) === 1) return [200, { status: 'running', done: 1, total, failed: [], journalPath: JOURNAL }]
      return [200, { status: 'done', done: total, total, failed: [], journalPath: JOURNAL }]
    }
    return [404, { error: `No route ${method} ${url}` }]
  }
}

// a plan moving each asked-for song into Organized/<artist>
function movePlan (body) {
  const byId = new Map(SONGS.map((s) => [s.id, s]))
  return {
    planId: 'plan-1',
    operations: body.songIds.map((id) => ({
      kind: 'move',
      from: byId.get(id).path,
      to: `${ROOT}/Organized/${byId.get(id).artist || 'Unknown Artist'}/${byId.get(id).fileName}`,
      songId: id
    })),
    conflicts: [],
    summary: { copies: 0, moves: body.songIds.length, renames: 0, folders: 1, skipped: 0 }
  }
}

function loadPage ({ server = fakeServer(), stored = {} } = {}) {
  const document = fakeDocument(HTML)
  const storage = new Map(Object.entries(stored))
  const requests = []
  const confirmations = []
  const context = {
    document,
    // the page polls every 700 ms; here no time passes
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    confirm (question) {
      confirmations.push(question)
      return true
    },
    addEventListener () {},
    async fetch (url, init = {}) {
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(init.body) : null
      requests.push({ url, method, body })
      const [status, json] = server(url, method, body)
      if (status === 0) throw new TypeError('Failed to fetch')
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (json === undefined ? JSON.parse('<!DOCTYPE html>') : json)
      }
    }
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context, { filename: 'organize.js' })
  const $ = (id) => document.getElementById(id)
  const rows = () => $('songBody').children
  const tick = (row, details) => fire(row.children[0].children[0], 'click', details)
  const titleOf = (row) => row.children[1].children[0].textContent
  return { $, rows, tick, titleOf, requests, confirmations, storage }
}

async function scanned (options) {
  const opened = loadPage(options)
  opened.$('folderPath').value = ROOT
  await fire(opened.$('scanButton'), 'click')
  return opened
}

test('the page: scanning a folder fills the table, and the filters narrow it', async () => {
  const { $, rows, titleOf, requests } = await scanned()

  assert.deepEqual(requests.find((request) => request.url === '/organizer/scan').body, { folder: ROOT, maxDepth: 4 })
  assert.equal($('libraryPanel').classList.contains('hidden'), false)
  assert.equal($('actionsPanel').classList.contains('hidden'), false)
  assert.equal($('scanStatus').textContent, 'Found 8 songs in 9 files.')
  assert.equal(rows().length, 8)
  assert.equal(titleOf(rows()[0]), 'Tum Hi Ho') // drive order: the top folder first
  assert.equal($('drivesBox').classList.contains('hidden'), false)
  assert.equal($('sortTarget').placeholder, `${ROOT}/Organized`)
  assert.equal($('filterArtist').children.length, 7) // any, no tag, five singers

  $('filterText').value = 'kesariya'
  await fire($('filterText'), 'input')
  await until(() => rows().length === 2, 'the search to narrow the table')
  assert.equal($('filterCount').textContent, '1 on')

  await fire($('clearFilters'), 'click')
  assert.equal(rows().length, 8)
  await fire($('sort-year'), 'click')
  await fire($('sort-year'), 'click')
  assert.equal($('head-year').getAttribute('aria-sort'), 'descending')
  assert.equal(titleOf(rows()[0]), 'Channa Mereya')
})

test('the page: ticks, shift-click ranges and select all act on the songs the filters show', async () => {
  const { $, rows, tick } = await scanned()

  await tick(rows()[0])
  await tick(rows()[3], { shiftKey: true })
  assert.equal($('selectionCount').textContent, '4 songs selected')
  assert.equal($('pageCheck').indeterminate, true)

  await fire($('untaggedOnly'), 'click')
  await fire($('untaggedOnly'), 'change')
  assert.equal($('selectionCount').textContent, 'No songs selected · 4 more are hidden by the filters and left out')

  await fire($('selectAll'), 'click')
  assert.match($('selectionCount').textContent, /^2 songs selected · 4 more/)
  await fire($('selectNone'), 'click')
  assert.equal($('selectionCount').textContent, 'No songs selected')
})

test('the page: a preview can be applied, the change undone, and the folder is read again after each', async () => {
  const { $, rows, tick, requests, confirmations, storage } = await scanned()
  await tick(rows()[0])
  await tick(rows()[2])
  $('sortMove').checked = true
  $('sortCopy').checked = false
  await fire($('sortMove'), 'change')

  assert.equal($('applyButton').disabled, true) // nothing previewed yet
  await fire($('previewButton'), 'click')
  const asked = requests.find((request) => request.url === '/organizer/plan').body
  assert.deepEqual(asked.songIds, [SONGS[0].id, SONGS[1].id]) // in the table's order
  assert.deepEqual(asked.options, { groupBy: '', mode: 'move' }) // the stand-in list has no options
  assert.equal($('planBox').classList.contains('hidden'), false)
  assert.equal($('planBody').children.length, 2)
  assert.equal($('applyButton').disabled, false)
  assert.equal($('applyButton').textContent, 'Apply 2 changes')

  await fire($('applyButton'), 'click')
  assert.equal(confirmations.length, 1) // moves ask first
  assert.deepEqual(requests.find((request) => request.url === '/organizer/apply').body, { planId: 'plan-1' })
  assert.equal($('changeResult').textContent, 'Done: 2 changes made.')
  assert.equal($('undoButton').classList.contains('hidden'), false)
  assert.equal(JSON.parse(storage.get('zipifyOrganizerLastChange')).journalPath, JOURNAL)

  const scans = () => requests.filter((request) => request.url === '/organizer/scan').length
  await until(() => scans() === 2 && !$('scanButton').disabled, 'the folder to be read again')
  assert.equal($('planBox').classList.contains('hidden'), true) // the used plan went with the old list

  await fire($('undoButton'), 'click')
  assert.equal(confirmations.length, 2)
  assert.deepEqual(requests.find((request) => request.url === '/organizer/undo').body, { journalPath: JOURNAL })
  assert.equal($('changeResult').textContent, 'Undone: everything is back as it was.')
  assert.equal($('undoButton').classList.contains('hidden'), true)
  assert.equal(storage.has('zipifyOrganizerLastChange'), false)
  await until(() => scans() === 3 && !$('scanButton').disabled, 'the folder to be read again after the undo')
})

test('the page: changing the ticked songs or an option clears the preview', async () => {
  const { $, rows, tick } = await scanned()
  await tick(rows()[0])
  await fire($('previewButton'), 'click')
  assert.equal($('planBox').classList.contains('hidden'), false)

  await tick(rows()[1])
  assert.equal($('planBox').classList.contains('hidden'), true)
  assert.equal($('applyButton').disabled, true)
  assert.match($('actionMessage').textContent, /preview was cleared/)

  await fire($('previewButton'), 'click')
  $('sortTarget').value = `${ROOT}/Sorted`
  await fire($('sortTarget'), 'input')
  assert.equal($('planBox').classList.contains('hidden'), true)
})

test('the page: a change only ever includes ticked songs the filters show', async () => {
  const { $, rows, tick, requests } = await scanned()
  await tick(rows()[0]) // Tum Hi Ho
  await tick(rows()[1]) // Halo
  $('filterText').value = 'halo'
  await fire($('filterText'), 'input')
  await until(() => rows().length === 1, 'the search to narrow the table')

  await fire($('previewButton'), 'click')
  const asked = requests.find((request) => request.url === '/organizer/plan').body
  assert.deepEqual(asked.songIds, [SONGS[7].id])
  assert.match($('selectionCount').textContent, /1 more is hidden by the filters and left out/)
})

test('the page: Apply sends a plan once, even when clicked twice', async () => {
  const { $, rows, tick, requests } = await scanned()
  await tick(rows()[0])
  await fire($('previewButton'), 'click')

  await Promise.all([fire($('applyButton'), 'click'), fire($('applyButton'), 'click')])
  assert.equal(requests.filter((request) => request.url === '/organizer/apply').length, 1)
})

test('the page: a plan the server refuses can be tried again; one with no answer cannot', async () => {
  const refused = await scanned({ server: fakeServer({ applyAnswer: [409, { error: 'Another change is running.' }] }) })
  await refused.tick(refused.rows()[0])
  await fire(refused.$('previewButton'), 'click')
  await fire(refused.$('applyButton'), 'click')
  assert.equal(refused.$('changeResult').textContent, "The change didn't start: Another change is running.")
  assert.equal(refused.$('applyButton').disabled, false)
  assert.equal(refused.$('undoButton').classList.contains('hidden'), true)

  // it may have started anyway, so a second click mustn't apply the plan again
  const silent = await scanned({ server: fakeServer({ applyAnswer: [0] }) })
  await silent.tick(silent.rows()[0])
  await fire(silent.$('previewButton'), 'click')
  await fire(silent.$('applyButton'), 'click')
  assert.match(silent.$('changeResult').textContent, /Lost touch with the server/)
  assert.equal(silent.$('applyButton').disabled, true)
})

test('the page: a problem with the options is said before anything is sent', async () => {
  const { $, rows, tick, requests } = await scanned()

  await fire($('previewButton'), 'click')
  assert.match($('actionMessage').textContent, /Tick the songs/)

  await tick(rows()[0])
  await fire($('tab-playlist'), 'click')
  await fire($('previewButton'), 'click')
  assert.equal($('actionMessage').textContent, 'Give the playlist a name.')
  assert.equal(requests.some((request) => request.url === '/organizer/plan'), false)
})

test('the page: the tabs follow the arrow keys, and the rename tab shows a live example', async () => {
  const { $, rows, tick } = await scanned()
  await tick(rows()[0])

  await fire($('tab-sort'), 'keydown', { key: 'ArrowRight' })
  assert.equal($('tab-rename').getAttribute('aria-selected'), 'true')
  assert.equal($('panel-rename').classList.contains('hidden'), false)
  assert.equal($('panel-sort').classList.contains('hidden'), true)
  assert.equal($('renameExample').textContent, 'Example: "Tum Hi Ho.mp3" becomes "Arijit Singh - Tum Hi Ho.mp3".')

  await fire($('token-track'), 'click')
  assert.equal($('renamePattern').value, '{artist} - {title}{track}')
  assert.match($('renameExample').textContent, /Tum Hi Ho03\.mp3/)

  await fire($('tab-rename'), 'keydown', { key: 'End' })
  assert.equal($('tab-dedupe').getAttribute('aria-selected'), 'true')
  await fire($('tab-dedupe'), 'keydown', { key: 'ArrowRight' })
  assert.equal($('tab-sort').getAttribute('aria-selected'), 'true') // wraps around
})

test('the page: "Tick all possible duplicates" filters and ticks them', async () => {
  const { $, rows } = await scanned()

  await fire($('selectDuplicates'), 'click')
  assert.equal($('duplicatesOnly').checked, true)
  assert.equal(rows().length, 2)
  assert.equal($('selectionCount').textContent, '2 songs selected')
  assert.match($('actionMessage').textContent, /Ticked 2 possible duplicates/)
})

test('the page: a change remembered from an earlier visit can still be undone, or forgotten', async () => {
  const record = { label: 'Sort into folders · 3 songs', journalPath: JOURNAL, root: ROOT, at: Date.now() }
  const stored = { zipifyOrganizerLastChange: JSON.stringify(record), zipifyOrganizerFolder: ROOT }
  const { $, requests, storage } = loadPage({ stored })

  assert.equal($('folderPath').value, ROOT)
  assert.equal($('changePanel').classList.contains('hidden'), false)
  assert.equal($('changeLabel').textContent, record.label)
  assert.equal($('undoButton').classList.contains('hidden'), false)

  await fire($('undoButton'), 'click')
  assert.deepEqual(requests.find((request) => request.url === '/organizer/undo').body, { journalPath: JOURNAL })
  assert.equal(storage.has('zipifyOrganizerLastChange'), false)

  const again = loadPage({ stored: { zipifyOrganizerLastChange: JSON.stringify(record) } })
  await fire(again.$('forgetButton'), 'click')
  assert.equal(again.$('changePanel').classList.contains('hidden'), true)
  assert.equal(again.storage.has('zipifyOrganizerLastChange'), false)
})

test('the page: a server without the organizer routes is reported in plain words', async () => {
  const { $ } = await scanned({ server: fakeServer({ missingRoutes: true }) })

  assert.equal($('scanStatus').dataset.state, 'error')
  assert.match($('scanStatus').textContent, /doesn't know this/)
  assert.equal($('scanButton').disabled, false)
  assert.equal($('libraryPanel').classList.contains('hidden'), true)
})

test('the page: a drive, Choose… or Enter reads the folder; a target folder only changes the plan', async () => {
  const { $, rows, tick, requests } = loadPage()
  const scans = () => requests.filter((request) => request.url === '/organizer/scan')
  const isIdle = () => !$('scanButton').disabled

  await until(() => $('driveChips').children.length === 1, 'the drive list')
  assert.equal($('driveChips').textContent, `PEN · ${(2).toFixed(1)} GB free`)
  await fire($('driveChips').children[0].children[0], 'click')
  await until(() => rows().length === 8 && isIdle(), 'the drive to be read')
  assert.equal(scans()[0].body.folder, ROOT)

  await tick(rows()[0])
  await fire($('previewButton'), 'click')
  await fire($('chooseSortTarget'), 'click')
  assert.equal($('sortTarget').value, `${ROOT}/Picked`)
  assert.equal($('planBox').classList.contains('hidden'), true)
  assert.equal(scans().length, 1)

  await fire($('chooseFolder'), 'click')
  await until(() => scans().length === 2 && isIdle(), 'the chosen folder to be read')
  assert.equal(scans()[1].body.folder, `${ROOT}/Picked`)

  $('folderPath').value = `${ROOT}/Hindi`
  await fire($('folderPath'), 'keydown', { key: 'Enter' })
  await until(() => scans().length === 3 && isIdle(), 'Enter to read the typed folder')
  assert.equal(scans()[2].body.folder, `${ROOT}/Hindi`)
})

test('the page: a scan the server stopped at its limit says so', async () => {
  const { $ } = await scanned({ server: fakeServer({ truncated: true }) })

  assert.match($('scanStatus').textContent, /Only the first .+ were read\./)
  assert.match($('summaryPills').textContent, /songs read at most/)
})

test('the page: a relative folder is caught before scanning', async () => {
  const { $, requests } = loadPage()
  $('folderPath').value = 'Music'
  await fire($('scanButton'), 'click')

  assert.match($('scanStatus').textContent, /full path/)
  assert.equal(requests.some((request) => request.url === '/organizer/scan'), false)
})
