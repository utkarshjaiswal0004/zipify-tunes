// ZipifyTunes · Organize: scan a folder or pen drive for MP3s, narrow the
// list down with filters, then sort the ticked songs into folders, rename
// them from their tags, gather them into a playlist folder, or move extra
// copies aside. Nothing on the drive changes until a plan has been previewed
// and applied, and an applied change can be undone from the journal the
// server writes as it goes.
//
// Server routes (JSON; an error answers { error }):
//   POST /organizer/scan { folder, maxDepth }  -> { scanId }
//   GET  /organizer/scan/:id  -> { status: scanning|done|error, scanned, found, error?, root, songs? }
//   POST /organizer/plan { scanId, songIds, action, options }
//     -> { planId, operations: [{ kind, from?, to, songId? }],
//          conflicts: [{ songId, reason }], summary: { copies, moves, renames, folders, skipped } }
//   POST /organizer/apply { planId }  -> { applyId }
//   GET  /organizer/apply/:id  -> { status: running|done|error, done, total,
//                                   failed: [{ operation, error }], journalPath }
//   POST /organizer/undo { journalPath }  -> { applyId }, followed like an apply
// plus GET /drives and POST /pick-folder, shared with the main page.
//
// A scanned Song: { id, path, relPath, folder, fileName, size, title, artist,
// album, year, genre, track, durationSec|null, hasCover, tagged }

const POLL_MS = 700;
const ROWS_PER_PAGE = 200;
const PLAN_ROWS_STEP = 200;
// a long list of skipped songs or failures ends with "…and N more"
const MAX_LISTED = 100;
const DEFAULT_DEPTH = 4;
const MIN_DEPTH = 1;
const MAX_DEPTH = 6;
// the server reads at most this many songs from one folder
const MAX_SONGS = 20000;
const FILTER_DEBOUNCE_MS = 150;
// A change carries on at the server when one poll fails, so the page gives
// the connection a few tries before it says it lost track.
const MAX_POLL_FAILURES = 5;
// the server's Clean duplicates rule: lengths further apart than this are
// different recordings (a live take, an extended mix)
const DUPLICATE_GAP_SEC = 10;
// "01"…"09" sort before "10", as with trackPrefixWidth in playlist-files.js
const MIN_TRACK_DIGITS = 2;
// the longest file name the server makes (FAT32 allows 255)
const MAX_NAME_LENGTH = 200;

