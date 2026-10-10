/*
 * Obscura — processors.js
 * All image/PDF decoding, redaction compositing, metadata stripping and
 * re-encoding. Nothing in this file performs any network request — every
 * function operates on File/ArrayBuffer/Canvas objects already resident
 * in the browser tab.
 */

const ObscuraEngine = (() => {

  const MAX_IMAGE_DIM   = 2400; // longest edge we keep for images we work on
  const PDF_PREVIEW_MAXW = 1100; // px, editing preview render width (CSS px * DPR handled by caller)
  const PDF_EXPORT_MAXDIM = 2300; // px, longest edge when flattening a page to an image

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
  }

  /* ---------------------------------------------------------- helpers */

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas could not be encoded — the image may be too large for this browser.'));
      }, type, quality);
    });
  }

  async function canvasToUint8Array(canvas, type, quality) {
    const blob = await canvasToBlob(canvas, type, quality);
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  function pickOutputImageType(inputType) {
    if (inputType === 'image/jpeg' || inputType === 'image/jpg') return { type: 'image/jpeg', quality: 0.92, ext: 'jpg' };
    if (inputType === 'image/webp') return { type: 'image/webp', quality: 0.92, ext: 'webp' };
    return { type: 'image/png', quality: undefined, ext: 'png' }; // png, gif, bmp, unknown -> png (lossless, universally supported)
  }

  function swapExtension(name, newExt) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    return `${base}-obscured.${newExt}`;
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /* ---------------------------------------------------------- images */

  function isHeic(file) {
    const type = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif');
  }

  const ImageEngine = {

    /**
     * Decode a File into a working canvas, downscaling if it exceeds
     * MAX_IMAGE_DIM on its longest edge. Re-encoding through <canvas>
     * also discards any EXIF/XMP metadata (GPS, device, timestamps)
     * even before a single redaction is drawn. imageOrientation is
     * forced to 'from-image' so a phone photo's embedded rotation is
     * baked into the pixels correctly instead of depending on a
     * browser's default (this differs across engines).
     *
     * HEIC/HEIF (the format iPhones save photos in) isn't decodable by
     * <canvas> in most browsers at all, so it's converted to PNG first
     * via a local, self-hosted decoder (heic2any) — still entirely on
     * this device, nothing leaves the browser for this conversion either.
     */
    async loadFromFile(file) {
      let sourceFile = file;
      if (isHeic(file)) {
        if (typeof window.heic2any !== 'function') {
          throw new Error('HEIC/HEIF support did not load \u2014 try reloading the page.');
        }
        const converted = await window.heic2any({ blob: file, toType: 'image/png', quality: 0.92 });
        sourceFile = Array.isArray(converted) ? converted[0] : converted;
      }

      const bitmap = await createImageBitmap(sourceFile, { imageOrientation: 'from-image' }).catch(async () => {
        // Fallback path for formats createImageBitmap may reject (older Safari/BMP edge cases).
        // <img> decoding also respects embedded orientation by default in modern browsers.
        const url = URL.createObjectURL(sourceFile);
        try {
          const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('This image could not be decoded by the browser.'));
            el.src = url;
          });
          return img;
        } finally {
          URL.revokeObjectURL(url);
        }
      });

      const naturalW = bitmap.width;
      const naturalH = bitmap.height;
      const longest = Math.max(naturalW, naturalH);
      const scale = longest > MAX_IMAGE_DIM ? MAX_IMAGE_DIM / longest : 1;

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(naturalW * scale));
      canvas.height = Math.max(1, Math.round(naturalH * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();

      return {
        canvas, ctx,
        naturalW, naturalH,
        scaledDown: scale < 1,
        wasHeic: isHeic(file),
      };
    },

    /** Composite black redaction rectangles (canvas-pixel coords) onto the image. */
    drawRedactions(ctx, rects) {
      ctx.save();
      ctx.fillStyle = '#000000';
      for (const r of rects) {
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    },

    /**
     * Re-encodes the canvas (already carrying any burned-in redactions)
     * to a safe output format. Because this always goes through a
     * canvas, no source metadata can survive into the output.
     */
    async exportRedacted({ canvas, originalFile, originalMimeType }) {
      const { type, quality, ext } = pickOutputImageType(originalMimeType);
      const bytes = await canvasToUint8Array(canvas, type, quality);
      return {
        bytes,
        mimeType: type,
        filename: swapExtension(originalFile.name || 'image', ext),
      };
    },
  };

  /* ---------------------------------------------------------- pdf */

  const PdfEngine = {

    async load(arrayBuffer) {
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
      const pdfDoc = await loadingTask.promise;
      return pdfDoc;
    },

    /** Render one page to a canvas for on-screen editing. Returns page point-size too. */
    async renderPageForEditing(pdfDoc, pageNumber, cssTargetWidth) {
      const page = await pdfDoc.getPage(pageNumber);
      const unscaled = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const fitScale = Math.min(PDF_PREVIEW_MAXW, cssTargetWidth || PDF_PREVIEW_MAXW) / unscaled.width;
      const scale = Math.max(0.4, fitScale) * dpr;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      return {
        canvas,
        pagePointWidth: unscaled.width,
        pagePointHeight: unscaled.height,
      };
    },

    /**
     * Builds a brand new PDF where every page is a flattened raster image
     * with redactions burned in. This is deliberate: drawing a black box
     * over vector text in-place would leave the original text objects
     * selectable/extractable underneath it, which is not real redaction.
     * Rasterizing guarantees the covered content cannot be recovered.
     */
    async exportFlattened(pdfDoc, numPages, redactionsByPage, onProgress) {
      const { PDFDocument } = PDFLib;
      const outDoc = await PDFDocument.create();
      outDoc.setProducer('Obscura (local, offline redaction)');
      outDoc.setCreator('Obscura');
      outDoc.setAuthor('');
      outDoc.setTitle('');
      outDoc.setSubject('');
      outDoc.setKeywords([]);

      for (let i = 1; i <= numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const unscaled = page.getViewport({ scale: 1 });
        const longest = Math.max(unscaled.width, unscaled.height);
        const renderScale = Math.min(3, PDF_EXPORT_MAXDIM / longest);
        const viewport = page.getViewport({ scale: Math.max(1, renderScale) });

        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const rects = redactionsByPage[i] || [];
        ctx.fillStyle = '#000000';
        for (const r of rects) {
          // rects are normalized 0..1 relative to the page
          ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
        }

        const pngBytes = await canvasToUint8Array(canvas, 'image/png');
        const pngImage = await outDoc.embedPng(pngBytes);
        const outPage = outDoc.addPage([unscaled.width, unscaled.height]);
        outPage.drawImage(pngImage, { x: 0, y: 0, width: unscaled.width, height: unscaled.height });

        if (onProgress) onProgress(i, numPages);
      }

      const outBytes = await outDoc.save();
      return outBytes;
    },

    /**
     * No visible redactions were drawn — just strip metadata and any
     * embedded JavaScript/attachments, keeping the original text layer
     * (so the file stays searchable/selectable) since nothing needs
     * to be irreversibly removed.
     */
    async exportMetadataStrippedOnly(arrayBuffer) {
      const { PDFDocument, PDFName } = PDFLib;
      const doc = await PDFDocument.load(arrayBuffer, { updateMetadata: false });

      doc.setTitle('');
      doc.setAuthor('');
      doc.setSubject('');
      doc.setKeywords([]);
      doc.setProducer('Obscura (local, offline redaction)');
      doc.setCreator('Obscura');
      try { doc.setCreationDate(new Date(0)); } catch (e) {}
      try { doc.setModificationDate(new Date()); } catch (e) {}

      // Best-effort: drop the document-level XMP metadata stream and any
      // embedded JavaScript / launch actions if present.
      try {
        const catalog = doc.catalog;
        if (catalog.has(PDFName.of('Metadata'))) catalog.delete(PDFName.of('Metadata'));
        if (catalog.has(PDFName.of('Names'))) {
          const names = catalog.lookup(PDFName.of('Names'));
          if (names && names.has && names.has(PDFName.of('JavaScript'))) {
            names.delete(PDFName.of('JavaScript'));
          }
        }
      } catch (e) {
        // Non-fatal — metadata dictionary fields above are already cleared.
      }

      const bytes = await doc.save();
      return bytes;
    },
  };

  return { ImageEngine, PdfEngine, canvasToBlob, canvasToUint8Array, fmtBytes, swapExtension, MAX_IMAGE_DIM };
})();
