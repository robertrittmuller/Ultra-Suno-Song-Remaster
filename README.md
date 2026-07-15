# AI Music Remastering

A professional desktop app for mastering AI-generated music to streaming-ready quality.
<img width="1372" height="1092" alt="Screenshot 2026-03-06 184721" src="https://github.com/user-attachments/assets/433ed7d2-fa81-4c88-9370-30c8b466814c" />

## Features

- **Batch Processing** - Queue multiple files, apply the same settings, and export all at once
- **Suno Multitrack Mixing** - A stem ZIP appears as one expandable song, plays as a synchronized combined mix, and exports as one mastered track
- **Per-Stem Processing** - Gain, pan, width, mute/solo, EQ, cleanup, compression, polish, and restoration before the song master bus
- **Metadata Editor** - Add title, artist, album, genre, year, track number, and comments per file
- **Loudness Normalization** - Adjustable target LUFS (-20 to -6 LUFS)
- **True Peak Limiting** - 4× inter-sample detection, linked lookahead limiting, and post-render dBTP verification
- **Input Gain Control** - Adjust input level before processing (-12 to +12 dB)
- **Stereo Width** - Control stereo image (0% mono to 200% extra wide) with optional 120Hz mono bass
- **5-Band EQ** - Fine-tune with visual faders and presets (Flat, Vocal Boost, Bass Boost, Bright, Warm, AI Fix)
- **Quick Fix Tools** - Glue compression, clean low end
- **Polish Effects** - Cut mud, add air, tame harshness
- **Analysis-Gated Restoration** - Optional stereo-linked boundary declicking, hard-cut ending repair, and quiet-passage decrackling
- **Real-time Preview** - Hear all changes live before exporting, preview any queued file
- **Clipping Detection** - Visual CLIP indicators on meters
- **High-Quality Export** - WAV output at 44.1/48kHz, 16/24-bit with embedded metadata
- **Post-Render QC** - Verifies integrated LUFS, true peak, loudness range, and limiter gain reduction before writing

## Download

Get the latest release for your platform:

- **Windows** - `.exe` installer
- **macOS** - `.dmg` disk image  
- **Linux** - `.AppImage`

## Usage

1. Drag & drop an audio file (MP3, WAV, FLAC, AAC, M4A, MP4) or a Suno stems ZIP
2. Expand a stem song to balance individual stems, or press **Edit** for detailed stem processing
3. Preview the combined mix with the built-in player
4. Adjust the song-level EQ, loudness, and mastering settings
5. Toggle FX bypass to compare before/after
6. Click "Export WAV" for the combined mastered song

### Restoration

The optional **Restoration** controls apply identically to single-file and
batch exports. They also create an immediate, non-destructive audition buffer
in the player and waveform, with a detection result shown in the Restoration
card. They are off by default, so a source is never altered unexpectedly.

- **Repair Edge Artifacts** detects isolated impulses and short broadband static bursts at either boundary. Bursts are removed only when they are bracketed by silence; isolated impulses are reconstructed with slope-continuous interpolation.
- **Repair Cutoff Ending** runs only when the last 50 ms is still audible and has not naturally decayed relative to the preceding audio. It applies a shaped 650 ms release that reaches digital silence without a new click.
- **Repair Quiet Crackle** uses a stereo-linked, locally adaptive impulse detector in low-level passages. It avoids a broad noise gate, preserving vocal consonants and stereo placement.

No restoration process can recreate musical material that is absent after a true
cut. For that case, the ending repair provides a clean release rather than
inventing a continuation.

### Batch Processing

1. Click "+ Add Files" or drag audio files and Suno stems ZIPs into the batch queue
2. Preview any queued file by clicking the ▶ button to load it into the player
3. Switch to the "Metadata" tab to add tags (title, artist, album, etc.) per file
4. Use "Apply to All" to copy metadata across the entire queue
5. Click "Export All" and choose an output folder

## Building from Source

### Prerequisites

- Use Node.js **22, 24, or 26**. Node 26 is supported by the project; its
  Electron installer needs the project post-install guard included here.
- Ensure npm can access GitHub during installation. Electron downloads its
  platform binary as part of its npm post-install step.

Check your Node version before installing:

```bash
node --version  # should print v22.x, v24.x, or v26.x
```

