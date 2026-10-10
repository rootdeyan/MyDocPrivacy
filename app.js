/*
 * Obscura — app.js
 * UI state and wiring. Image/PDF redaction lives in processors.js,
 * automatic detection lives in scan.js.
 *
 * Multi-file model: every uploaded file becomes a queue item stamped with
 * a permanent sequence number (the order it was added this session). Only
 * one item is edited on the canvas at a time, but each item keeps its own
 * state, so switching between files never loses marks or mixes them up.
 *
 * Per-file flow: decode -> automatically scan for PII -> show suggested
 * matches as dashed outlines + a checklist (nothing is redacted yet) ->
 * "Apply accepted" burns the accepted ones in as real marks, same as a
 * hand-drawn one. Dragging empty canvas adds a manual mark; clicking an
 * existing mark removes just that one.
 */
(() => {
  'use strict';

  const MAX_FILE_BYTES = 60 * 1024 * 1024;
  const MAX_PDF_PAGES_WARN = 60;
  const MAX_QUEUE_ITEMS = 20;
  const HISTORY_KEY = 'obscura.history.v1';
  const HISTORY_DATAURL_LIMIT = 2_500_000; // bytes, before base64 inflation
  const HISTORY_MAX_ENTRIES = 40;

  const $ = (id) => document.getElementById(id);

  const dropzone      = $('dropzone');
  const fileInput     = $('fileInput');
  const queuePanel    = $('queuePanel');
  const queueList     = $('queueList');
  const queueCount    = $('queueCount');
  const editorPanel   = $('editorPanel');
  const fileNameEl    = $('fileName');
  const fileMetaEl    = $('fileMeta');
  const pdfNav        = $('pdfNav');
  const prevPageBtn   = $('prevPage');
  const nextPageBtn   = $('nextPage');
  const pageIndicator = $('pageIndicator');
  const undoBtn       = $('undoMark');
  const clearBtn      = $('clearMarks');
  const removeFileBtn = $('removeFile');
  const editorHint    = $('editorHint');
  const findingsPanel = $('findingsPanel');
  const findingsSummary = $('findingsSummary');
  const findingsList  = $('findingsList');
  const applyFindingsBtn = $('applyFindings');
  const rejectAllFindingsBtn = $('rejectAllFindings');
  const canvasStage   = $('canvasStage');
  const workCanvas    = $('workCanvas');
  const workCtx       = workCanvas.getContext('2d');
  const progressWrap  = $('progressWrap');
  const progressBar   = $('progressBar');
  const progressLabel = $('progressLabel');
  const markCountEl   = $('markCount');
  const exportBtn     = $('exportBtn');
  const exportBtnLabel= $('exportBtnLabel');
  const historyList   = $('historyList');
  const historyEmpty  = $('historyEmpty');
  const clearHistoryBtn = $('clearHistory');
  const toastEl       = $('toast');

  const { ImageEngine, PdfEngine, fmtBytes, swapExtension } = ObscuraEngine;
  const { scanPdfDocument, scanImageCanvas } = ObscuraScan;

  /* ------------------------------------------------------------ state */

  let queue = [];          // ordered list of queue items (see enqueueFiles)
  let seqCounter = 0;      // ever-increasing; a file's number never changes or gets reused
  let activeId = null;

  // Mirrors of the active queue item's own state, kept in sync by setActive().
  let currentFile = null;
  let currentType = null;
  let imageState  = null;  // { pristineCanvas, redactions:[], findings:[] }
  let pdfState    = null;  // { pdfDoc, numPages, currentPage, arrayBuffer, redactionsByPage:{}, findingsByPage:{}, pageCache:{} }
  let drawing = false, startX = 0, startY = 0;

  /* ------------------------------------------------------------ toast */

  let toastTimer = null;
  function toast(msg, ms = 3400) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  /* ------------------------------------------------------------ progress bar */

  function showProgress(label) {
    progressWrap.classList.add('active');
    progressWrap.setAttribute('aria-hidden', 'false');
    progressLabel.textContent = label;
    setProgress(0.06);
  }
  function setProgress(fraction) {
    progressBar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }
  function hideProgressSoon() {
    setTimeout(() => {
      progressWrap.classList.remove('active');
      progressWrap.setAttribute('aria-hidden', 'true');
      setProgress(0);
    }, 400);
  }

  /* ------------------------------------------------------------ file type detection */

  function detectFileType(file) {
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    // Explicit allow-list (matches what the page advertises). A blanket
    // "image/*" check would also let through formats that were never meant
    // to be supported, such as SVG or TIFF dropped onto the page.
    const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif'];
    const imageMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-ms-bmp', 'image/heic', 'image/heif'];
    if (imageMimes.includes(type) || imageExts.some((ext) => name.endsWith(ext))) return 'image';
    return null;
  }

  function guessImageMime(file) {
    if (file.type) return file.type;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.bmp')) return 'image/bmp';
    if (name.endsWith('.heic') || name.endsWith('.heif')) return 'image/heic';
    return 'image/png';
  }

  function padSeq(n) { return String(n).padStart(2, '0'); }
  function findingId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ------------------------------------------------------------ coordinate helpers */

  function canvasCoords(evt) {
    const rect = workCanvas.getBoundingClientRect();
    const scaleX = workCanvas.width / rect.width;
    const scaleY = workCanvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
    };
  }

  function currentRedactionArray() {
    if (currentType === 'image') return imageState.redactions;
    if (currentType === 'pdf') {
      const p = pdfState.currentPage;
      if (!pdfState.redactionsByPage[p]) pdfState.redactionsByPage[p] = [];
      return pdfState.redactionsByPage[p];
    }
    return [];
  }

  function currentPageFindings() {
    if (currentType === 'image') return imageState.findings || [];
    if (currentType === 'pdf') return (pdfState.findingsByPage[pdfState.currentPage] || []);
    return [];
  }

  function currentPristineCanvas() {
    if (currentType === 'image') return imageState.pristineCanvas;
    if (currentType === 'pdf') return pdfState.pageCache[pdfState.currentPage].pristineCanvas;
    return null;
  }

  function rectContainsPoint(r, xNorm, yNorm) {
    return xNorm >= r.x && xNorm <= r.x + r.w && yNorm >= r.y && yNorm <= r.y + r.h;
  }

  /* ------------------------------------------------------------ drawing / redraw */

  function redrawCurrent() {
    const pristine = currentPristineCanvas();
    if (!pristine) return;
    workCtx.clearRect(0, 0, workCanvas.width, workCanvas.height);
    workCtx.drawImage(pristine, 0, 0);

    // Pending (not yet applied) automatic suggestions: dashed outline only.
    const pending = currentPageFindings();
    workCtx.save();
    workCtx.setLineDash([6, 4]);
    workCtx.lineWidth = Math.max(1.5, workCanvas.width * 0.0018);
    for (const f of pending) {
      workCtx.strokeStyle = f.accepted ? '#E8B04B' : '#5C6675';
      workCtx.strokeRect(f.rect.x * workCanvas.width, f.rect.y * workCanvas.height, f.rect.w * workCanvas.width, f.rect.h * workCanvas.height);
    }
    workCtx.restore();

    // Applied marks: solid black.
    const rects = currentRedactionArray();
    workCtx.save();
    workCtx.fillStyle = '#000000';
    for (const r of rects) {
      workCtx.fillRect(r.x * workCanvas.width, r.y * workCanvas.height, r.w * workCanvas.width, r.h * workCanvas.height);
    }
    workCtx.restore();
  }

  function updateMarkCount() {
    if (currentType === 'image') {
      const n = imageState.redactions.length;
      markCountEl.textContent = `${n} region${n === 1 ? '' : 's'} marked`;
    } else if (currentType === 'pdf') {
      const here = (pdfState.redactionsByPage[pdfState.currentPage] || []).length;
      const total = Object.values(pdfState.redactionsByPage).reduce((s, a) => s + (a ? a.length : 0), 0);
      markCountEl.textContent = `${here} on this page \u00b7 ${total} total`;
    } else {
      markCountEl.textContent = '0 regions marked';
    }
  }

  workCanvas.addEventListener('pointerdown', (e) => {
    if (!currentType) return;
    workCanvas.setPointerCapture(e.pointerId);
    const { x, y } = canvasCoords(e);
    drawing = true; startX = x; startY = y;
  });

  workCanvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const { x, y } = canvasCoords(e);
    const rx = Math.min(x, startX), ry = Math.min(y, startY);
    const rw = Math.abs(x - startX), rh = Math.abs(y - startY);
    redrawCurrent();
    workCtx.save();
    workCtx.fillStyle = 'rgba(0,0,0,0.55)';
    workCtx.strokeStyle = '#E8B04B';
    workCtx.lineWidth = Math.max(1.5, workCanvas.width * 0.0016);
    workCtx.fillRect(rx, ry, rw, rh);
    workCtx.strokeRect(rx, ry, rw, rh);
    workCtx.restore();
  });

  function endDraw(e) {
    if (!drawing) return;
    drawing = false;
    const { x, y } = canvasCoords(e);
    const rw = Math.abs(x - startX), rh = Math.abs(y - startY);

    if (rw <= 6 && rh <= 6) {
      // A tap/click rather than a drag: remove an existing mark under the point, if any.
      const xNorm = startX / workCanvas.width, yNorm = startY / workCanvas.height;
      const rects = currentRedactionArray();
      for (let i = rects.length - 1; i >= 0; i--) {
        if (rectContainsPoint(rects[i], xNorm, yNorm)) { rects.splice(i, 1); break; }
      }
      redrawCurrent();
      updateMarkCount();
      return;
    }

    const rx = Math.min(x, startX), ry = Math.min(y, startY);
    currentRedactionArray().push({
      x: rx / workCanvas.width, y: ry / workCanvas.height,
      w: rw / workCanvas.width, h: rh / workCanvas.height,
    });
    redrawCurrent();
    updateMarkCount();
  }
  workCanvas.addEventListener('pointerup', endDraw);
  workCanvas.addEventListener('pointercancel', endDraw);

  undoBtn.addEventListener('click', () => {
    if (!currentType) return;
    currentRedactionArray().pop();
    redrawCurrent();
    updateMarkCount();
  });
  clearBtn.addEventListener('click', () => {
    if (!currentType) return;
    currentRedactionArray().length = 0;
    redrawCurrent();
    updateMarkCount();
  });

  /* ------------------------------------------------------------ findings (review panel) */

  function allPendingFindings() {
    if (currentType === 'image') return (imageState.findings || []).map((f) => ({ ...f, page: null }));
    if (currentType === 'pdf') {
      const out = [];
      for (const [page, arr] of Object.entries(pdfState.findingsByPage)) {
        for (const f of arr) out.push({ ...f, page: Number(page) });
      }
      out.sort((a, b) => a.page - b.page);
      return out;
    }
    return [];
  }

  function renderFindingsPanel() {
    const all = allPendingFindings();
    if (!all.length) {
      findingsPanel.hidden = true;
      return;
    }
    findingsPanel.hidden = false;
    const acceptedCount = all.filter((f) => f.accepted).length;
    findingsSummary.innerHTML = `<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> ${all.length} possible match${all.length === 1 ? '' : 'es'} found \u2014 ${acceptedCount} selected`;

    findingsList.innerHTML = '';
    for (const f of all) {
      const row = document.createElement('div');
      row.className = 'finding-row' + (f.confidence <= 1 ? ' low-confidence' : '');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = f.accepted;
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', () => {
        toggleFindingAccepted(f.id, checkbox.checked);
      });

      const icon = document.createElement('i');
      icon.className = 'finding-icon fa-solid ' + (f.icon || 'fa-tag');
      icon.setAttribute('aria-hidden', 'true');

      const body = document.createElement('div');
      body.className = 'finding-body';
      const label = document.createElement('div');
      label.className = 'finding-label';
      label.textContent = f.label + (f.confidence <= 1 ? ' \u2014 double-check this one' : '');
      const text = document.createElement('div');
      text.className = 'finding-text';
      text.textContent = f.text;
      body.append(label, text);

      row.append(checkbox, icon, body);
      if (f.page) {
        const pageTag = document.createElement('span');
        pageTag.className = 'finding-page';
        pageTag.textContent = `p.${f.page}`;
        row.appendChild(pageTag);
      }

      row.addEventListener('click', async () => {
        if (currentType === 'pdf' && f.page && f.page !== pdfState.currentPage) {
          pdfState.currentPage = f.page;
          await renderCurrentPdfPage();
        } else {
          redrawCurrent();
        }
      });

      findingsList.appendChild(row);
    }
  }

  function toggleFindingAccepted(id, value) {
    if (currentType === 'image') {
      const f = (imageState.findings || []).find((x) => x.id === id);
      if (f) f.accepted = value;
    } else if (currentType === 'pdf') {
      for (const arr of Object.values(pdfState.findingsByPage)) {
        const f = arr.find((x) => x.id === id);
        if (f) f.accepted = value;
      }
    }
    redrawCurrent();
    renderFindingsPanel();
  }

  applyFindingsBtn.addEventListener('click', () => {
    let applied = 0;
    if (currentType === 'image') {
      for (const f of imageState.findings || []) {
        if (f.accepted) { imageState.redactions.push({ ...f.rect }); applied++; }
      }
      imageState.findings = [];
    } else if (currentType === 'pdf') {
      for (const [page, arr] of Object.entries(pdfState.findingsByPage)) {
        for (const f of arr) {
          if (f.accepted) {
            if (!pdfState.redactionsByPage[page]) pdfState.redactionsByPage[page] = [];
            pdfState.redactionsByPage[page].push({ ...f.rect });
            applied++;
          }
        }
      }
      pdfState.findingsByPage = {};
    }
    redrawCurrent();
    updateMarkCount();
    renderFindingsPanel();
    toast(applied ? `Applied ${applied} mark${applied === 1 ? '' : 's'}.` : 'Nothing was selected, so nothing was applied.');
  });

  rejectAllFindingsBtn.addEventListener('click', () => {
    if (currentType === 'image') imageState.findings = [];
    else if (currentType === 'pdf') pdfState.findingsByPage = {};
    redrawCurrent();
    renderFindingsPanel();
    toast('Dismissed the automatic suggestions \u2014 mark anything sensitive by hand.');
  });

  async function runAutoScan(item) {
    try {
      if (item.type === 'image') {
        showProgress('Scanning for sensitive data\u2026');
        const results = await scanImageCanvas(item.imageState.pristineCanvas, (frac) => setProgress(0.1 + frac * 0.9));
        item.imageState.findings = results.map((r) => ({ ...r, id: findingId(), accepted: true }));
      } else if (item.type === 'pdf') {
        showProgress(`Scanning page 1 of ${item.pdfState.numPages}\u2026`);
        const byPage = await scanPdfDocument(item.pdfState.pdfDoc, (done, total) => {
          setProgress(done / total);
          progressLabel.textContent = `Scanning page ${done} of ${total}\u2026`;
        });
        const findingsByPage = {};
        for (const [page, arr] of Object.entries(byPage)) {
          findingsByPage[page] = arr.map((r) => ({ ...r, id: findingId(), accepted: true }));
        }
        item.pdfState.findingsByPage = findingsByPage;
      }
    } catch (err) {
      console.error(err);
      toast('Automatic scanning failed for this file \u2014 you can still mark it by hand.');
    } finally {
      item.scanned = true;
      hideProgressSoon();
      setProgress(1);
    }
  }

  /* ------------------------------------------------------------ queue */

  function setActive(item) {
    activeId = item.id;
    currentFile = item.file;
    currentType = item.type;
    imageState = item.imageState;
    pdfState = item.pdfState;
  }

  function closeEditor() {
    activeId = null;
    currentFile = null; currentType = null; imageState = null; pdfState = null;
    drawing = false;
    workCtx.clearRect(0, 0, workCanvas.width, workCanvas.height);
    editorPanel.hidden = true;
    findingsPanel.hidden = true;
    markCountEl.textContent = '0 regions marked';
    renderQueue();
  }

  function removeQueueItem(id) {
    queue = queue.filter((q) => q.id !== id);
    if (activeId === id) closeEditor();
    else renderQueue();
  }

  async function openQueueItem(id) {
    const item = queue.find((q) => q.id === id);
    if (!item) return;

    editorPanel.hidden = false;
    fileNameEl.textContent = item.file.name || 'Untitled';
    fileMetaEl.textContent = `#${padSeq(item.seq)} \u00b7 ${item.type.toUpperCase()} \u00b7 ${fmtBytes(item.file.size)}`;
    exportBtn.disabled = true;
    activeId = item.id;
    renderQueue();

    try {
      if (item.type === 'image') {
        pdfNav.hidden = true;
        editorHint.textContent = 'Drag across the preview to black out a region, or click an existing mark to remove it.';
        if (!item.imageState) {
          showProgress('Decoding locally\u2026');
          const st = await ImageEngine.loadFromFile(item.file);
          item.imageState = { pristineCanvas: st.canvas, naturalW: st.naturalW, naturalH: st.naturalH, scaledDown: st.scaledDown, redactions: [], findings: [] };
          if (st.scaledDown) fileMetaEl.textContent += ` \u00b7 working at ${st.canvas.width}\u00d7${st.canvas.height} for performance`;
          if (st.wasHeic) fileMetaEl.textContent += ' \u00b7 converted from HEIC/HEIF to PNG';
          if (guessImageMime(item.file) === 'image/gif') fileMetaEl.textContent += ' \u00b7 exports as a single static frame';
        }
        setActive(item);
        workCanvas.width = imageState.pristineCanvas.width;
        workCanvas.height = imageState.pristineCanvas.height;
        redrawCurrent();
        if (!item.scanned) { await runAutoScan(item); imageState = item.imageState; redrawCurrent(); }
      } else {
        pdfNav.hidden = false;
        editorHint.textContent = 'Drag across the page to black it out, click an existing mark to remove it. Marks are kept per page.';
        if (!item.pdfState) {
          showProgress('Decoding locally\u2026');
          const arrayBuffer = await item.file.arrayBuffer();
          const pdfDoc = await PdfEngine.load(arrayBuffer);
          if (pdfDoc.numPages > MAX_PDF_PAGES_WARN) {
            toast(`This PDF has ${pdfDoc.numPages} pages \u2014 scanning and exporting may take a while.`, 5000);
          }
          item.pdfState = { pdfDoc, numPages: pdfDoc.numPages, currentPage: 1, arrayBuffer, redactionsByPage: {}, findingsByPage: {}, pageCache: {} };
        }
        setActive(item);
        await renderCurrentPdfPage();
        if (!item.scanned) { await runAutoScan(item); pdfState = item.pdfState; await renderCurrentPdfPage(); }
      }
      exportBtn.disabled = false;
      exportBtnLabel.textContent = item.status === 'exported' ? 'Obscure & download again' : 'Obscure & download';
      updateMarkCount();
      renderFindingsPanel();
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : 'Could not read that file \u2014 removed it from the queue.');
      removeQueueItem(id);
      return;
    } finally {
      hideProgressSoon();
      setProgress(1);
    }
    renderQueue();
  }

  async function renderCurrentPdfPage() {
    const p = pdfState.currentPage;
    if (!pdfState.pageCache[p]) {
      const targetW = Math.min(1100, Math.max(500, canvasStage.clientWidth - 24 || 800));
      const rendered = await PdfEngine.renderPageForEditing(pdfState.pdfDoc, p, targetW);
      pdfState.pageCache[p] = {
        pristineCanvas: rendered.canvas,
        pagePointWidth: rendered.pagePointWidth,
        pagePointHeight: rendered.pagePointHeight,
      };
    }
    const cache = pdfState.pageCache[p];
    workCanvas.width = cache.pristineCanvas.width;
    workCanvas.height = cache.pristineCanvas.height;
    redrawCurrent();
    pageIndicator.textContent = `${p} / ${pdfState.numPages}`;
    prevPageBtn.disabled = p <= 1;
    nextPageBtn.disabled = p >= pdfState.numPages;
    updateMarkCount();
    renderFindingsPanel();
  }

  prevPageBtn.addEventListener('click', async () => {
    if (!pdfState || pdfState.currentPage <= 1) return;
    pdfState.currentPage--;
    await renderCurrentPdfPage();
  });
  nextPageBtn.addEventListener('click', async () => {
    if (!pdfState || pdfState.currentPage >= pdfState.numPages) return;
    pdfState.currentPage++;
    await renderCurrentPdfPage();
  });

  removeFileBtn.addEventListener('click', closeEditor);

  function renderQueue() {
    queuePanel.hidden = queue.length === 0;
    queueCount.textContent = String(queue.length);
    queueList.innerHTML = '';

    for (const item of queue) {
      const row = document.createElement('div');
      row.className = 'queue-row' + (item.id === activeId ? ' active' : '');

      const seq = document.createElement('span');
      seq.className = 'queue-seq';
      seq.textContent = '#' + padSeq(item.seq);

      const icon = document.createElement('i');
      icon.className = 'queue-icon ' + (item.type === 'pdf' ? 'fa-regular fa-file-pdf' : 'fa-regular fa-image');
      icon.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = item.file.name;
      name.title = item.file.name;

      const status = document.createElement('span');
      status.className = 'queue-status' + (item.status === 'exported' ? ' done' : '');
      status.innerHTML = item.status === 'exported' ? '<i class="fa-solid fa-check" aria-hidden="true"></i> Done' : '<i class="fa-regular fa-clock" aria-hidden="true"></i> Queued';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-ghost btn-small';
      openBtn.innerHTML = item.id === activeId ? '<i class="fa-solid fa-pen" aria-hidden="true"></i> Editing' : '<i class="fa-regular fa-pen-to-square" aria-hidden="true"></i> Edit';
      openBtn.disabled = item.id === activeId;
      openBtn.addEventListener('click', () => openQueueItem(item.id));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn danger';
      delBtn.setAttribute('aria-label', `Remove ${item.file.name} from the queue`);
      delBtn.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
      delBtn.addEventListener('click', () => removeQueueItem(item.id));

      row.append(seq, icon, name, status, openBtn, delBtn);
      queueList.appendChild(row);
    }
  }

  function enqueueFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let firstAdded = null;
    let hitCap = false;

    for (const file of files) {
      if (queue.length >= MAX_QUEUE_ITEMS) { hitCap = true; break; }
      const type = detectFileType(file);
      if (!type) { toast(`Skipped "${file.name}" \u2014 unsupported (use PDF, JPG, PNG, WEBP, GIF, BMP or HEIC).`); continue; }
      if (file.size > MAX_FILE_BYTES) { toast(`Skipped "${file.name}" \u2014 larger than ${fmtBytes(MAX_FILE_BYTES)}.`); continue; }

      seqCounter += 1;
      const item = {
        id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        seq: seqCounter,
        file, type,
        status: 'queued',
        scanned: false,
        imageState: null,
        pdfState: null,
      };
      queue.push(item);
      if (!firstAdded) firstAdded = item;
    }

    if (hitCap) toast(`This tab keeps up to ${MAX_QUEUE_ITEMS} files at a time \u2014 the rest weren't added.`);
    renderQueue();

    if (activeId === null && firstAdded) {
      openQueueItem(firstAdded.id);
    }
  }

  /* ------------------------------------------------------------ dropzone */

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    enqueueFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); });
  });
  ['dragleave', 'dragend'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragging'); });
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    enqueueFiles(e.dataTransfer.files);
  });

  ['dragenter', 'dragover'].forEach((evt) => document.addEventListener(evt, (e) => e.preventDefault()));
  document.addEventListener('drop', (e) => {
    if (e.target.closest('#dropzone')) return;
    e.preventDefault();
  });

  /* ------------------------------------------------------------ export */

  exportBtn.addEventListener('click', async () => {
    const item = queue.find((q) => q.id === activeId);
    if (!item || !currentType) return;

    const pendingCount = allPendingFindings().length;
    if (pendingCount > 0) {
      const proceed = confirm(`${pendingCount} automatic match${pendingCount === 1 ? '' : 'es'} still need${pendingCount === 1 ? 's' : ''} review \u2014 export anyway without them?`);
      if (!proceed) return;
    }

    exportBtn.disabled = true;
    exportBtnLabel.textContent = 'Working\u2026';
    const prefix = padSeq(item.seq) + '-';
    let pdfHadMarks = false;

    try {
      if (currentType === 'image') {
        showProgress('Re-encoding image locally\u2026');
        setProgress(0.35);
        const result = await ImageEngine.exportRedacted({
          canvas: workCanvas,
          originalFile: item.file,
          originalMimeType: guessImageMime(item.file),
        });
        setProgress(1);
        const filename = prefix + result.filename;
        const blob = new Blob([result.bytes], { type: result.mimeType });
        downloadBlob(blob, filename);
        await addHistoryEntry({ name: filename, type: 'image', mimeType: result.mimeType, blob });
      } else if (currentType === 'pdf') {
        pdfHadMarks = Object.values(pdfState.redactionsByPage).some((a) => a && a.length);
        let bytes;
        if (pdfHadMarks) {
          showProgress(`Flattening page 1 of ${pdfState.numPages}\u2026`);
          bytes = await PdfEngine.exportFlattened(pdfState.pdfDoc, pdfState.numPages, pdfState.redactionsByPage, (done, total) => {
            setProgress(done / total);
            progressLabel.textContent = `Flattening page ${done} of ${total}\u2026`;
          });
        } else {
          showProgress('Stripping hidden metadata\u2026');
          setProgress(0.4);
          bytes = await PdfEngine.exportMetadataStrippedOnly(pdfState.arrayBuffer);
        }
        setProgress(1);
        const filename = prefix + swapExtension(item.file.name || 'document.pdf', 'pdf');
        const blob = new Blob([bytes], { type: 'application/pdf' });
        downloadBlob(blob, filename);
        await addHistoryEntry({ name: filename, type: 'pdf', mimeType: 'application/pdf', blob, pdfThumbCanvas: pdfState.pageCache[1] && pdfState.pageCache[1].pristineCanvas });
      }

      item.status = 'exported';
      const idx = queue.findIndex((q) => q.id === item.id);
      const next = queue.slice(idx + 1).find((q) => q.status !== 'exported');

      const baseMsg = currentType === 'pdf'
        ? (pdfHadMarks
            ? 'Downloaded \u2014 pages were flattened so marked areas can\u2019t be recovered.'
            : 'Downloaded \u2014 hidden metadata stripped, text layer kept.')
        : 'Downloaded \u2014 saved to your local history too.';
      toast(next ? `${baseMsg} Opening #${padSeq(next.seq)} next.` : baseMsg);

      renderQueue();
      if (next) await openQueueItem(next.id);
    } catch (err) {
      console.error(err);
      toast('Something went wrong: ' + (err && err.message ? err.message : 'please try a different file.'));
    } finally {
      hideProgressSoon();
      exportBtn.disabled = false;
      exportBtnLabel.textContent = 'Obscure & download';
    }
  });

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ------------------------------------------------------------ history */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read file for history.'));
      r.readAsDataURL(blob);
    });
  }
  async function makeImageThumb(sourceCanvasOrBlob) {
    const TW = 320, TH = 240;
    const c = document.createElement('canvas');
    c.width = TW; c.height = TH;
    const ctx = c.getContext('2d');
    let bitmap;
    if (sourceCanvasOrBlob instanceof HTMLCanvasElement) {
      bitmap = sourceCanvasOrBlob;
    } else {
      bitmap = await createImageBitmap(sourceCanvasOrBlob);
    }
    const sw = bitmap.width, sh = bitmap.height;
    const scale = Math.max(TW / sw, TH / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.fillStyle = '#12161D'; ctx.fillRect(0, 0, TW, TH);
    ctx.drawImage(bitmap, (TW - dw) / 2, (TH - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.72);
  }

  async function addHistoryEntry({ name, type, mimeType, blob, pdfThumbCanvas }) {
    const list = loadHistory();
    const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    let dataUrl = null;
    if (blob.size <= HISTORY_DATAURL_LIMIT) {
      try { dataUrl = await blobToDataURL(blob); } catch (e) { dataUrl = null; }
    }

    let thumb = null;
    try {
      if (type === 'image') thumb = await makeImageThumb(blob);
      else if (type === 'pdf' && pdfThumbCanvas) thumb = await makeImageThumb(pdfThumbCanvas);
    } catch (e) { thumb = null; }

    const entry = { id, name, type, mimeType, size: blob.size, createdAt: Date.now(), dataUrl, thumb };
    list.unshift(entry);
    while (list.length > HISTORY_MAX_ENTRIES) list.pop();

    let ok = saveHistory(list);
    while (!ok && list.length) {
      let stripped = false;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].dataUrl) { list[i].dataUrl = null; stripped = true; break; }
      }
      if (!stripped) list.pop();
      ok = saveHistory(list);
    }
    if (!ok) toast('Downloaded successfully, but local history storage is full.');
    renderHistory();
  }

  function relativeTime(ts) {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
    return new Date(ts).toLocaleDateString();
  }

  function renderHistory() {
    const list = loadHistory();
    historyList.querySelectorAll('.hist-card').forEach((n) => n.remove());
    historyEmpty.hidden = list.length > 0;
    for (const entry of list) {
      const card = document.createElement('div');
      card.className = 'hist-card glass';

      const thumb = document.createElement('div');
      thumb.className = 'hist-thumb';
      if (entry.thumb) {
        const img = document.createElement('img');
        img.src = entry.thumb; img.alt = '';
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = entry.type === 'pdf'
          ? '<i class="fa-regular fa-file-pdf" aria-hidden="true"></i>'
          : '<i class="fa-regular fa-image" aria-hidden="true"></i>';
      }

      const name = document.createElement('div');
      name.className = 'hist-name'; name.textContent = entry.name; name.title = entry.name;

      const meta = document.createElement('div');
      meta.className = 'hist-meta';
      meta.textContent = `${entry.type.toUpperCase()} \u00b7 ${fmtBytes(entry.size)} \u00b7 ${relativeTime(entry.createdAt)}`;

      const actions = document.createElement('div');
      actions.className = 'hist-actions';

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'btn btn-ghost btn-small';
      if (entry.dataUrl) {
        dlBtn.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i> Download';
        dlBtn.addEventListener('click', async () => {
          try {
            const res = await fetch(entry.dataUrl);
            const blob = await res.blob();
            downloadBlob(blob, entry.name);
          } catch (e) { toast('Could not restore this file from history.'); }
        });
      } else {
        dlBtn.textContent = 'Not cached';
        dlBtn.disabled = true;
        dlBtn.title = 'This file was too large to keep a local copy of \u2014 only its record remains.';
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn danger';
      delBtn.setAttribute('aria-label', 'Remove from history');
      delBtn.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
      delBtn.addEventListener('click', () => {
        const updated = loadHistory().filter((e) => e.id !== entry.id);
        saveHistory(updated);
        renderHistory();
      });

      actions.append(dlBtn, delBtn);
      card.append(thumb, name, meta, actions);
      historyList.appendChild(card);
    }
  }

  clearHistoryBtn.addEventListener('click', () => {
    if (!loadHistory().length) return;
    if (confirm('Clear all local history? This only affects this browser\u2019s storage \u2014 already-downloaded files are unaffected.')) {
      saveHistory([]);
      renderHistory();
      toast('History cleared.');
    }
  });

  /* ------------------------------------------------------------ scroll reveal */

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        en.target.classList.add('is-visible');
        io.unobserve(en.target);
      }
    }
  }, { threshold: 0.14 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* ------------------------------------------------------------ init */

  renderQueue();
  renderHistory();
})();
