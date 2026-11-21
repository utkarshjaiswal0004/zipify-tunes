# ZipifyTunes

Convert any playlist CSV into a local ZIP of MP3 files with **album art** and **metadata** (title, artist, album, year, genre).
Everything runs **locally** on your machine.

Tired of streaming algorithms deciding what you should listen to?<br>
Tired of losing playlists, rising subscription prices, or limited offline access?<br>
ZipifyTunes lets you take back control; your music, your files, your way.

<div align="left">
    <img src="./demo.png" width="1000" alt="Screenshot showing ZipifyTunes web interface on PeerSky Browser on the right and the generated MP3 files with album art in Finder on the left.">
</div>

## What it does

- Takes a **playlist CSV** (Spotify, Apple Music, YouTube Music, custom, etc.)
- For each row, it:
  - Reads **title**, **artist**, **album**, **year**, **genre** (from many possible column names)
  - Searches the track on **YouTube**
  - Downloads the audio as **MP3** using `youtube-dl-exec` / `yt-dlp`
  - Fetches square **album art** from the **iTunes Search API**
  - Writes **ID3 tags** (title, artist, album, year, genre) and embeds the cover
- Zips everything into `songs.zip` for you to download from the browser

## How it works

- **Upload:** The CSV you upload is stored briefly in `/uploads/` by `multer` and removed when the process finishes
- **Search:** `yt-search` (with yt-dlp's own search as a fallback) looks each track up on YouTube, and every result is scored against the track's title, artist and length. A track without a sure match goes to the review list instead of being downloaded as a guess
- **Download:** `youtube-dl-exec` (yt-dlp) downloads and converts audio to MP3 (saved temporarily inside an auto-generated folder like `mp3s_123456789/`). The server runs `yt-dlp -U` on startup, because YouTube keeps changing how it serves audio and an outdated yt-dlp fails every download with `HTTP Error 403: Forbidden`
- **Covers:** iTunes Search API provides square artwork, verified against the track's title and artist so a wrong cover is never embedded; if iTunes doesn't have the track, the YouTube thumbnail is centre-cropped to a square instead
- **Tagging:** `ffmpeg` writes ID3 tags: title, artist, album, year, genre + embedded cover
- **Packaging:** `archiver` builds a ZIP of all generated MP3s and streams it back to your browser
- **Disk space:** a run needs about twice the playlist size free (the temp MP3s plus the ZIP your browser saves), so roughly 20 MB per track. ZipifyTunes checks this up front and refuses with a clear message instead of handing back a truncated ZIP

## Install & run

### node.js
Make sure you have Node.js installed:
👉 https://nodejs.org

### ffmpeg
FFmpeg handles audio processing, including embedding album art, writing MP3 metadata (ID3 tags), and packaging the final audio stream without re-encoding. It’s required because yt-dlp only downloads audio. FFmpeg does the tagging, cover embedding, and final MP3 formatting.

macOS (Homebrew):
```bash
brew install ffmpeg
```

Ubuntu / Debian Linux:
```bash
sudo apt update
sudo apt install ffmpeg
```

Windows:
```bash
winget install Gyan.FFmpeg
```
Manual install: https://www.gyan.dev/ffmpeg/builds/

### Run

```bash
# clone your repo
git clone https://github.com/akhileshthite/zipify-tunes.git
cd zipify-tunes

# install dependencies
npm install

# start the local server
npm start

# then open 
http://localhost:3000
```

## How to use

1. Export your playlist as a CSV
   - You can use tools like https://www.chosic.com/spotify-playlist-exporter/
   - Or any other service that gives you a CSV with track info

2. Open `http://localhost:3000`

3. Choose your CSV file

4. Pick your MP3 quality (128 / 192 / 256 / 320 kbps or “Best”)

5. Click Download MP3s

6. Wait for the progress bar to reach 100%

7. Your browser will download `songs.zip` containing:
    - MP3s with:
        - Clean file names
        - Embedded album cover
        - Title / Artist / Album / Year / Genre tags

**Download at once** sets how many songs download in parallel: anything from 1 to 20 (3 by default). More is faster on a quick connection, but YouTube tends to throttle or briefly refuse lots of downloads at once from one connection, and iTunes only answers about 20 cover lookups a minute (when it stops answering, songs get their YouTube thumbnail as the cover for a minute). If downloads start failing or crawling, turn it down.

### Save straight to a folder or pen drive

Instead of a ZIP, click **Choose…** next to "Save to folder" and pick a folder or a plugged-in drive (on macOS this opens the normal Finder dialog; elsewhere, type the folder path). The MP3s go straight into a new folder there named after your CSV, e.g. `/Volumes/MyDrive/My Playlist/`, so they never take up space on your computer's own disk. On FAT32/exFAT pen drives, the hidden `._` files macOS leaves behind are removed for you.

While it runs, the page shows the song being worked on (searching, downloading with size and speed, converting, tagging), how much has been saved so far out of the expected total, the time taken and roughly how long is left, and a ✓ / ✗ / ? line per song.

**Countdown, changing speed mid-run, live stats.** The time left counts down between songs. It comes from the pace of the last dozen songs to finish (time spent paused doesn't count), so a slow start or a change of pace soon stops skewing it. **Download at once** can be changed while a run goes on: a higher number starts more songs within a moment, and a lower one lets the songs already downloading finish before fewer start (the page sends it to `POST /jobs/<id>/parallel`). A live stats panel charts the songs done and the download speed over time, counts the songs saved, skipped, to review and failed, and lists the last songs to finish with how each one ended and how long it took.

**Review list.** A song isn't downloaded as a guess when YouTube can't find it, or when none of its results clearly matches its title (and, when the CSV has one, its length, e.g. Exportify's `Duration (ms)`) without being a live version, cover, remix, slowed edit or long compilation. It gets a `?` line instead, and when the run ends it is listed with its closest results (title, channel, length and how good a match each is). Songs whose download failed are listed too, with the video that failed first (to retry it, e.g. after turning on YouTube sign-in) and the other results after it. Only a sure match is ticked for you: tick the right version of each song (several at once is fine), search wider when none fit, and download the picks. They go where their playlist went: straight into its folder (not a new one inside it), or, for a ZIP run, a ZIP named "<playlist> (picked).zip". A pick that fails, or that Stop or a failed run never got to, stays on the list with your choice; running the same playlist again replaces its rows rather than listing them twice.

The server only answers this computer, and only the ZipifyTunes page itself can start a run (other websites can't), because it can write into your folders. To reach it from other devices on your network, start it with your computer's network address, e.g. `ZIPIFY_HOST=192.168.1.20 npm start`.

If you want to access your music from anywhere, you can use the [PeerSky Browser](https://github.com/p2plabsxyz/peersky-browser) and upload the generated ZIP from ZipifyTunes to [IPFS](https://docs.ipfs.tech/concepts/what-is-ipfs/) or [Hypercore](https://holepunch.to/). Then you can stream or download your MP3s through [public HTTP gateways](https://ipfs.github.io/public-gateway-checker/) directly on your phone.

### Run options

Five switches change how a run works. The page sends them to `POST /upload` as `"1"` / `"0"` form fields and to `POST /picks` as `true` / `false`; a missing one takes its default.

- **Keep Mac awake** (`keepAwake`, on): while a run goes on, macOS's own `caffeinate -i` keeps the Mac from idle sleep, so an overnight run isn't cut short. It lets go as soon as the run ends, however it ends (saved, ZIP ready, failed or stopped), and runs going at once share it. Closing a MacBook's lid still sleeps it; on other systems it does nothing.
- **Car-ready playlists**, for runs saved to a folder:
  - **Numbered songs** (`numberTracks`, off): songs are saved as `007 - Tum Hi Ho.mp3`, so car stereos and players that sort a folder by name play it in the CSV's order. When the run ends, the CSV's songs already in the folder without a number (from an earlier run, or picked from the review list) get theirs; a numbered file already there is never overwritten. "Skip songs already saved" recognises a song under either name. Every song is tagged with its track number (`7/500`) either way.
  - **Playlist file** (`writePlaylist`, on): when the run ends, `<playlist>.m3u` is written beside the songs, listing every song of the CSV that's in the folder, in the CSV's order, with its length. A "Download selected" run leaves it as it is: run the CSV again (with "skip songs already saved") to refresh it.
- **Reuse songs across playlists** (`reuseSongs`, on; CSV runs saved to a folder): before searching YouTube, each song is looked for, by its tags, in the other playlist folders of the folder you save into (two levels deep). A sure match (same title, a shared artist, not a live or remixed version, about the same length) is copied in instead of downloaded, and shows as `↺ <title> — copied from <folder>`. Picked songs are always downloaded: you chose those videos.
- **Auto-retry** (`autoRetry`, on): a download that fails in a way that usually clears up (YouTube throttling with HTTP 403 or 429, a dropped connection, a timeout) is tried twice more, after 5 and then 15 seconds, and the song shows as retrying meanwhile. A video that's gone, private or age-restricted, or YouTube's bot check, isn't tried again, and Stop ends the wait.

## Disclaimer

<img src="./ipod.jpg" width="260" align="left" alt="A silver iPod Nano 5th gen showing Cover Flow with album artwork for The Chainsmokers on screen.">

This tool is intended only for personal, local use:<br>
- Do not use this project to infringe copyright, redistribute music, or share copyrighted material without permission.<br>
- You are solely responsible for how you use this code and for complying with your local laws and the terms of service of any platforms you access.
