/*
 * Obscura — scan.js
 * Automatic sensitive-data detection. Two paths:
 *  - PDFs with a real text layer: read text via pdf.js's getTextContent()
 *    (no OCR, no rendering needed — fast and precise).
 *  - Images: OCR via a local, self-hosted Tesseract.js worker (English).
 * Both feed the same regex/checksum-based PII detector below. Nothing here
 * performs a network request for the file being scanned; the only requests
 * are for Obscura's own local OCR engine files under vendor/tesseract/,
 * fetched from this same site the first time OCR is actually used.
 */

const ObscuraScan = (() => {

  /* ---------------------------------------------------------- PII detectors
   * Every detector is validated (Luhn for cards, mod-97 checksum for IBAN)
   * where a real checksum exists, which is what keeps false positives low
   * for those categories. "Possible ID number" has no checksum to lean on,
   * so it's intentionally flagged as lower confidence — expect to double
   * check those in the review step rather than trust them blindly.
   */

  function luhnValid(digits) {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }

  function ibanValid(raw) {
    const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length < 15 || s.length > 34) return false;
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
    const rearranged = s.slice(4) + s.slice(0, 4);
    const numeric = rearranged.replace(/[A-Z]/g, (ch) => (ch.charCodeAt(0) - 55).toString());
    let remainder = 0;
    for (let i = 0; i < numeric.length; i += 7) {
      remainder = parseInt(String(remainder) + numeric.slice(i, i + 7), 10) % 97;
    }
    return remainder === 1;
  }

  /**
   * Bulgarian EGN (Единен граждански номер / national civil number):
   * a real checksum (mod-11 over fixed weights) plus a plausible
   * encoded birth date, so this is validated rather than a guess —
   * the same principle as Luhn for cards or mod-97 for IBAN.
   */
  function egnValid(raw) {
    const s = raw.replace(/\D/g, '');
    if (s.length !== 10) return false;
    const d = s.split('').map(Number);
    const month = d[2] * 10 + d[3];
    const validMonth = (month >= 1 && month <= 12) || (month >= 21 && month <= 32) || (month >= 41 && month <= 52);
    if (!validMonth) return false;
    const day = d[4] * 10 + d[5];
    if (day < 1 || day > 31) return false;
    const weights = [2, 4, 8, 5, 10, 9, 7, 3, 6];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += d[i] * weights[i];
    let check = sum % 11;
    if (check === 10) check = 0;
    return check === d[9];
  }

  const DETECTORS = [
    {
      category: 'email', label: 'Email', icon: 'fa-at', confidence: 3,
      re: /\b[a-zA-Z0-9.+_-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\b/g,
      validate: () => true,
    },
    {
      category: 'iban', label: 'IBAN', icon: 'fa-building-columns', confidence: 3,
      re: /\b[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}\b/g,
      validate: (m) => ibanValid(m),
    },
    {
      category: 'ssn', label: 'SSN-style number', icon: 'fa-id-card', confidence: 3,
      re: /\b\d{3}-\d{2}-\d{4}\b/g,
      validate: () => true,
    },
    {
      category: 'egn', label: 'Bulgarian EGN', icon: 'fa-id-card', confidence: 3,
      re: /\b\d{10}\b/g,
      validate: (m) => egnValid(m),
    },
    {
      category: 'card', label: 'Card number', icon: 'fa-credit-card', confidence: 3,
      re: /\b(?:\d[ -]?){12,19}\b/g,
      validate: (m) => {
        const digits = m.replace(/[ -]/g, '');
        return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
      },
    },
    {
      category: 'phone', label: 'Phone number', icon: 'fa-phone', confidence: 2,
      re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}/g,
      validate: (m) => {
        const digits = m.replace(/\D/g, '');
        if (digits.length < 7 || digits.length > 15) return false;
        const hasPlusOrParen = /[+()]/.test(m);
        const hasHyphen = /-/.test(m);
        if (hasHyphen && !hasPlusOrParen) return false;
        return /[\s().-]/.test(m);
      },
    },
    {
      category: 'id', label: 'Possible ID number', icon: 'fa-hashtag', confidence: 1,
      re: /\b\d{8,12}\b/g,
      validate: () => true,
    },
  ];

  /** Runs every detector over `text`, resolves overlaps (higher confidence
   *  and longer matches win), and returns non-overlapping matches in
   *  reading order: [{ start, end, category, label, icon, confidence, text }] */
  function detectPII(text) {
    const candidates = [];
    for (const det of DETECTORS) {
      det.re.lastIndex = 0;
      let m;
      while ((m = det.re.exec(text))) {
        const match = m[0];
        if (det.validate(match)) {
          candidates.push({ start: m.index, end: m.index + match.length, category: det.category, label: det.label, icon: det.icon, confidence: det.confidence, text: match });
        }
        if (match.length === 0) det.re.lastIndex++;
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const accepted = [];
    for (const c of candidates) {
      const overlaps = accepted.some((a) => c.start < a.end && c.end > a.start);
      if (!overlaps) accepted.push(c);
    }
    accepted.sort((a, b) => a.start - b.start);
    return accepted;
  }

  /* ---------------------------------------------------------- PDF text-layer scan */

  /**
   * Scans every page of a pdf.js document for PII using its real text
   * layer — no rendering or OCR needed, so this is fast even for PDFs
   * with many pages. Returns { pageNum: [{ category, label, text, rect }] }
   * where rect is normalized 0..1 relative to that page.
   */
  async function scanPdfDocument(pdfDoc, onProgress) {
    const results = {};
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      let text = '';
      const spans = [];
      for (const item of content.items) {
        if (!item.str) { text += ' '; continue; }
        const tx = item.transform;
        const x0 = tx[4];
        const y0 = tx[5];
        const w = item.width || Math.abs(tx[0]) * item.str.length * 0.5;
        const h = item.height || Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
        const start = text.length;
        text += item.str;
        spans.push({
          start, end: text.length,
          left: x0 / viewport.width,
          right: (x0 + w) / viewport.width,
          bottom: 1 - (y0 / viewport.height),
          top: 1 - ((y0 + h * 1.15) / viewport.height),
        });
        text += item.hasEOL ? '\n' : ' ';
      }

      const matches = detectPII(text);
      if (matches.length) {
        results[p] = matches.map((m) => {
          const touched = spans.filter((s) => s.start < m.end && s.end > m.start);
          if (!touched.length) return null;
          const left = Math.min(...touched.map((s) => s.left));
          const right = Math.max(...touched.map((s) => s.right));
          const top = Math.min(...touched.map((s) => s.top));
          const bottom = Math.max(...touched.map((s) => s.bottom));
          return {
            category: m.category, label: m.label, icon: m.icon, text: m.text,
            rect: {
              x: Math.max(0, left), y: Math.max(0, top),
              w: Math.min(1, right) - Math.max(0, left),
              h: Math.min(1, bottom) - Math.max(0, top),
            },
          };
        }).filter(Boolean);
      }
      if (onProgress) onProgress(p, pdfDoc.numPages);
    }
    return results;
  }

  /* ---------------------------------------------------------- image OCR scan */

  let tesseractWorkerPromise = null;

  function resolveLocalPath(relPath) {
    // Resolve relative to this page's own directory, so it works whether the
    // site is served from a domain root or a GitHub Pages project subpath
    // (https://user.github.io/repo/...), and inside the Worker context too.
    return new URL(relPath, new URL('.', document.baseURI)).href;
  }

  async function getTesseractWorker(onLog) {
    if (!tesseractWorkerPromise) {
      tesseractWorkerPromise = Tesseract.createWorker('eng+bul', 1, {
        workerPath: resolveLocalPath('worker.min.js'),
        corePath: resolveLocalPath('./'),
        langPath: resolveLocalPath('./'),
        gzip: true,
        logger: onLog || (() => {}),
      });
    }
    return tesseractWorkerPromise;
  }

  /**
   * OCRs an image canvas locally and returns PII matches with rects
   * normalized 0..1 relative to that canvas.
   */
  async function scanImageCanvas(canvas, onProgress) {
    const worker = await getTesseractWorker((m) => {
      if (onProgress && m.status === 'recognizing text') onProgress(m.progress);
    });
    const { data } = await worker.recognize(canvas);
    const words = (data.words || []).filter((w) => w.text && w.text.trim());

    let text = '';
    const spans = [];
    for (const w of words) {
      const start = text.length;
      text += w.text;
      spans.push({
        start, end: text.length,
        left: w.bbox.x0 / canvas.width,
        right: w.bbox.x1 / canvas.width,
        top: w.bbox.y0 / canvas.height,
        bottom: w.bbox.y1 / canvas.height,
      });
      text += ' ';
    }

    const matches = detectPII(text);
    return matches.map((m) => {
      const touched = spans.filter((s) => s.start < m.end && s.end > m.start);
      if (!touched.length) return null;
      const left = Math.min(...touched.map((s) => s.left));
      const right = Math.max(...touched.map((s) => s.right));
      const top = Math.min(...touched.map((s) => s.top));
      const bottom = Math.max(...touched.map((s) => s.bottom));
      return {
        category: m.category, label: m.label, icon: m.icon, text: m.text,
        rect: { x: left, y: top, w: right - left, h: bottom - top },
      };
    }).filter(Boolean);
  }

  return { detectPII, luhnValid, ibanValid, scanPdfDocument, scanImageCanvas };
})();
