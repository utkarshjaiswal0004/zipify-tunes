const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  looseText,
  splitArtists,
  normalizeVideo,
  scoreCandidate,
  isConfidentMatch,
  rankCandidates,
  parseDurationSec,
  buildSearchQueries
} = require('../matching')

const RAANJHANAA = { title: 'Raanjhanaa', artist: 'A.R. Rahman' }

function video (id, title, extra = {}) {
  return { videoId: id, title, channel: 'Some Channel', durationSec: 240, ...extra }
}

// --- text helpers (moved from server.js) ---

test('loose text drops brackets, "feat." and accents', () => {
  assert.equal(looseText('Beyoncé (Live) [2013 Remaster] feat. Someone'), 'beyonce')
})

test('artists are split on commas, ampersands and "feat."', () => {
  assert.deepEqual(splitArtists('Pritam,KK,Sayeed Quadri'), ['pritam', 'kk', 'sayeed quadri'])
  assert.deepEqual(splitArtists('Sanam Puri & Shipra Goyal feat. X'), ['sanam puri', 'shipra goyal', 'x'])
})

// --- scoring one search result ---

test('a label upload with the exact title and the artist is a confident good match', () => {
  const scored = scoreCandidate(
    video('a', 'Raanjhanaa - Lyrical Video | Dhanush, Sonam Kapoor | A. R. Rahman', {
      channel: 'T-Series'
    }),
    RAANJHANAA
  )

  assert.equal(scored.titleScore, 1)
  assert.equal(scored.artistMatch, true)
  assert.equal(scored.label, 'Good match')
  assert.equal(isConfidentMatch(scored), true)
})

test('a slowed / reverb edit is not taken for the original', () => {
  const original = scoreCandidate(video('a', 'Raanjhanaa | A. R. Rahman'), RAANJHANAA)
  const edit = scoreCandidate(video('b', 'Raanjhanaa (Slowed + Reverb) | A. R. Rahman'), RAANJHANAA)

  assert.deepEqual(edit.variant, ['slowed', 'reverb'])
  assert.equal(isConfidentMatch(edit), false)
  assert.ok(original.score > edit.score)
})

test('a variant the CSV itself asks for is fine', () => {
  const scored = scoreCandidate(video('a', 'KALYANI Remix | ARJN'), {
    title: 'KALYANI - Remix',
    artist: 'ARJN'
  })

  assert.deepEqual(scored.variant, [])
  assert.equal(isConfidentMatch(scored), true)
})

test('a different song is an unlikely, unconfident match', () => {
  const scored = scoreCandidate(video('a', 'Tera Ban Jaunga | Kabir Singh'), {
    title: 'Tum Hi Ho',
    artist: 'Arijit Singh'
  })

  assert.equal(scored.titleScore, 0)
  assert.equal(scored.label, 'Unlikely')
  assert.equal(isConfidentMatch(scored), false)
})

test('the song length from the CSV picks the right upload of the same title', () => {
  const wanted = { title: 'Song X', artist: 'Artist', durationSec: 225 }

  const ranked = rankCandidates(
    [
      video('long', 'Song X - Artist', { durationSec: 400 }),
      video('right', 'Song X - Artist', { durationSec: 226 })
    ],
    wanted
  )

  assert.equal(ranked[0].videoId, 'right')
  assert.equal(isConfidentMatch(ranked[1]), false, 'almost 3 minutes off')
})

test('an auto-generated "Artist - Topic" upload is preferred', () => {
  const wanted = { title: 'Baarishein', artist: 'Anuv Jain' }

  const ranked = rankCandidates(
    [
      video('fan', 'Baarishein Anuv Jain', { channel: 'Music Fan' }),
      video('topic', 'Baarishein', { channel: 'Anuv Jain - Topic' })
    ],
    wanted
  )

  assert.equal(ranked[0].videoId, 'topic')
})

test('an hour-long compilation is never a confident match for a song', () => {
  const scored = scoreCandidate(
    video('a', 'Raanjhanaa A. R. Rahman all songs', { durationSec: 3600 }),
    RAANJHANAA
  )

  assert.equal(isConfidentMatch(scored), false)
})

test('ranking drops repeated videos and puts the best first', () => {
  const ranked = rankCandidates(
    [
      video('x', 'Something Else'),
      video('a', 'Raanjhanaa | A. R. Rahman'),
      video('a', 'Raanjhanaa | A. R. Rahman')
    ],
    RAANJHANAA
  )

  assert.deepEqual(ranked.map((r) => r.videoId), ['a', 'x'])
})

// --- shapes and inputs ---

test('yt-search results are turned into one plain shape', () => {
  const result = normalizeVideo({
    videoId: 'abc123def45',
    url: 'https://youtube.com/watch?v=abc123def45',
    title: 'Title',
    author: { name: 'Channel' },
    seconds: 200,
    views: 5000,
    thumbnail: 'https://i.ytimg.com/vi/abc123def45/hq720.jpg'
  })

  assert.deepEqual(result, {
    videoId: 'abc123def45',
    url: 'https://youtube.com/watch?v=abc123def45',
    title: 'Title',
    channel: 'Channel',
    durationSec: 200,
    views: 5000,
    thumbnail: 'https://i.ytimg.com/vi/abc123def45/hq720.jpg'
  })
})

test('song lengths are read from m:ss, h:mm:ss, seconds or milliseconds', () => {
  assert.equal(parseDurationSec('3:45'), 225)
  assert.equal(parseDurationSec('1:02:03'), 3723)
  assert.equal(parseDurationSec('215000', { fromMs: true }), 215)
  assert.equal(parseDurationSec('215000'), 215, 'too long for seconds, so milliseconds')
  assert.equal(parseDurationSec('215'), 215)
  assert.equal(parseDurationSec(''), null)
  assert.equal(parseDurationSec('abc'), null)
})

test('a wider search tries the plain title, the main artist and audio/lyrics uploads', () => {
  const queries = buildSearchQueries({
    title: 'Tumse Behtar (From "Sunny Sanskari Ki Tulsi Kumari")',
    artist: 'Arijit Singh, Sachin-Jigar',
    album: ''
  })

  assert.equal(queries[0], 'Tumse Behtar (From "Sunny Sanskari Ki Tulsi Kumari") Arijit Singh, Sachin-Jigar')
  assert.ok(queries.includes('Tumse Behtar Arijit Singh'))
  assert.ok(queries.includes('Tumse Behtar Arijit Singh official audio'))
  assert.ok(queries.includes('Tumse Behtar Arijit Singh lyrics'))
  assert.equal(new Set(queries.map((q) => q.toLowerCase())).size, queries.length, 'no repeats')
})
