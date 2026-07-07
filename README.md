# Markup Studio

Pure-browser PDF viewer and markup tool for architectural drawings (Chrome/Edge). Bluebeam-lite — runs locally with no server.

## Quick start

```bash
cd markup-studio
npm install
npm run dev
```

Open the URL shown (typically `http://localhost:5173`). Use **File → Open** or drag a PDF onto the workspace.

## Build

```bash
npm run build
npm run preview
```

## Features

- **View**: multi-page PDFs, pan/zoom, continuous/single mode, thumbnails, bookmarks panel, status-bar page/zoom/scale controls
- **Markup**: rectangle, ellipse, polygon (Shift+P, Shift on close = revision cloud), line, polyline, highlighter, text, callout, sticky
- **Measure**: calibrate, dimension, polyline length, area, angle — imperial ft-in, no decimals
- **Edit**: undo/redo, cut/copy/paste, paste-in-place (Ctrl+Shift+V), duplicate, delete, flatten whole document
- **Save**: Ctrl+S in place (File System Access API), Save As; custom metadata for lossless reopen
- **Advanced**: multi-doc tabs, split view (draggable divider), overlay bar, raster snip tool, insert/rotate pages

## Stack

- Vite + TypeScript
- PDF.js (render)
- pdf-lib (export/flatten)
- File System Access API (open/save in place)

## Note on Google Drive

Exclude `node_modules/` and `dist/` from Drive sync to avoid syncing thousands of build files.