const JSON_HEADERS = { "Content-Type": "application/json" };
// A list filter's value: "" for any, NO_VALUE for songs without the tag, or
// CHOICE_PREFIX + a key. The prefix keeps a real tag named "none" apart.
const NO_VALUE = "none";
const CHOICE_PREFIX = "is:";
// Song ids are hashes. Anything else is left out rather than put into a
// selector or sent back to the server.
const SONG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// FAT32 (and Windows) refuse these in names, and control characters
const UNSAFE_NAME_CHARS = /[\/\\:*?"<>|\p{Cc}]/gu;
// Windows keeps these names for devices; the server adds "_" to them
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const TOKEN_PATTERN = /\{([^{}]*)\}/g;
// What the page says about songs, it says the way the server's planner
// (organizer/plan.js) decides them, so a hint never promises what a plan
// won't do. The main artist is the name before a comma, ";" or "feat.":
// "&" and "/" stay, as "Simon & Garfunkel" and "AC/DC" are one act.
const ARTIST_SPLIT = /\s*[,;]\s*|\s+[([]?(?:feat\.?|ft\.?|featuring)\s+/i;
// Words that mark another version of a song (VARIANT_WORDS in matching.js):
// "Tum Hi Ho (Live)" shares a loose title with "Tum Hi Ho" but is no copy.
const VERSION_WORDS = [
  "live", "cover", "remix", "karaoke", "instrumental", "8d", "slowed", "reverb", "sped up",
  "nightcore", "lofi", "lo fi", "acoustic", "reaction", "teaser", "trailer", "1 hour", "loop",
  "mashup", "jukebox", "tutorial", "status", "shorts",
];
const TOKEN_LABELS = {
  artist: "artist",
  title: "title",
  album: "album",
  year: "year",
  genre: "genre",
  track: "track number",
};

// kept in this browser so a change can still be undone after a reload
const LAST_CHANGE_KEY = "zipifyOrganizerLastChange";
const FOLDER_KEY = "zipifyOrganizerFolder";

const TOKENS = ["artist", "title", "album", "year", "genre", "track"];
const ACTIONS = ["sort", "rename", "playlist", "dedupe"];
const ACTION_NAMES = {
  sort: "Sort into folders",
  rename: "Rename files",
  playlist: "Make a playlist",
  dedupe: "Clean duplicates",
};
const KIND_LABELS = {
  copy: "Copy",
  move: "Move",
  rename: "Rename",
  mkdir: "New folder",
  "write-m3u": "Playlist file",
};
const SUMMARY_KEYS = ["copies", "moves", "renames", "folders", "skipped"];
// the plan's counts as pills: [count, one, many, color]
const PLAN_COUNTS = [
  ["copies", "song to copy", "songs to copy", "info"],
  ["moves", "song to move", "songs to move", "warn"],
  ["renames", "song to rename", "songs to rename", ""],
  ["folders", "new folder", "new folders", ""],
  ["playlists", "playlist file", "playlist files", "ok"],
  ["skipped", "song skipped", "songs skipped", "warn"],
];
// a sort direction in words, per column: [ascending, descending]
const SORT_WORDS = {
  title: ["A to Z", "Z to A"],
  artist: ["A to Z", "Z to A"],
  album: ["A to Z", "Z to A"],
  genre: ["A to Z", "Z to A"],
  folder: ["A to Z", "Z to A"],
  year: ["oldest first", "newest first"],
  length: ["shortest first", "longest first"],
  size: ["smallest first", "largest first"],
};

// the filter card's fields: typed ones wait for a pause in typing
const TYPED_FILTERS = {
  text: "filterText",
  yearFrom: "yearFrom",
  yearTo: "yearTo",
  minLength: "minLength",
  maxLength: "maxLength",
};
const PICKED_FILTERS = {
  artist: "filterArtist",
  album: "filterAlbum",
  genre: "filterGenre",
  folder: "filterFolder",
};
const FILTER_BOXES = { isUntaggedOnly: "untaggedOnly", isDuplicatesOnly: "duplicatesOnly" };

// every option a plan reads; changing one clears the preview
const ACTION_INPUT_IDS = [
  "groupBy", "sortTarget", "sortCopy", "sortMove", "renamePattern", "playlistName",
  "playlistTarget", "playlistCopy", "playlistMove", "numberTracks", "writePlaylist",
  "keepLargest", "keepFirst", "keepNewest",
];
const KEEP_CHOICES = { largest: "keepLargest", first: "keepFirst", newest: "keepNewest" };
const CHOOSE_BUTTON_IDS = ["chooseFolder", "chooseSortTarget", "choosePlaylistTarget"];

const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// --- page state: each value is replaced, never edited in place ---

// the last scan, see buildLibrary
let library = null;
// how the table is filtered, sorted and paged
let view = { filters: emptyFilters(), sort: { key: "folder", isDescending: false }, page: 0 };
// Ticked song ids. A change acts on the ticked songs the filters show, in
// the table's order, so a song hidden by a filter is never changed unseen.
let selected = new Set();
let lastTickedId = null; // where a shift-click range starts
let activeAction = "sort";
// The plan on show, with the request it answered as `signature`: any change
// to the songs or options no longer matches it, and the preview is cleared.
let preview = null;
let shownPreview = null; // the preview the plan table was last drawn for
// the change being applied or undone, or the last one (see changeRecord)
let change = null;
let isScanning = false;
let isPlanning = false;
// a newer scan or change makes the older one's polls stop quietly
let scanToken = 0;
let changeToken = 0;
let filterTimer = null;
// the sorted songs and the filtered ones, worked out again only when their inputs change
let sortedCache = { library: null, sort: null, entries: [] };
let visibleCache = { sorted: null, filters: null, entries: [] };

// --- small helpers ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function plural(count, one, many) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  if (bytes >= 10 * 1024 ** 2) return Math.round(bytes / 1024 ** 2) + " MB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

// 245 -> "4:05", 3723 -> "1:02:03"; unknown -> ""
function formatLength(seconds) {
  if (seconds == null) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function cleanTag(value) {
  return value == null ? "" : String(value).trim();
}

function isBlank(value) {
  return value == null || value === "";
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// the ids the server hands out, as text; null when there is none
function idOf(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

// --- loose text, in step with matching.js (the tests compare the two) ---

// lowercase with accents removed: "Beyoncé" -> "beyonce"
function foldText(text) {
  return String(text ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

// looseText from matching.js: bracketed bits and "feat. …" dropped,
// punctuation flattened ("Tum Hi Ho (From "Aashiqui 2")" -> "tum hi ho")
function looseText(text) {
  return foldText(text)
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(feat|ft)\.?\s.*$/, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// plainText from matching.js: like looseText, but bracketed words stay, as
// they often say "(Live)" or "[Slowed + Reverb]"
function plainText(text) {
  return foldText(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// "Pritam, Arijit Singh feat. KK" -> ["Pritam", "Arijit Singh", "KK"]: the
// artist filter lists each singer once, so picking one finds their duets too.
// The first name is the main artist.
function artistNames(artist) {
  const names = String(artist ?? "")
    .split(ARTIST_SPLIT)
    // "Song Artist (feat. KK)" leaves "KK)" behind
    .map((name) => name.trim().replace(/^([^([]*)[)\]]+$/, "$1").trim())
    .filter(Boolean);
  return names.filter((name, i) => names.findIndex((other) => foldText(other) === foldText(name)) === i);
}

// the main artist, compared loosely: "Pritam, KK" -> "pritam"
function mainArtistKey(artist) {
  const main = String(artist ?? "").split(ARTIST_SPLIT).map((name) => name.trim()).find(Boolean) ?? "";
  return looseText(main);
}

// the version words a title has, as one comparable text ("" for the song itself)
function versionOf(title) {
  const text = ` ${plainText(title)} `;
  return VERSION_WORDS.filter((word) => text.includes(` ${word} `)).join("|");
}

// --- paths ---

function isFullPath(text) {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(text);
}

function joinPath(folder, name) {
  return `${folder.replace(/[\\/]+$/, "")}/${name}`;
}

function baseName(filePath) {
  return String(filePath).split(/[\\/]/).pop();
}

// a path inside the scanned folder, shown from there: "Hindi/Tum Hi Ho.mp3"
function shortPath(filePath, root) {
  const text = cleanTag(filePath);
  const base = cleanTag(root).replace(/[\\/]+$/, "");
  if (!base || !text) return text;
  if (text === base) return "(the scanned folder)";
  const isInside = text.startsWith(`${base}/`) || text.startsWith(`${base}\\`);
  return isInside ? text.slice(base.length + 1) : text;
}

function normalizeFolder(folder) {
  return cleanTag(folder).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

// "Hindi/2010/Party" -> ["Hindi", "Hindi/2010", "Hindi/2010/Party"]: picking a
// folder in the filter shows the songs in the folders inside it too
function folderChain(folder) {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

// --- the scanned songs ---

function fileStem(fileName) {
  return String(fileName).replace(/\.mp3$/i, "");
}

// "07 - Tum Hi Ho" -> "Tum Hi Ho": a track number this app added isn't part of the title
function stripTrackPrefix(name) {
  return name.replace(/^\d{1,4} - /, "");
}

// "2013-05-01" -> 2013
function yearOf(value) {
  const match = /\d{4}/.exec(cleanTag(value));
  return match ? Number(match[0]) : null;
}

// "3/12" -> 3
function trackOf(value) {
  const number = Number.parseInt(cleanTag(value), 10);
  return number > 0 ? number : null;
}

function isSongLike(value) {
  return isObject(value) && typeof value.id === "string" && SONG_ID_PATTERN.test(value.id);
}

// The fields the page uses, each in a known shape: the scan reads tags from
// files on a drive, so anything may be missing or odd.
function cleanSong(raw) {
  const title = cleanTag(raw.title);
  const artist = cleanTag(raw.artist);
  return {
    id: raw.id,
    path: cleanTag(raw.path),
    relPath: cleanTag(raw.relPath),
    folder: cleanTag(raw.folder),
    fileName: cleanTag(raw.fileName) || baseName(cleanTag(raw.path)),
    size: wholeNumber(raw.size),
    title,
    artist,
    album: cleanTag(raw.album),
    year: cleanTag(raw.year),
    genre: cleanTag(raw.genre),
    track: cleanTag(raw.track),
    durationSec: Number(raw.durationSec) > 0 ? Number(raw.durationSec) : null,
    hasCover: raw.hasCover === true,
    tagged: typeof raw.tagged === "boolean" ? raw.tagged : Boolean(title && artist),
  };
}

// a song plus what filtering and sorting need, worked out once per scan
function songEntry(song) {
  const folder = normalizeFolder(song.folder);
  const artists = artistNames(song.artist);
  return {
    song,
    // an untagged song goes by its file name
    title: song.title || stripTrackPrefix(fileStem(song.fileName)),
    artists,
    artistKeys: artists.map(foldText),
    albumKey: foldText(song.album),
    genreKey: foldText(song.genre),
    folder,
    folderKeys: folderChain(folder),
    year: yearOf(song.year),
    track: trackOf(song.track),
    searchText: foldText([song.title, song.artist, song.album, song.fileName].join(" ")),
    version: versionOf(song.title),
    isDuplicate: false,
  };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    if (groups.has(key)) groups.get(key).push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

// What two copies of a song share: loose title and loose main artist. A song
// without both tags is never called a copy: the server won't set it aside.
function duplicateKey(entry) {
  const title = looseText(entry.song.title);
  const artist = mainArtistKey(entry.song.artist);
  return title && artist ? `${title}\u0001${artist}` : null;
}

function isCloseInLength(a, b) {
  if (a.durationSec == null || b.durationSec == null) return true;
  return Math.abs(a.durationSec - b.durationSec) <= DUPLICATE_GAP_SEC;
}

// the same length (give or take) and no version word one has and the other lacks
function isSameRecording(a, b) {
  return isCloseInLength(a.song, b.song) && a.version === b.version;
}

// Songs sharing a key, in groups whose members all match one another: each
// song joins the first group it fits, as on the server. Lengths of 200, 208
// and 216 s make two recordings, not one.
function recordingGroups(entries) {
  const groups = [];
  for (const entry of entries) {
    const group = groups.find((members) => members.every((member) => isSameRecording(member, entry)));
    if (group) group.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

// ids of the songs that look like another song in the list
function duplicateIds(entries) {
  const ids = new Set();
  for (const sameKey of groupBy(entries, duplicateKey).values()) {
    for (const group of recordingGroups(sameKey)) {
      if (group.length > 1) group.forEach((entry) => ids.add(entry.song.id));
    }
  }
  return ids;
}

function librarySummary(entries, duplicateCount) {
  const distinct = (keysOf) => new Set(entries.flatMap(keysOf)).size;
  return {
    songs: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.song.size, 0),
    artists: distinct((entry) => entry.artistKeys),
    albums: distinct((entry) => (entry.albumKey ? [entry.albumKey] : [])),
    folders: new Set(entries.map((entry) => entry.folder)).size,
    untagged: entries.filter((entry) => !entry.song.tagged).length,
    duplicates: duplicateCount,
  };
}

function buildLibrary(scanId, root, depth, rawSongs) {
  const songs = (Array.isArray(rawSongs) ? rawSongs : []).filter(isSongLike).map(cleanSong);
  const plain = songs.map(songEntry);
  const twins = duplicateIds(plain);
  const entries = plain.map((entry) => (twins.has(entry.song.id) ? { ...entry, isDuplicate: true } : entry));
  return {
    scanId,
    root,
    depth,
    entries,
    byId: new Map(entries.map((entry) => [entry.song.id, entry])),
    summary: librarySummary(entries, twins.size),
    isCapped: songs.length >= MAX_SONGS,
  };
}

// --- filters ---

function emptyFilters() {
  return {
    text: "",
    artist: "",
    album: "",
    genre: "",
    folder: "",
    yearFrom: "",
    yearTo: "",
    minLength: "",
    maxLength: "",
    isUntaggedOnly: false,
    isDuplicatesOnly: false,
  };
}

// The lists of the filter card. A song's keys are what a choice matches;
// labels are what the list shows (the first spelling seen of each key).
const CHOICE_FILTERS = {
  artist: {
    anyText: "Any artist",
    noneText: "No artist tag",
    keys: (entry) => entry.artistKeys,
    labels: (entry) => entry.artists,
  },
  album: {
    anyText: "Any album",
    noneText: "No album tag",
    keys: (entry) => (entry.albumKey ? [entry.albumKey] : []),
    labels: (entry) => [entry.song.album],
  },
  genre: {
    anyText: "Any genre",
    noneText: "No genre tag",
    keys: (entry) => (entry.genreKey ? [entry.genreKey] : []),
    labels: (entry) => [entry.song.genre],
  },
  folder: {
    anyText: "Any folder",
    noneText: "Only the top folder",
    keys: (entry) => entry.folderKeys,
    labels: (entry) => entry.folderKeys,
  },
};

// each value once, in name order, with how many songs have it; plus how
// many songs have none
function filterChoices(entries, filter) {
  const choices = new Map();
  let blanks = 0;
  for (const entry of entries) {
    const keys = filter.keys(entry);
    const labels = filter.labels(entry);
    if (keys.length === 0) blanks += 1;
    keys.forEach((key, i) => {
      const known = choices.get(key);
      choices.set(key, { key, label: known ? known.label : labels[i], count: (known ? known.count : 0) + 1 });
    });
  }
  const sorted = [...choices.values()].sort((a, b) => collator.compare(a.label, b.label));
  return { choices: sorted, blanks };
}

function numberOrNull(text) {
  const number = Number.parseFloat(cleanTag(text).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function minutesToSeconds(text) {
  const minutes = numberOrNull(text);
  return minutes == null ? null : minutes * 60;
}

// every word somewhere in the title, artist, album or file name
function wordsCheck(text) {
  const words = foldText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return (entry) => words.every((word) => entry.searchText.includes(word));
}

function choiceCheck(filter, value) {
  if (!value) return null;
  if (value === NO_VALUE) return (entry) => filter.keys(entry).length === 0;
  const key = value.startsWith(CHOICE_PREFIX) ? value.slice(CHOICE_PREFIX.length) : value;
  return (entry) => filter.keys(entry).includes(key);
}

// Once a range is set, a song without the value (no year tag, an unknown
// length) is left out: it can't be shown to be inside the range.
function rangeCheck(valueOf, min, max) {
  if (min == null && max == null) return null;
  return (entry) => {
    const value = valueOf(entry);
    return value != null && (min == null || value >= min) && (max == null || value <= max);
  };
}

function songMatcher(filters) {
  const checks = [
    wordsCheck(filters.text),
    ...Object.keys(CHOICE_FILTERS).map((name) => choiceCheck(CHOICE_FILTERS[name], filters[name])),
    rangeCheck((entry) => entry.year, numberOrNull(filters.yearFrom), numberOrNull(filters.yearTo)),
    rangeCheck(
      (entry) => entry.song.durationSec,
      minutesToSeconds(filters.minLength),
      minutesToSeconds(filters.maxLength)
    ),
    filters.isUntaggedOnly ? (entry) => !entry.song.tagged : null,
    filters.isDuplicatesOnly ? (entry) => entry.isDuplicate : null,
  ].filter(Boolean);
  return (entry) => checks.every((check) => check(entry));
}

function activeFilterCount(filters) {
  const empty = emptyFilters();
  return Object.keys(empty).filter((name) => filters[name] !== empty[name]).length;
}

// --- sorting ---

const SORT_VALUES = {
  title: (entry) => entry.title,
  artist: (entry) => entry.song.artist,
  album: (entry) => entry.song.album,
  year: (entry) => entry.year,
  genre: (entry) => entry.song.genre,
  length: (entry) => entry.song.durationSec,
  size: (entry) => entry.song.size,
  // with a leading "/", songs at the top of the folder ("") come first
  // instead of with the blanks
  folder: (entry) => `/${entry.folder}`,
};

function compareBy(valueOf, direction) {
  return (a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    // blanks go last either way: a missing year is not "oldest"
    if (isBlank(x) || isBlank(y)) return Number(isBlank(x)) - Number(isBlank(y));
    const order = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
    return direction * order;
  };
}

// equal songs keep the order they have on the drive: folder, track, file name
const TIE_BREAKS = [
  compareBy(SORT_VALUES.folder, 1),
  compareBy((entry) => entry.track, 1),
  compareBy((entry) => entry.song.fileName, 1),
];

function sortEntries(entries, sort) {
  const primary = compareBy(SORT_VALUES[sort.key] ?? SORT_VALUES.folder, sort.isDescending ? -1 : 1);
  const comparators = [primary, ...TIE_BREAKS];
  return [...entries].sort((a, b) => {
    for (const compare of comparators) {
      const order = compare(a, b);
      if (order !== 0) return order;
    }
    return 0;
  });
}

// the same column again flips the direction; a new column starts ascending
function nextSort(sort, key) {
  return { key, isDescending: sort.key === key ? !sort.isDescending : false };
}

// --- the table's songs, selection and pages ---

function sortedEntries() {
  if (sortedCache.library !== library || sortedCache.sort !== view.sort) {
    const entries = library ? sortEntries(library.entries, view.sort) : [];
    sortedCache = { library, sort: view.sort, entries };
  }
  return sortedCache.entries;
}

function visibleEntries() {
  const sorted = sortedEntries();
  if (visibleCache.sorted !== sorted || visibleCache.filters !== view.filters) {
    visibleCache = { sorted, filters: view.filters, entries: sorted.filter(songMatcher(view.filters)) };
  }
  return visibleCache.entries;
}

// the ticked songs the filters show, in the table's order: what a change acts on
function chosenEntries() {
  return visibleEntries().filter((entry) => selected.has(entry.song.id));
}

function visibleIds() {
  return visibleEntries().map((entry) => entry.song.id);
}

function withIds(set, ids, isOn) {
  const next = new Set(set);
  for (const id of ids) {
    if (isOn) next.add(id);
    else next.delete(id);
  }
  return next;
}

function invertIds(set, ids) {
  const next = new Set(set);
  for (const id of ids) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

// the ids from one row to another, both included, in the table's order (shift-click)
function idsBetween(entries, fromId, toId) {
  const from = entries.findIndex((entry) => entry.song.id === fromId);
  const to = entries.findIndex((entry) => entry.song.id === toId);
  if (from < 0 || to < 0) return [toId];
  return entries.slice(Math.min(from, to), Math.max(from, to) + 1).map((entry) => entry.song.id);
}

function pageInfo(total, page, perPage = ROWS_PER_PAGE) {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return { page: current, pageCount, start: current * perPage, end: Math.min(total, (current + 1) * perPage) };
}

function selectionText(chosen, hidden) {
  const main = chosen ? `${plural(chosen, "song", "songs")} selected` : "No songs selected";
  return hidden ? `${main} · ${plural(hidden, "more is", "more are")} hidden by the filters and left out` : main;
}

function tableStatusText(info, shown, all) {
  if (shown === 0) return `No songs match the filters (${plural(all, "song", "songs")} in all).`;
  const range = `${(info.start + 1).toLocaleString()}–${info.end.toLocaleString()}`;
  if (shown === all) return `Showing ${range} of ${plural(all, "song", "songs")}.`;
  return `Showing ${range} of ${plural(shown, "matching song", "matching songs")} (${all.toLocaleString()} in all).`;
}

// --- plans: what each tab asks the server for ---

// an empty folder field lets the server use its default
function withTarget(options, folder) {
  const target = cleanTag(folder);
  return target ? { ...options, targetFolder: target } : options;
}

// form: the tab fields as readActionForm reads them
function planOptions(action, form) {
  if (action === "sort") return withTarget({ groupBy: form.groupBy, mode: form.sortMode }, form.sortTarget);
  if (action === "rename") return { pattern: form.pattern.trim() };
  if (action === "playlist") {
    const options = {
      name: form.playlistName.trim(),
      mode: form.playlistMode,
      numberTracks: form.numberTracks,
      writePlaylist: form.writePlaylist,
    };
    return withTarget(options, form.playlistTarget);
  }
  return { keep: form.keep };
}

function planRequest(scanId, action, form, songIds) {
  return { scanId, songIds, action, options: planOptions(action, form) };
}

function tokensIn(pattern) {
  return [...String(pattern).matchAll(TOKEN_PATTERN)].map((match) => match[1]);
}

function patternProblem(pattern) {
  const tokens = tokensIn(pattern);
  const unknown = tokens.find((token) => !TOKENS.includes(token));
  if (unknown != null) return `"{${unknown}}" isn't a tag this can fill in. Use the buttons under the name.`;
  if (tokens.length === 0) return "Put at least one tag in the name, such as {title}, so each song gets its own name.";
  return null;
}

// what's wrong with a request before it goes to the server, or null
function requestProblem({ action, songIds, options }) {
  if (songIds.length === 0) return "Tick the songs to change in the table first.";
  if (action === "dedupe" && songIds.length < 2) return "Tick at least two songs to look for copies among.";
  if (options.targetFolder != null && !isFullPath(options.targetFolder)) {
    return "Type the folder as a full path, like /Volumes/PEN/Music, or click Choose….";
  }
  if (action === "rename") return patternProblem(options.pattern);
  if (action === "playlist" && !options.name) return "Give the playlist a name.";
  return null;
}

function tokenValue(entry, token, width) {
  if (token === "track") return entry.track ? String(entry.track).padStart(width, "0") : "";
  if (token === "year") return entry.year ? String(entry.year) : "";
  return cleanTag(entry.song[token]);
}

// cut to at most maxChars UTF-16 units (what FAT32 counts), never inside an emoji
function cutToChars(text, maxChars) {
  if (text.length <= maxChars) return text;
  let end = 0;
  for (const char of text) {
    if (end + char.length > maxChars) break;
    end += char.length;
  }
  return text.slice(0, end);
}

// Windows drops trailing dots and spaces, so "Song." and "Song" would clash
function trimName(name) {
  return name.replace(/[.\s]+$/, "");
}

// A name a FAT32 drive takes, made the way the server makes it (safeName in
// organizer/plan.js): unsafe characters become spaces, no leading dot (it
// hides the file), no trailing dot or space, 200 characters at most.
function safeName(text) {
  const cleaned = String(text ?? "")
    .normalize("NFC")
    .replace(UNSAFE_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "");
  const name = trimName(cutToChars(cleaned, MAX_NAME_LENGTH));
  return name && RESERVED_NAME.test(name) ? `${name}_` : name;
}

// "<safe base><ext>" within the length limit, or "" when nothing is left
function safeFileName(base, ext) {
  const name = safeName(base);
  return name ? `${trimName(cutToChars(name, MAX_NAME_LENGTH - ext.length))}${ext}` : "";
}

// a song keeps its own extension, whatever its case: "SONG.MP3" -> ".MP3"
function extensionOf(fileName) {
  return /\.[^.\\/]+$/.exec(fileName)?.[0] ?? ".mp3";
}

// {track} is padded to the highest track number among the songs, as on the
// server: 7 next to a 12 is "07", next to a 120 it's "007"
function trackWidth(entries) {
  const highest = entries.reduce((max, entry) => Math.max(max, entry.track ?? 0), 0);
  return Math.max(MIN_TRACK_DIGITS, String(highest).length);
}

// the tags a pattern fills in, each once
function usedTokens(pattern) {
  return [...new Set(tokensIn(pattern).filter((token) => TOKENS.includes(token)))];
}

// the used tags a song has no value for: the server skips such a song
function missingTags(entry, used, width) {
  return used.filter((token) => !tokenValue(entry, token, width));
}

// What the pattern makes of one song: { name }, or { skip: why } when the
// server would leave the song alone (a tag missing, an empty name, no change).
function renameExample(entry, pattern, width) {
  const missing = missingTags(entry, usedTokens(pattern), width);
  if (missing.length) return { skip: `it has no ${TOKEN_LABELS[missing[0]]} tag` };
  const filled = pattern.replace(TOKEN_PATTERN, (whole, token) =>
    TOKENS.includes(token) ? tokenValue(entry, token, width) : whole
  );
  const name = safeFileName(filled, extensionOf(entry.song.fileName));
  if (!name) return { skip: "the new name would be empty" };
  if (name === entry.song.fileName) return { skip: "it already has that name" };
  return { name };
}

function renameExampleText(entries, pattern) {
  const trimmed = pattern.trim();
  const problem = patternProblem(trimmed);
  if (problem) return { text: problem, kind: "warn" };
  if (entries.length === 0) return { text: "Tick a song in the table to see its new name here.", kind: "" };

  const width = trackWidth(entries);
  // the pattern is read once, not once per song: thousands may be ticked
  const used = usedTokens(trimmed);
  const lacking = entries.filter((entry) => missingTags(entry, used, width).length > 0).length;
  const first = renameExample(entries[0], trimmed, width);
  const fileName = entries[0].song.fileName;
  const firstText = first.skip
    ? `"${fileName}" would be skipped: ${first.skip}.`
    : `Example: "${fileName}" becomes "${first.name}".`;
  const firstLacks = missingTags(entries[0], used, width).length > 0;
  const others = lacking - (firstLacks ? 1 : 0);
  if (others === 0) return { text: firstText, kind: first.skip ? "warn" : "" };
  const othersText = firstLacks
    ? `${plural(others, "other ticked song lacks", "other ticked songs lack")} a tag it uses too.`
    : `${plural(others, "ticked song lacks", "ticked songs lack")} a tag it uses and would be skipped.`;
  return { text: `${firstText} ${othersText}`, kind: "warn" };
}

function orderText(sort) {
  const words = SORT_WORDS[sort.key] ?? SORT_WORDS.folder;
  return `Songs go in the order the table shows: by ${sort.key}, ${words[sort.isDescending ? 1 : 0]}. ` +
    "Click a column heading to change it.";
}

// the server's plan in a known shape; a plan without an id can't be applied
function cleanPlan(body) {
  const planId = idOf(body?.planId);
  if (!planId || !Array.isArray(body.operations)) {
    throw new Error("The server's preview came back in a shape this page doesn't understand.");
  }
  const summary = isObject(body.summary) ? body.summary : {};
  return {
    planId,
    operations: body.operations.filter(isObject),
    conflicts: Array.isArray(body.conflicts) ? body.conflicts.filter(isObject) : [],
    summary: Object.fromEntries(SUMMARY_KEYS.map((key) => [key, wholeNumber(summary[key])])),
  };
}

function planCounts(plan) {
  const counts = { ...plan.summary, playlists: plan.operations.filter((op) => op.kind === "write-m3u").length };
  return PLAN_COUNTS.filter(([key]) => counts[key] > 0).map(([key, one, many, kind]) => ({
    value: counts[key].toLocaleString(),
    words: counts[key] === 1 ? one : many,
    kind,
  }));
}

// One plan step as a table row shows it. Paths read from the scanned folder;
// a rename shows just the old and new names, as the folder stays the same.
function describeOperation(operation, root) {
  const kind = cleanTag(operation?.kind);
  const from = cleanTag(operation?.from);
  const to = cleanTag(operation?.to);
  const isRename = kind === "rename";
  return {
    kind,
    label: KIND_LABELS[kind] ?? kind,
    from: isRename && from ? baseName(from) : shortPath(from, root),
    to: isRename && to ? baseName(to) : shortPath(to, root),
    fromFull: from,
    toFull: to,
  };
}

// Moves and renames change where a person's songs are, so they ask first;
// copies only add files.
function confirmText(plan) {
  const moves = plan.operations.filter((op) => op.kind === "move").length;
  const renames = plan.operations.filter((op) => op.kind === "rename").length;
  if (moves === 0 && renames === 0) return null;
  const what = [
    moves ? `move ${plural(moves, "song", "songs")}` : "",
    renames ? `rename ${plural(renames, "song", "songs")}` : "",
  ].filter(Boolean).join(" and ");
  return `This will ${what} on the drive. Nothing is deleted, and you can undo it afterwards. Go ahead?`;
}

function previewReadyText(plan) {
  const steps = plan.operations.length;
  if (steps > 0) {
    return {
      text: `Preview ready: ${plural(steps, "change", "changes")}. Nothing has changed yet; check the list, then click Apply.`,
      kind: "ok",
    };
  }
  const skipped = plan.conflicts.length;
  const why = skipped
    ? `${plural(skipped, "song was", "songs were")} skipped (see why below).`
    : "the songs are already where and how they should be.";
  return { text: `Nothing to change: ${why}`, kind: "warn" };
}

// Scans and plans are kept for 30 minutes, then the server answers 404; once
// a change has moved songs, an older scan or plan gets 409. Either way the
// cure is to read the folder again.
function planErrorText(error) {
  const isOutOfDate = error.status === 404 || error.status === 409;
  return isOutOfDate ? `${error.message} Click Scan to read the folder again, then Preview.` : error.message;
}

function changeLabel(plan) {
  return `${ACTION_NAMES[plan.action] ?? "Change"} · ${plural(plan.songCount, "song", "songs")}`;
}

// --- changes: an apply or an undo, followed until it stops ---

function changeRecord(fields) {
  return {
    kind: "apply",
    label: "",
    journalPath: "",
    root: "",
    at: Date.now(),
    status: "starting",
    done: 0,
    total: 0,
    failed: [],
    error: "",
    isRemembered: false,
    ...fields,
  };
}

function cleanFailures(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((failure) => ({
    operation: isObject(failure.operation) ? failure.operation : {},
    error: cleanTag(failure.error),
  }));
}

function isRunning(record) {
  return record != null && (record.status === "starting" || record.status === "running");
}

// Undo needs the journal. An apply can be undone once it has stopped, however
// it ended; an undo can be tried again when it didn't put everything back.
function canUndo(record) {
  if (!record || !record.journalPath || isRunning(record)) return false;
  if (record.kind === "apply") return true;
  return record.status !== "done" || record.failed.length > 0;
}

function whenText(at) {
  if (!at) return "Made earlier.";
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `Made ${day} at ${time}.`;
}

function applyResult({ status, done, total, failed, error }) {
  const changes = plural(total, "change", "changes");
  if (status === "error") {
    const why = error ? ` (${error})` : "";
    return { text: `Stopped part-way${why}: ${done.toLocaleString()} of ${changes} made. Undo puts back what was done.`, kind: "fail" };
  }
  if (failed.length) {
    return { text: `Done, but ${failed.length.toLocaleString()} of ${changes} didn't work (listed below). The rest were made.`, kind: "warn" };
  }
  return { text: `Done: ${changes} made.`, kind: "ok" };
}

function undoResult({ status, done, total, failed, error }) {
  if (status === "error") {
    const why = error ? ` (${error})` : "";
    return { text: `Undo stopped part-way${why}: ${done.toLocaleString()} of ${plural(total, "change", "changes")} put back.`, kind: "fail" };
  }
  if (failed.length) {
    return { text: `Undone, except ${plural(failed.length, "change", "changes")} that couldn't be put back (listed below).`, kind: "warn" };
  }
  return { text: "Undone: everything is back as it was.", kind: "ok" };
}

// the line under the change's name: how far it got, or how it ended
function changeResult(record) {
  const { kind, status } = record;
  if (status === "remembered") return { text: `${whenText(record.at)} You can still undo it.`, kind: "" };
  if (status === "starting") return { text: kind === "undo" ? "Starting to undo…" : "Starting…", kind: "" };
  if (status === "running") {
    const doing = kind === "undo" ? "Undoing" : "Working";
    return { text: `${doing}… ${record.done.toLocaleString()} of ${plural(record.total, "change", "changes")} done.`, kind: "" };
  }
  if (status === "refused") {
    return { text: `${kind === "undo" ? "Undo" : "The change"} didn't start: ${record.error}`, kind: "fail" };
  }
  if (status === "lost") {
    const next = canUndo(record) ? " Once the server runs again, scan the folder to check, or use Undo." : " Once the server runs again, scan the folder to check.";
    return { text: `Lost touch with the server, so this page can't tell how far it got.${next}`, kind: "fail" };
  }
  return kind === "undo" ? undoResult(record) : applyResult(record);
}

function failureText(failure, root) {
  const step = describeOperation(failure.operation, root);
  const where = [step.from, step.to].filter(Boolean).join(" → ");
  const what = where ? `${step.label || "Change"}: ${where}` : step.label || "A change";
  return `${what} — ${failure.error || "failed"}`;
}

// --- remembered in this browser (private windows may refuse: then the page just forgets) ---

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) {
    // storage is off: only the remembering is lost, never a change
  }
}

function readRememberedChange() {
  try {
    const record = JSON.parse(readStored(LAST_CHANGE_KEY) ?? "null");
    const isUsable = isObject(record) && typeof record.label === "string" &&
      typeof record.journalPath === "string" && isFullPath(record.journalPath);
    return isUsable ? record : null;
  } catch (e) {
    return null; // a damaged entry is as good as none
  }
}

// --- talking to the server ---

function requestError(message, status) {
  return Object.assign(new Error(message), { status });
}

// for answers without a readable { error }
function statusText(status) {
  if (status === 404) return "The server doesn't know this. If it was just updated, restart it and reload this page.";
  if (status === 403) return "The server only answers this page when it's opened on this computer.";
  return `The server answered with an error (${status}).`;
}

async function requestJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw requestError("Could not reach the server. Is it running?", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw requestError(cleanTag(body?.error) || statusText(res.status), res.status);
  if (!isObject(body)) throw requestError("The server sent an answer this page can't read.", res.status);
  return body;
}

function postJson(body) {
  return { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// --- scanning ---

function readDepth() {
  const depth = Number.parseInt($("scanDepth").value, 10);
  return Number.isInteger(depth) ? Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, depth)) : DEFAULT_DEPTH;
}

function scanProblem(folder) {
  if (!folder) return "Type the folder's path, or click Choose… to pick it.";
  if (!isFullPath(folder)) return "Type the folder as a full path, like /Volumes/PEN DRIVE, or click Choose….";
  return null;
}

function scanProgressText(status) {
  return `Scanning… ${plural(wholeNumber(status.scanned), "file", "files")}, ${plural(wholeNumber(status.found), "song", "songs")}`;
}

function scanDoneText(scanned, status) {
  const count = scanned.entries.length;
  const files = plural(wholeNumber(status.scanned), "file", "files");
  if (count === 0) return `No MP3s found (looked at ${files}). Try another folder, or look more folders deep.`;
  const capped = scanned.isCapped ? ` Only the first ${MAX_SONGS.toLocaleString()} were read.` : "";
  return `Found ${plural(count, "song", "songs")} in ${files}.${capped}`;
}

async function scanFolder() {
  if (isScanning || isRunning(change)) return; // never read the folder while a change is moving songs in it
  const folder = cleanTag($("folderPath").value);
  const problem = scanProblem(folder);
  if (problem) return showScanStatus(problem, "error");
  await runScan(folder, readDepth());
}

async function runScan(folder, depth) {
  const token = ++scanToken;
  isScanning = true;
  renderBusy();
  showScanStatus("Scanning…", "working");
  try {
    const scanId = idOf((await requestJson("/organizer/scan", postJson({ folder, maxDepth: depth }))).scanId);
    const status = await followScan(scanId, token);
    if (status && token === scanToken) loadLibrary(scanId, folder, depth, status);
  } catch (err) {
    if (token === scanToken) showScanStatus(err.message, "error");
  } finally {
    if (token === scanToken) {
      isScanning = false;
      renderBusy();
    }
  }
}

// polls the scan until it's done; null when a newer scan took over
async function followScan(scanId, token) {
  if (!scanId) throw new Error("The server didn't start the scan.");
  for (;;) {
    await sleep(POLL_MS);
    if (token !== scanToken) return null;
    const status = await requestJson(`/organizer/scan/${encodeURIComponent(scanId)}`);
    if (token !== scanToken) return null;
    if (status.status === "error") throw new Error(cleanTag(status.error) || "The scan stopped with an error.");
    if (status.status === "done") return status;
    showScanStatus(scanProgressText(status), "working");
  }
}

// A rescan of the same folder (after a change, say) keeps the filters and
// the ticks of songs still there; another folder starts afresh.
function loadLibrary(scanId, folder, depth, status) {
  const built = buildLibrary(scanId, cleanTag(status.root) || folder, depth, status.songs);
  // the server says when it stopped at its limit
  const next = status.truncated === true ? { ...built, isCapped: true } : built;
  const isSameRoot = library?.root === next.root;
  library = next;
  selected = isSameRoot ? new Set([...selected].filter((id) => next.byId.has(id))) : new Set();
  lastTickedId = null;
  if (!isSameRoot) {
    writeFilters(emptyFilters());
    view = { ...view, filters: emptyFilters(), page: 0 };
    preview = null; // it was for another folder's songs
    showActionMessage("", "");
  }
  $("folderPath").value = next.root;
  writeStored(FOLDER_KEY, next.root);
  showScanStatus(scanDoneText(next, status), next.entries.length ? "done" : "");
  renderLibrary();
}

// --- drawing the page ---

function showScanStatus(text, state) {
  const box = $("scanStatus");
  box.textContent = text;
  box.dataset.state = state;
}

function showActionMessage(text, kind) {
  const box = $("actionMessage");
  box.textContent = text;
  box.dataset.kind = kind;
}

// Redrawing replaces controls, so focus goes back to the control with the
// same data-focus: keyboard users keep their place.
function keepFocus(container, render) {
  const focusKey = document.activeElement?.dataset?.focus;
  render();
  if (focusKey) container.querySelector(`[data-focus="${focusKey}"]`)?.focus();
}

function renderLibrary() {
  const hasSongs = library.entries.length > 0;
  $("libraryPanel").classList.toggle("hidden", !hasSongs);
  $("actionsPanel").classList.toggle("hidden", !hasSongs);
  if (!hasSongs) return;
  $("libraryRoot").textContent = library.root;
  $("sortTarget").placeholder = joinPath(library.root, "Organized");
  $("playlistTarget").placeholder = library.root;
  renderFilterOptions();
  renderFilterState();
  renderTable();
  renderActions();
}

// value and words of a pill, e.g. ["1,203", "songs"]
function counted(count, one, many) {
  return [count.toLocaleString(), count === 1 ? one : many];
}

// a count; with filterBox it's also a button that turns that filter on and off
function summaryPill(value, words, { kind = "", filterBox = null } = {}) {
  const pill = el(filterBox ? "button" : "span", "summary-pill");
  pill.append(el("strong", null, value), ` ${words}`);
  if (kind) pill.dataset.kind = kind;
  if (filterBox) {
    pill.type = "button";
    pill.title = "Show only these songs";
    pill.dataset.focus = `pill:${filterBox}`;
    pill.setAttribute("aria-pressed", String($(filterBox).checked));
    pill.addEventListener("click", () => toggleQuickFilter(filterBox));
  }
  const item = el("li");
  item.append(pill);
  return item;
}

function renderSummary() {
  const s = library.summary;
  const pills = [
    summaryPill(...counted(s.songs, "song", "songs")),
    summaryPill(formatBytes(s.bytes), "in all"),
    summaryPill(...counted(s.artists, "artist", "artists")),
    summaryPill(...counted(s.albums, "album", "albums")),
    summaryPill(...counted(s.folders, "folder", "folders")),
    summaryPill(...counted(s.untagged, "untagged", "untagged"), {
      kind: s.untagged ? "warn" : "",
      filterBox: s.untagged ? "untaggedOnly" : null,
    }),
    summaryPill(...counted(s.duplicates, "possible duplicate", "possible duplicates"), {
      kind: s.duplicates ? "info" : "",
      filterBox: s.duplicates ? "duplicatesOnly" : null,
    }),
    ...(library.isCapped ? [summaryPill(MAX_SONGS.toLocaleString(), "songs read at most", { kind: "warn" })] : []),
  ];
  keepFocus($("summaryPills"), () => $("summaryPills").replaceChildren(...pills));
}

function makeOption(value, text) {
  const option = el("option", null, text);
  option.value = value;
  return option;
}

// the artist, album, genre and folder lists, rebuilt after each scan; a
// choice still on the list stays chosen
function renderFilterOptions() {
  for (const [name, filter] of Object.entries(CHOICE_FILTERS)) {
    const { choices, blanks } = filterChoices(library.entries, filter);
    const options = [
      makeOption("", filter.anyText),
      ...(blanks ? [makeOption(NO_VALUE, `${filter.noneText} (${blanks.toLocaleString()})`)] : []),
      ...choices.map((choice) =>
        makeOption(CHOICE_PREFIX + choice.key, `${choice.label} (${choice.count.toLocaleString()})`)
      ),
    ];
    const select = $(PICKED_FILTERS[name]);
    const wanted = view.filters[name];
    select.replaceChildren(...options);
    select.value = options.some((option) => option.value === wanted) ? wanted : "";
  }
  view = { ...view, filters: readFilters() };
}

function renderFilterState() {
  const count = activeFilterCount(view.filters);
  $("filterCount").textContent = count ? `${count} on` : "";
  $("clearFilters").disabled = count === 0;
  renderSummary(); // the quick-filter pills show whether they're on
}

function renderTable() {
  if (!library) return;
  const entries = visibleEntries();
  const info = pageInfo(entries.length, view.page);
  if (info.page !== view.page) view = { ...view, page: info.page };
  const onPage = entries.slice(info.start, info.end);
  const rows = onPage.length ? onPage.map(songRow) : [emptyRow("No songs match these filters.")];
  keepFocus($("songBody"), () => $("songBody").replaceChildren(...rows));
  renderSortHeaders();
  renderPager(info, entries.length);
  renderSelection(entries, onPage);
}

function songRow(entry) {
  const { song } = entry;
  const isSelected = selected.has(song.id);
  const row = el("tr", isSelected ? "is-selected" : "");
  row.append(
    checkCell(entry, isSelected),
    titleCell(entry),
    textCell(song.artist),
    textCell(song.album),
    numberCell(entry.year == null ? "" : String(entry.year)),
    textCell(song.genre),
    numberCell(formatLength(song.durationSec)),
    numberCell(formatBytes(song.size)),
    textCell(entry.folder, "(top folder)")
  );
  return row;
}

// ticks are read by one listener on the table body, see onSongClick
function checkCell(entry, isSelected) {
  const box = el("input");
  box.type = "checkbox";
  box.checked = isSelected;
  box.dataset.id = entry.song.id;
  box.dataset.focus = `song:${entry.song.id}`;
  box.setAttribute("aria-label", `Select ${entry.title}`);
  const cell = el("td", "col-check");
  cell.append(box);
  return cell;
}

// the title (or file name), with the file name and any warnings under it
function titleCell(entry) {
  const meta = el("div", "song-meta");
  meta.append(el("span", "song-file", entry.song.fileName));
  if (!entry.song.tagged) meta.append(tagChip("no tags", "warn"));
  if (entry.isDuplicate) meta.append(tagChip("possible duplicate", "info"));
  const cell = el("th", "col-title");
  cell.scope = "row";
  cell.append(el("div", "song-name", entry.title), meta);
  return cell;
}

function tagChip(text, kind) {
  const chip = el("span", "tag-chip", text);
  chip.dataset.kind = kind;
  return chip;
}

function textCell(text, blankText = "—") {
  const cell = el("td", "cell-text");
  cell.append(text ? text : el("span", "blank", blankText));
  return cell;
}

function numberCell(text) {
  const cell = el("td", "num");
  cell.append(text ? text : el("span", "blank", "—"));
  return cell;
}

function emptyRow(text) {
  const cell = el("td", "table-empty", text);
  cell.colSpan = 9;
  const row = el("tr");
  row.append(cell);
  return row;
}

function renderSortHeaders() {
  for (const key of Object.keys(SORT_VALUES)) {
    const header = $(`head-${key}`);
    if (view.sort.key !== key) header.removeAttribute("aria-sort");
    else header.setAttribute("aria-sort", view.sort.isDescending ? "descending" : "ascending");
  }
}

function renderPager(info, shown) {
  $("pager").classList.toggle("hidden", info.pageCount <= 1);
  $("pagePrev").disabled = info.page === 0;
  $("pageNext").disabled = info.page >= info.pageCount - 1;
  $("pageText").textContent = `Page ${info.page + 1} of ${info.pageCount}`;
  $("tableStatus").textContent = tableStatusText(info, shown, library.entries.length);
}

function renderSelection(visible, onPage) {
  const chosen = visible.filter((entry) => selected.has(entry.song.id)).length;
  const tickedOnPage = onPage.filter((entry) => selected.has(entry.song.id)).length;
  const pageCheck = $("pageCheck");
  pageCheck.disabled = onPage.length === 0;
  pageCheck.checked = onPage.length > 0 && tickedOnPage === onPage.length;
  pageCheck.indeterminate = tickedOnPage > 0 && tickedOnPage < onPage.length;
  $("selectionCount").textContent = selectionText(chosen, selected.size - chosen);
}

function readFilters() {
  const fields = { ...TYPED_FILTERS, ...PICKED_FILTERS };
  const values = Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, $(id).value]));
  const boxes = Object.fromEntries(Object.entries(FILTER_BOXES).map(([name, id]) => [name, $(id).checked]));
  return { ...values, ...boxes };
}

function writeFilters(filters) {
  for (const [name, id] of Object.entries({ ...TYPED_FILTERS, ...PICKED_FILTERS })) $(id).value = filters[name];
  for (const [name, id] of Object.entries(FILTER_BOXES)) $(id).checked = filters[name];
}

function readActionForm() {
  return {
    groupBy: $("groupBy").value,
    sortTarget: $("sortTarget").value,
    sortMode: $("sortMove").checked ? "move" : "copy",
    pattern: $("renamePattern").value,
    playlistName: $("playlistName").value,
    playlistTarget: $("playlistTarget").value,
    playlistMode: $("playlistMove").checked ? "move" : "copy",
    numberTracks: $("numberTracks").checked,
    writePlaylist: $("writePlaylist").checked,
    keep: Object.keys(KEEP_CHOICES).find((keep) => $(KEEP_CHOICES[keep]).checked) ?? "largest",
  };
}

function currentRequest() {
  const songIds = chosenEntries().map((entry) => entry.song.id);
  return planRequest(library.scanId, activeAction, readActionForm(), songIds);
}

// The actions card after anything changed: the open tab's live text, then
// the preview, which goes once it no longer matches the songs and options.
function renderActions() {
  if (!library) return;
  const entries = chosenEntries();
  $("actionSelection").textContent = entries.length
    ? `Working with ${plural(entries.length, "ticked song", "ticked songs")}, in the table's order.`
    : "Tick songs in the table above to choose what to change.";
  if (activeAction === "rename") renderRenameExample(entries);
  if (activeAction === "playlist") $("playlistOrder").textContent = orderText(view.sort);
  checkPreview();
  renderPlan();
  renderBusy();
}

function renderRenameExample(entries) {
  const { text, kind } = renameExampleText(entries, $("renamePattern").value);
  const box = $("renameExample");
  box.textContent = text;
  box.dataset.kind = kind;
}

function checkPreview() {
  if (!preview || JSON.stringify(currentRequest()) === preview.signature) return;
  const wasApplied = preview.isUsed;
  preview = null;
  if (!wasApplied) {
    showActionMessage("The ticked songs or the options changed, so the preview was cleared. Click Preview to see the new plan.", "");
  }
}

function renderPlan() {
  if (preview === shownPreview) return; // up to date: a big plan isn't redrawn on every tick
  shownPreview = preview;
  $("planBox").classList.toggle("hidden", !preview);
  if (!preview) return;
  const root = library?.root ?? "";
  $("planHeading").textContent = preview.isUsed
    ? "Applied: see Last change below"
    : "Preview (nothing has changed yet)";
  $("planSummary").replaceChildren(
    ...planCounts(preview).map(({ value, words, kind }) => summaryPill(value, words, { kind }))
  );
  renderConflicts(preview.conflicts);
  const rows = preview.operations.slice(0, preview.rowsShown).map((operation) => planRow(operation, root));
  $("planBody").replaceChildren(...(rows.length ? rows : [emptyPlanRow()]));
  const rest = preview.operations.length - rows.length;
  $("planMore").classList.toggle("hidden", rest <= 0);
  $("planMore").textContent = `Show ${Math.min(rest, PLAN_ROWS_STEP).toLocaleString()} more (${rest.toLocaleString()} not shown)`;
}

function planRow(operation, root) {
  const step = describeOperation(operation, root);
  const chip = el("span", "op-chip", step.label || "Change");
  chip.dataset.kind = step.kind;
  const kindCell = el("td", "col-kind");
  kindCell.append(chip);
  const row = el("tr");
  row.append(kindCell, pathCell(step.from, step.fromFull), pathCell(step.to, step.toFull));
  return row;
}

function pathCell(text, fullPath) {
  const cell = el("td", "op-path", text || "—");
  if (fullPath) cell.title = fullPath;
  return cell;
}

function emptyPlanRow() {
  const cell = el("td", "table-empty", "No changes.");
  cell.colSpan = 3;
  const row = el("tr");
  row.append(cell);
  return row;
}

function conflictText(conflict) {
  const entry = library?.byId.get(String(conflict.songId));
  const name = entry ? `${entry.title}${entry.song.artist ? ` — ${entry.song.artist}` : ""}` : "A song";
  return `Skipped ${name}: ${cleanTag(conflict.reason) || "no reason given"}`;
}

function renderConflicts(conflicts) {
  const items = conflicts.slice(0, MAX_LISTED).map((conflict) => el("li", "conflict", conflictText(conflict)));
  const rest = conflicts.length - items.length;
  const more = rest > 0 ? [el("li", "conflict", `…and ${plural(rest, "more song", "more songs")} skipped`)] : [];
  $("planConflicts").replaceChildren(...items, ...more);
}

const PROGRESS_STATES = { starting: "running", running: "running", done: "done", error: "failed" };

function renderChangeProgress(record) {
  const state = PROGRESS_STATES[record.status];
  const bar = $("changeProgress");
  bar.classList.toggle("hidden", !state);
  if (!state) return;
  const fraction = record.status === "done" ? 1 : record.total ? Math.min(1, record.done / record.total) : 0;
  // amber when it finished with some steps failed
  bar.dataset.state = state === "done" && record.failed.length ? "stopped" : state;
  bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  $("changeBar").style.transform = `scaleX(${fraction})`;
}

function renderFailures(failed, root) {
  const items = failed.slice(0, MAX_LISTED).map((failure) => el("li", "failed-item", failureText(failure, root)));
  const rest = failed.length - items.length;
  const more = rest > 0 ? [el("li", "failed-item", `…and ${rest.toLocaleString()} more`)] : [];
  $("changeFailed").replaceChildren(...items, ...more);
}

function renderChange() {
  $("changePanel").classList.toggle("hidden", !change);
  if (!change) return;
  $("changeLabel").textContent = change.label;
  renderChangeProgress(change);
  const result = changeResult(change);
  $("changeResult").textContent = result.text;
  $("changeResult").dataset.kind = result.kind;
  renderFailures(change.failed, change.root);
  $("undoButton").classList.toggle("hidden", !canUndo(change));
  $("undoButton").textContent = change.kind === "undo" ? "Try undoing again" : "Undo";
  $("forgetButton").classList.toggle("hidden", !change.isRemembered);
}

// One thing at a time: no new scan, preview, apply or undo while a scan or
// a change is still going.
function renderBusy() {
  const isBusy = isScanning || isRunning(change);
  const steps = preview ? preview.operations.length : 0;
  $("scanButton").disabled = isBusy;
  $("scanButton").textContent = isScanning ? "Scanning…" : "Scan";
  $("previewButton").disabled = isBusy || isPlanning || !library;
  $("previewButton").textContent = isPlanning ? "Working…" : "Preview";
  $("applyButton").disabled = isBusy || isPlanning || !preview || preview.isUsed || steps === 0;
  $("applyButton").textContent = steps && !preview.isUsed ? `Apply ${plural(steps, "change", "changes")}` : "Apply";
  $("undoButton").disabled = isBusy;
  $("forgetButton").disabled = isBusy;
}

// --- what the person does: filters, ticks, sorting, pages ---

function applyFilters() {
  clearTimeout(filterTimer);
  view = { ...view, filters: readFilters(), page: 0 };
  if (!library) return;
  renderFilterState();
  renderTable();
  renderActions();
}

// typing waits for a pause, so a long list isn't refiltered on every key
function scheduleFilters() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilters, FILTER_DEBOUNCE_MS);
}

function clearFilters() {
  writeFilters(emptyFilters());
  applyFilters();
}

function toggleQuickFilter(boxId) {
  $(boxId).checked = !$(boxId).checked;
  applyFilters();
}

function setSelection(next) {
  selected = next;
  renderTable();
  renderActions();
}

// a tick (or, with Shift, every row from the last tick to this one)
function onSongClick(event) {
  const box = event.target;
  const id = box?.dataset?.id;
  if (box?.type !== "checkbox" || !id) return;
  const ids = event.shiftKey && lastTickedId ? idsBetween(visibleEntries(), lastTickedId, id) : [id];
  lastTickedId = id;
  setSelection(withIds(selected, ids, box.checked));
}

function onPageCheck() {
  const entries = visibleEntries();
  const info = pageInfo(entries.length, view.page);
  const ids = entries.slice(info.start, info.end).map((entry) => entry.song.id);
  setSelection(withIds(selected, ids, $("pageCheck").checked));
}

function sortBy(key) {
  view = { ...view, sort: nextSort(view.sort, key), page: 0 };
  renderTable();
  renderActions();
}

function goToPage(page) {
  view = { ...view, page };
  renderTable();
  $("songScroll").scrollTop = 0;
}

// --- what the person does: tabs and options ---

function selectAction(action, shouldFocus) {
  if (!ACTIONS.includes(action)) return;
  activeAction = action;
  for (const name of ACTIONS) {
    const isActive = name === action;
    const tab = $(`tab-${name}`);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    $(`panel-${name}`).classList.toggle("hidden", !isActive);
  }
  if (shouldFocus) $(`tab-${action}`).focus();
  renderActions();
}

// arrow keys, Home and End move between the tabs
function onTabKey(event) {
  const index = ACTIONS.indexOf(activeAction);
  const targets = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: ACTIONS.length - 1 };
  if (!(event.key in targets)) return;
  event.preventDefault();
  selectAction(ACTIONS[(targets[event.key] + ACTIONS.length) % ACTIONS.length], true);
}

// adds a tag where the cursor is in the name (or at the end)
function insertToken(token) {
  const input = $("renamePattern");
  if (typeof input.setRangeText === "function") {
    const end = input.value.length;
    input.setRangeText(token, input.selectionStart ?? end, input.selectionEnd ?? end, "end");
  } else {
    input.value += token;
  }
  input.focus();
  renderActions();
}

function selectDuplicates() {
  $("duplicatesOnly").checked = true;
  applyFilters();
  const ids = visibleIds();
  setSelection(withIds(selected, ids, true));
  if (ids.length) {
    showActionMessage(`Ticked ${plural(ids.length, "possible duplicate", "possible duplicates")}. Pick which copy to keep, then click Preview.`, "ok");
  } else {
    showActionMessage("None of the songs the filters show look like duplicates.", "warn");
  }
}

// --- previewing and applying a plan ---

async function previewChanges() {
  if (!library || isPlanning || isScanning || isRunning(change)) return;
  const request = currentRequest();
  const problem = requestProblem(request);
  if (problem) return showActionMessage(problem, "warn");

  const signature = JSON.stringify(request);
  isPlanning = true;
  preview = null;
  renderPlan();
  renderBusy();
  showActionMessage("Working out the changes…", "");
  try {
    const plan = cleanPlan(await requestJson("/organizer/plan", postJson(request)));
    if (JSON.stringify(currentRequest()) !== signature) {
      return showActionMessage("The songs or options changed while the preview was made. Click Preview again.", "warn");
    }
    preview = { ...plan, signature, action: request.action, songCount: request.songIds.length, rowsShown: PLAN_ROWS_STEP, isUsed: false };
    const ready = previewReadyText(preview);
    showActionMessage(ready.text, ready.kind);
  } catch (err) {
    showActionMessage(planErrorText(err), "fail");
  } finally {
    isPlanning = false;
    renderPlan();
    renderBusy();
  }
}

function showMorePlan() {
  if (!preview) return;
  preview = { ...preview, rowsShown: preview.rowsShown + PLAN_ROWS_STEP };
  renderPlan();
}

async function applyChanges() {
  if (!preview || preview.isUsed || isPlanning || isScanning || isRunning(change)) return;
  if (JSON.stringify(currentRequest()) !== preview.signature) {
    checkPreview();
    renderPlan();
    return renderBusy();
  }
  const question = confirmText(preview);
  if (question && !window.confirm(question)) return;

  // marked used before the request goes, so a second click can't apply it twice
  const plan = preview;
  preview = { ...plan, isUsed: true };
  renderPlan();
  showActionMessage("", "");
  const details = { label: changeLabel(plan), journalPath: "", root: library.root };
  await startChange("apply", "/organizer/apply", { planId: plan.planId }, details);

  // the server said no before doing anything: the same plan can be tried again
  if (change.status === "refused" && preview?.planId === plan.planId) {
    preview = { ...preview, isUsed: false };
    renderPlan();
    renderBusy();
  }
}

// --- following a change, and undoing it ---

async function startChange(kind, url, body, details) {
  const token = ++changeToken;
  change = changeRecord({ kind, ...details });
  renderChange();
  renderBusy();
  revealChange();

  let applyId;
  try {
    applyId = idOf((await requestJson(url, postJson(body))).applyId);
    if (!applyId) throw requestError("The server didn't say which change it started.", 500);
  } catch (err) {
    // with no answer at all it may have started anyway, so it's "lost", not refused
    if (token === changeToken) setChange({ status: err.status > 0 ? "refused" : "lost", error: err.message });
    return;
  }
  await followChange(applyId, token);
}

async function followChange(applyId, token) {
  let failures = 0;
  while (token === changeToken) {
    await sleep(POLL_MS);
    if (token !== changeToken) return;
    let status;
    try {
      status = await requestJson(`/organizer/apply/${encodeURIComponent(applyId)}`);
    } catch (err) {
      failures += 1;
      if (err.status === 404 || failures >= MAX_POLL_FAILURES) return setChange({ status: "lost", error: err.message });
      continue;
    }
    failures = 0;
    if (token !== changeToken) return;
    takeChangeStatus(status);
    if (status.status === "done" || status.status === "error") return finishChange();
  }
}

// The journal path is remembered as soon as the server names it, so the
// change can be undone even if this page or the server stops part-way.
function takeChangeStatus(status) {
  const journalPath = change.journalPath || cleanTag(status.journalPath);
  const isNewJournal = change.kind === "apply" && journalPath !== "" && change.journalPath === "";
  const isFinished = status.status === "done" || status.status === "error";
  setChange({
    status: isFinished ? status.status : "running",
    done: wholeNumber(status.done),
    total: wholeNumber(status.total),
    failed: cleanFailures(status.failed),
    error: cleanTag(status.error),
    journalPath,
  });
  if (isNewJournal) {
    const record = { label: change.label, journalPath, root: change.root, at: change.at };
    writeStored(LAST_CHANGE_KEY, JSON.stringify(record));
  }
}

function setChange(fields) {
  change = { ...change, ...fields };
  renderChange();
  renderBusy();
}

// the folder changed on the drive, so the list is read again
function finishChange() {
  const isFullyUndone = change.kind === "undo" && change.status === "done" && change.failed.length === 0;
  if (isFullyUndone) writeStored(LAST_CHANGE_KEY, null);
  if (library && library.root === change.root) runScan(library.root, library.depth);
}

async function undoChange() {
  if (!canUndo(change) || isScanning || isRunning(change)) return;
  const question = "Undo this change? Moved and renamed songs go back where they were, and the copies, " +
    "folders and playlist files it made are removed. Your original songs are never deleted.";
  if (!window.confirm(question)) return;
  const { label, journalPath, root } = change;
  await startChange("undo", "/organizer/undo", { journalPath }, { label, journalPath, root });
}

function forgetLastChange() {
  writeStored(LAST_CHANGE_KEY, null);
  change = null;
  renderChange();
  renderBusy();
}

function revealChange() {
  const isCalm = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  $("changePanel").scrollIntoView?.({ block: "nearest", behavior: isCalm ? "auto" : "smooth" });
}

// the change carries on at the server; leaving only loses sight of it
function warnBeforeLeaving(event) {
  if (!isRunning(change)) return;
  event.preventDefault();
  event.returnValue = "";
}

// --- folders: the drive suggestions and the system's folder dialog ---

function driveLabel(drive) {
  const free = Number.isFinite(drive.freeBytes) ? ` · ${formatBytes(drive.freeBytes)} free` : "";
  return `${cleanTag(drive.name) || drive.path}${free}`;
}

function driveOption(drive) {
  const option = el("option");
  option.value = drive.path;
  option.label = driveLabel(drive);
  return option;
}

function driveChip(drive) {
  const chip = el("button", "drive-chip", driveLabel(drive));
  chip.type = "button";
  chip.title = drive.path;
  // picking a drive reads it straight away: a scan only looks
  chip.addEventListener("click", () => {
    $("folderPath").value = drive.path;
    scanFolder();
  });
  const item = el("li");
  item.append(chip);
  return item;
}

// On load and whenever the folder field gets focus, so a pen drive plugged
// in later still shows up.
async function loadDrives() {
  let drives;
  try {
    const res = await fetch("/drives");
    drives = res.ok ? await res.json() : [];
  } catch (e) {
    return; // keep what's listed; a typed path still works
  }
  const usable = Array.isArray(drives) ? drives.filter((drive) => isObject(drive) && typeof drive.path === "string") : [];
  $("driveList").replaceChildren(...usable.map(driveOption));
  $("driveChips").replaceChildren(...usable.map(driveChip));
  $("drivesBox").classList.toggle("hidden", usable.length === 0);
}

function setChoosing(isChoosing, button) {
  for (const id of CHOOSE_BUTTON_IDS) $(id).disabled = isChoosing;
  button.textContent = isChoosing ? "Choosing…" : "Choose…";
}

// The server opens the system's folder dialog and answers once a folder is
// picked or the dialog is cancelled.
async function chooseFolderFor(button) {
  const input = $(button.dataset.target);
  const report = button.id === "chooseFolder"
    ? (text) => showScanStatus(text, "error")
    : (text) => showActionMessage(text, "fail");
  setChoosing(true, button);
  try {
    const res = await fetch("/pick-folder", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return report(cleanTag(body.error) || "Could not open the folder picker.");
    if (typeof body.path === "string" && body.path) {
      input.value = body.path;
      // the songs' folder is read straight away; a target folder only changes the plan
      if (button.id === "chooseFolder") scanFolder();
      else renderActions();
    }
  } catch (e) {
    report("Could not reach the server. Is it running?");
  } finally {
    setChoosing(false, button);
  }
}

// --- start ---

function restoreChange() {
  const record = readRememberedChange();
  if (!record) return;
  change = changeRecord({
    label: record.label,
    journalPath: record.journalPath,
    root: cleanTag(record.root),
    at: wholeNumber(record.at),
    status: "remembered",
    isRemembered: true,
  });
  renderChange();
}

function wireFolderCard() {
  $("scanButton").addEventListener("click", scanFolder);
  // a tick later, so Enter on a suggested drive scans the drive, not the half-typed path
  $("folderPath").addEventListener("keydown", (event) => {
    if (event.key === "Enter") setTimeout(scanFolder, 0);
  });
  $("folderPath").addEventListener("focus", loadDrives);
  for (const id of CHOOSE_BUTTON_IDS) $(id).addEventListener("click", () => chooseFolderFor($(id)));
}

function wireLibrary() {
  for (const id of Object.values(TYPED_FILTERS)) $(id).addEventListener("input", scheduleFilters);
  for (const id of [...Object.values(PICKED_FILTERS), ...Object.values(FILTER_BOXES)]) {
    $(id).addEventListener("change", applyFilters);
  }
  $("clearFilters").addEventListener("click", clearFilters);
  $("selectAll").addEventListener("click", () => setSelection(withIds(selected, visibleIds(), true)));
  $("selectNone").addEventListener("click", () => setSelection(new Set()));
  $("selectInvert").addEventListener("click", () => setSelection(invertIds(selected, visibleIds())));
  $("pageCheck").addEventListener("change", onPageCheck);
  $("songBody").addEventListener("click", onSongClick);
  for (const key of Object.keys(SORT_VALUES)) $(`sort-${key}`).addEventListener("click", () => sortBy(key));
  $("pagePrev").addEventListener("click", () => goToPage(view.page - 1));
  $("pageNext").addEventListener("click", () => goToPage(view.page + 1));
}

function wireActions() {
  for (const action of ACTIONS) {
    $(`tab-${action}`).addEventListener("click", () => selectAction(action, false));
    $(`tab-${action}`).addEventListener("keydown", onTabKey);
  }
  for (const id of ACTION_INPUT_IDS) {
    $(id).addEventListener("input", renderActions);
    $(id).addEventListener("change", renderActions);
  }
  for (const token of TOKENS) $(`token-${token}`).addEventListener("click", () => insertToken(`{${token}}`));
  $("selectDuplicates").addEventListener("click", selectDuplicates);
  $("previewButton").addEventListener("click", previewChanges);
  $("applyButton").addEventListener("click", applyChanges);
  $("planMore").addEventListener("click", showMorePlan);
  $("undoButton").addEventListener("click", undoChange);
  $("forgetButton").addEventListener("click", forgetLastChange);
}

function start() {
  wireFolderCard();
  wireLibrary();
  wireActions();
  window.addEventListener("beforeunload", warnBeforeLeaving);
  // a phone starts with the filters folded away, so the songs show first
  if (window.matchMedia?.("(max-width: 559px)")?.matches) $("filterBox").open = false;
  const folder = readStored(FOLDER_KEY);
  if (folder && !$("folderPath").value) $("folderPath").value = folder;
  restoreChange();
  selectAction(activeAction, false);
  renderBusy();
  loadDrives();
}

// the page wires itself up once its markup is there (the tests load this file without it)
if (document.getElementById("organizePage")) start();