If you use `nvm`, for example, switch to Node 26 before continuing:

```bash
nvm install 26
nvm use 26
```

### Install and run

```bash
# Install the exact locked dependencies. --foreground-scripts makes any
# Electron download failure visible instead of leaving an incomplete install.
npm ci --foreground-scripts

# Build the app
npm run build

# Run in development
npm run electron:dev

# Build for your platform
npm run electron:build:win    # Windows
npm run electron:build:mac    # macOS
npm run electron:build:linux  # Linux
```

### Electron installation recovery

If `npm run electron:dev` reports `Electron failed to install correctly`, the
Electron binary download did not complete (the expected
`node_modules/electron/path.txt` file is missing). Reinstall from the
lockfile:

```bash
rm -rf node_modules
npm ci --foreground-scripts
npm run electron:dev
```

Do not install with `--ignore-scripts`: that skips Electron's required
post-install download and the Node 26 compatibility guard. If the reinstall
still fails, check the output from `npm ci` for a network, proxy, firewall, or
GitHub-download error.

## Tech Stack

- Electron + Vite
- Pure JavaScript audio processing (no FFmpeg)
- Web Audio API for real-time preview
- ITU-R BS.1770-5 loudness and Annex-2 true-peak measurement
- Native JavaScript WAV encoder


## Changelog

### v2.0.2

**New Features**
- Light/dark mode toggle — click the sun/moon button in the top bar to switch themes
- Theme preference is saved to localStorage and persists across restarts

**Bug Fixes**
- Fixed spectrogram rendering issue caused by devicePixelRatio canvas scaling mismatch

### v2.0.1

**Bug Fixes**
- Fixed metadata tab file list being too narrow to read filenames with many songs queued
- Widened file list panel, increased font size, and expanded scroll area for better readability

### v2.0.0

**New Features**
- Batch processing queue — add multiple files, apply the same mastering settings, and export all at once
- Per-file metadata editor with tabbed UI (title, artist, album, genre, year, track #, comment)
- "Apply to All" button to copy metadata across the entire queue
- WAV metadata embedding via LIST/INFO chunks (INAM, IART, IPRD, IGNR, ICRD, ITRK, ICMT)
- Queue preview — click ▶ on any queued file to load it into the player and audition before exporting
- Files loaded into the player are automatically added to the batch queue
- Single-file "Export WAV" now includes metadata if the file has tags set in the queue
- Multi-file and directory selection dialogs for batch workflows

**Improvements**
- UI yields to the event loop between batch processing steps to prevent freezing
- Batch progress shows per-file status (pending, processing, done, error) and current filename
- Currently loaded file is highlighted in the queue with a "Loaded" indicator

### v1.2.2

**Bug Fixes**
- Fixed incomplete spectrogram rendering (was truncated mid-function)
- Fixed stereo width being applied twice during export (preview and export now match)
- Fixed seek race condition — `isSeeking` flag now properly guards playback restart
- Fixed `stopAudio` ghost callbacks from `onended` firing after stop

**Architecture**
- Extracted shared `createProcessingNodes()` factory for both preview and export chains (DRY)
- Shared `configureFilterNodes()` accepts settings object — no more duplicated filter setup
- Reduced analyser FFT size to 512 for level meters (faster response)
- Spectrogram throttled to ~30fps with offscreen canvas created once outside draw loop

**New Features**
- Undo/redo system (Ctrl+Z / Ctrl+Shift+Z) with 50-level history
- Settings persistence via localStorage — all settings and EQ presets survive restarts
- Keyboard shortcuts: Space (play/pause), Escape (stop), B (bypass), ←→ (seek ±5s), Ctrl+E (export)
- Shortcuts hint bar in the UI
- Status messages now appear as floating toasts that auto-dismiss

**Audio Quality**
- TPDF dithering for 16-bit WAV exports (reduces quantization artifacts)
- Proper 44.1kHz K-weighting filter coefficients for LUFS measurement

**Accessibility**
- ARIA labels on all interactive controls
- ARIA roles on meters, regions, status areas, and progress bars
- `focus-visible` outlines for keyboard navigation
- Decorative elements marked `aria-hidden`

### v1.2.0
- Initial release

## License

ISC
