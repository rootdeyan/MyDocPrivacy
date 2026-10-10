# Obscura

A static, client-side landing page for redacting images and PDFs — including
several at once, kept in the exact order you added them, with each one
**automatically scanned for likely personal information** before you touch
it. Everything — decoding, scanning, drawing the black bars, metadata
stripping, re-encoding, and the "history" list — runs as JavaScript inside
your own browser tab. No file is ever uploaded anywhere; there is no
backend at all.

## Host it on GitHub Pages

1. Create a new GitHub repository and push these files to it (the repo root
   should contain `index.html` directly, not inside a subfolder).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**,
   pick your default branch (e.g. `main`) and `/ (root)`, then **Save**.
4. GitHub gives you a URL like `https://<your-username>.github.io/<repo>/`
   within a minute or two. No build step, no dependencies to install.

To test locally, run any static file server from the project folder
(opening `index.html` directly as `file://` mostly works too, but some
browsers restrict Worker loading from `file://`):

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Automatic scanning, then a review step — not a black box

The moment a file finishes decoding, Obscura scans it for patterns that
usually mean personal information, **before marking anything** — the same
review step, the same detector, and the same confidence levels apply
whether the file is a PDF or **any of the accepted image formats** (JPEG,
PNG, WEBP, GIF, BMP, HEIC/HEIF alike — the scan runs on the decoded canvas,
so the original format doesn't change what gets checked):

- **PDFs** are scanned using their real text layer (via
  [pdf.js](https://mozilla.github.io/pdf.js/)'s text extraction) — fast and
  precise, no OCR involved, works even on documents with hundreds of pages.
- **Images** are scanned with OCR ([Tesseract.js](https://tesseract.projectnaptha.com/),
  **English and Bulgarian**, running fully locally via a self-hosted
  WebAssembly worker — the OCR engine and both languages' trained data live
  in `vendor/tesseract/` in this repo and never touch a third-party server).
  Recognizing two languages at once takes a bit longer than one; a real
  progress bar tracks it either way.

What it looks for, and how confident each category is:

| Category | How it's checked | Confidence |
|---|---|---|
| Email address | pattern match | high |
| IBAN | pattern **+ real mod-97 checksum** | high |
| Card number | pattern **+ real Luhn checksum** | high |
| SSN-style number (`123-45-6789`) | pattern match | high |
| Bulgarian EGN | pattern **+ real mod-11 checksum + plausible birth date** | high |
| Phone number | pattern, requires country code/parens/spacing | medium |
| Possible ID number (bare 8–12 digit run) | pattern only, no checksum exists | **low — always double-check** |

A bare 10-digit number is only ever labeled "Bulgarian EGN" once it passes
the real checksum used by Bulgarian civil numbers; otherwise it falls back
to the generic, lower-confidence "possible ID number" bucket, the same as
any other unformatted digit run.

Every match is shown as a **dashed outline on the preview plus a checklist**
underneath — nothing is blacked out yet. Uncheck anything that's actually
not sensitive (or just a coincidence — an invoice number, a date with no
separators, part of a longer number), then hit **Apply accepted** to turn
the checked ones into real marks. **Reject all** dismisses every suggestion
without marking anything. Clicking a row in the list jumps the preview to
that match (across pages, for PDFs) so you can look at it in context before
deciding.

This is a heuristic scan, not a legal guarantee: it does not recognize
names, faces, addresses, or handwriting, and the "possible ID number"
category in particular can flag ordinary numbers that mean nothing sensitive
(and, much more rarely, miss a real one written in an unusual format). The
review step exists specifically so nothing gets hidden — or left exposed —
without you looking at it first.

## Marking things by hand is still just as easy

- **Drag** across empty space on the preview to black out a region — for
  anything the scan didn't catch (a face, a signature, a name).
- **Click** directly on an existing black mark to remove just that one —
  no separate delete tool, no menus. Works the same for a mark you drew
  and one you accepted from the automatic scan.
- **Undo** removes the last mark; **Clear** wipes every mark on the current
  page/image.

## Multiple files, in order

Select or drop several files at once (or add more at any point). Each one
gets a permanent number — the order it was added this session, starting at
01 — shown in a "Files this session" list. That number never changes even
if you remove an earlier file, is used to **prefix the exported filename**
(`03-photo-obscured.png`) so your Downloads folder sorts back into upload
order, and lets you freely switch between files without losing any file's
marks or pending review. After exporting one file, the next not-yet-exported
one opens automatically.

## What export actually does

- **Images** (JPEG, PNG, WEBP, GIF, BMP, HEIC/HEIF): re-encoded from a
  fresh canvas, which is what discards EXIF/metadata (GPS, device,
  timestamps, author) even if nothing was marked. A phone photo's embedded
  rotation is respected during decoding. JPEG and WEBP inputs export as the
  same format; GIF, BMP and HEIC/HEIF export as PNG instead, since GIF
  loses its animation on a canvas anyway and browsers can't write BMP or
  HEIC files themselves. HEIC/HEIF (the format iPhones save photos in by
  default) is decoded with a local, self-hosted converter
  ([heic2any](https://github.com/alexcorvi/heic2any)) since browsers other
  than Safari can't read it at all.
- **PDFs**: if anything was marked, every page is **flattened to an image**
  and reassembled into a new PDF. This is deliberate — drawing a black box
  over a PDF's existing text objects without flattening would leave that
  text selectable/extractable underneath it, which is not real redaction.
  The trade-off is that the exported PDF's text is no longer
  selectable/searchable. If nothing was marked, the original text layer is
  kept, and only metadata (title, author, subject, keywords, producer,
  creator, dates, XMP) is stripped.
- **History**: every exported file's name, size, type, and a thumbnail are
  saved to `localStorage`. The file itself is also cached there for
  one-click re-download only if it's small enough to fit (`localStorage` is
  capped around 5–10 MB total in most browsers).

## Mobile

A dedicated smartphone breakpoint stacks the toolbar, findings panel, and
export footer vertically, grows touch targets to 38px, and caps the canvas
height so the download button never gets pushed off-screen. Marking (and
removing) regions uses Pointer Events, so it works the same with a finger
as a mouse.

## Known limitations, stated plainly

- **Not a legal/compliance tool.** It's a heuristic assistant with a
  mandatory review step, not a certified PII scanner. Treat every match —
  especially "possible ID number" — as a suggestion to verify, not a fact.
- **No name/face/handwriting recognition.** Those need to be marked by hand.
- OCR covers English and Bulgarian. It will still generally find emails,
  phone numbers, card numbers and digit sequences inside other-language
  documents (those are Latin/numeric regardless of surrounding language),
  but won't reliably read body text in a third script, so anything
  sensitive written only in, say, Arabic or Greek won't be caught
  automatically. Scanning itself works identically across every accepted
  image format (JPEG/PNG/WEBP/GIF/BMP) and PDF — it's the same detector
  either way, just fed by OCR for images and a real text layer for PDFs.
- SVG is intentionally not accepted, since it's a script-capable XML format
  rather than a flat image and doesn't fit the canvas-redaction model safely.
- HEIC/HEIF decoding runs in pure JavaScript (no HEIC-capable WASM was
  vendored), so it's slower than the other formats — noticeable on large
  photos or older devices, and it also means a burst/multi-shot HEIC file
  is only decoded to its first image, not every shot in it.
- Up to 20 files can be queued in one browser tab session, each up to 60 MB.
  A PDF with very many pages takes longer to scan and flatten, since every
  page is processed — the progress bar reflects real per-page progress.
- Fonts are loaded from Google Fonts; icons and OCR are already self-hosted
  in this repo. Delete the two Google Fonts `<link>` tags in `index.html`
  and self-host those font files too for zero external requests at runtime.

## Testing notes

The PII regex/checksum logic (Luhn for cards, mod-97 for IBAN, mod-11 +
plausible birth date for Bulgarian EGN, and the false-positive guards
around phone numbers vs. dates/invoice numbers) was run through an explicit
pass/fail test battery in Node covering true positives, corrupted checksums
(each correctly rejected), and known-tricky false positives (dates, invoice
numbers, prices, building numbers) — all passing. The pdf.js and Tesseract.js integration
(option names, return shapes like `data.words[].bbox`, the LSTM-only core
file selection, the trained-data path convention) was verified against
those libraries' actual TypeScript type definitions and source code rather
than assumed from memory or documentation prose, since the docs for at
least one of them contain a stale/simplified example. The `heic2any`
integration was checked the same way: confirmed it embeds its worker via a
Blob URL (so only one file needed vendoring, no separate WASM path to get
wrong), confirmed it makes no external network calls, and confirmed its
function signature against its type definitions. Every DOM id
referenced from JavaScript was cross-checked against the HTML, and all
files were syntax-checked.

What could **not** be verified here: actual OCR accuracy on a real image,
actual visual rendering, and the full click/drag interaction feel, since
this environment has no real browser to run one in. Please try it with a
real file before relying on it for anything sensitive, and open the
DevTools console if anything looks off.

## File structure

```
index.html
css/style.css
js/app.js                  UI wiring: queue, scanning flow, drawing, history
js/processors.js           Image/PDF decoding, redaction compositing, export
js/scan.js                 PII detection (regex + checksums), PDF text scan, OCR
js/vendor/                 Local copies of pdf.js + pdf-lib
vendor/fontawesome/        Local copy of Font Awesome Free (solid + regular)
vendor/tesseract/          Local copy of Tesseract.js (worker, core, English + Bulgarian data)
vendor/heic2any/           Local, self-contained HEIC/HEIF-to-PNG decoder
```
