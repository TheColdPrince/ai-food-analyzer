(() => {
  'use strict';

  /* ---------- Config ---------- */
  const API_URL = 'https://oxford.uk.eu.org/ai/oxford';
  const MAX_SIDE = 1280;        // resize before upload = faster
  const JPEG_QUALITY = 0.85;
  const TIMEOUT_MS = 75000;
  const SCORE_CIRC = 2 * Math.PI * 28;
  const OXFORD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const OXFORD_MAX_BYTES = 5 * 1024 * 1024;

  const PROMPT = `Analyze the food in this image.

Reply with ONLY a valid JSON object. No markdown, no code fences, no extra words.
Use exactly this shape:
{
  "is_food": true,
  "name": "short dish name",
  "summary": "one short sentence about the dish",
  "health_score": 0,
  "calories": "approximate range per serving, e.g. 450–550 kcal",
  "ingredients": ["likely ingredient"],
  "benefits": [{"title": "short benefit", "detail": "why, under 18 words"}],
  "risks": [{"title": "short concern", "detail": "why, under 18 words", "level": "low|medium|high"}],
  "tip": "one short, practical way to make it healthier"
}

Rules:
- health_score is an integer 0–100 (100 = very healthy).
- Up to 8 ingredients, up to 4 benefits, up to 4 risks.
- Mention likely allergens (nuts, dairy, gluten, shellfish, egg, soy) as risks.
- Keep titles under 5 words. Estimates are fine.
- If the image does not show food or drink, return {"is_food": false} only.`;

  /* ---------- Elements ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    viewHome: $('viewHome'), viewScan: $('viewScan'), viewResult: $('viewResult'),
    btnCamera: $('btnCamera'), btnLibrary: $('btnLibrary'),
    inputCapture: $('inputCapture'), inputLibrary: $('inputLibrary'),
    scanImg: $('scanImg'), stepLabel: $('stepLabel'), pct: $('pct'),
    fill: $('progressFill'), steps: Array.from(document.querySelectorAll('#steps li')),
    btnCancel: $('btnCancel'),
    resultImg: $('resultImg'), btnBack: $('btnBack'), btnAgain: $('btnAgain'),
    foodName: $('foodName'), foodSummary: $('foodSummary'),
    calories: $('calories'), caloriesText: $('caloriesText'),
    score: $('score'), scoreBar: $('scoreBar'), scoreNum: $('scoreNum'),
    secIngredients: $('secIngredients'), ingredients: $('ingredients'),
    secBenefits: $('secBenefits'), benefits: $('benefits'),
    secRisks: $('secRisks'), risks: $('risks'),
    tip: $('tip'), tipText: $('tipText'), raw: $('raw'),
    camera: $('camera'), video: $('video'), flash: $('flash'),
    btnShutter: $('btnShutter'), btnFlip: $('btnFlip'),
    btnCamClose: $('btnCamClose'), btnCamLibrary: $('btnCamLibrary'),
    toast: $('toast'), drop: $('drop'),
  };

  /* ---------- Helpers ---------- */
  const haptic = (pattern = 8) => { try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const icon = (id, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  const isImage = (f) =>
    !!f && ((f.type && f.type.startsWith('image/')) || /\.(heic|heif)$/i.test(f.name || ''));

  /* ---------- View transitions ---------- */
  let current = el.viewHome;
  async function show(next) {
    if (next === current) return;
    const prev = current;
    current = next;
    prev.classList.add('is-leaving');
    await wait(230);
    prev.classList.remove('is-active', 'is-leaving');
    next.classList.add('is-active');
    window.scrollTo(0, 0);
  }

  /* ---------- Ripple + tap feedback ---------- */
  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('.btn, .icon-btn, .row-btn');
    if (!target || target.disabled) return;
    const r = target.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    target.appendChild(dot);
    dot.addEventListener('animationend', () => dot.remove(), { once: true });
    haptic(6);
  }, { passive: true });

  /* ---------- Toast ---------- */
  let toastTimer = 0;
  function toast(message, isError = false) {
    const t = el.toast;
    t.textContent = message;
    t.classList.remove('show', 'shake');
    void t.offsetWidth; // restart animation
    t.classList.add('show');
    if (isError) { t.classList.add('shake'); haptic([12, 40, 12]); }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
  }

  /* ---------- Image preparation ---------- */
  async function decode(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
      try { return await createImageBitmap(file); } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  async function prepareImage(file) {
    try {
      const src = await decode(file);
      const w = src.naturalWidth || src.width;
      const h = src.naturalHeight || src.height;
      if (!w || !h) return file;
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      if (typeof src.close === 'function') src.close();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
      return blob || file;
    } catch (_) {
      return file; // e.g. HEIC on browsers that can't decode it — let the server try
    }
  }

  let previewUrl = null;
  function setPreview(blob) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    el.scanImg.src = previewUrl;
    el.resultImg.src = previewUrl;
  }

  /* ---------- Progress (eased, asymptotic until the reply lands) ---------- */
  function createProgress() {
    const THRESH = [12, 38, 66, 100];
    const LABELS = [[0, 'Preparing image'], [12, 'Identifying food'], [38, 'Reading ingredients'], [66, 'Checking health impact'], [93, 'Almost there']];
    let raf = 0, t0 = 0, shown = 0, target = 0, finishing = false, onDone = null, label = '';

    function setLabel(text) {
      if (text === label) return;
      label = text;
      el.stepLabel.classList.add('swap');
      setTimeout(() => { el.stepLabel.textContent = text; el.stepLabel.classList.remove('swap'); }, 160);
    }

    function render() {
      el.fill.style.transform = `scaleX(${shown / 100})`;
      el.pct.textContent = `${Math.floor(shown)}%`;
      let text = LABELS[0][1];
      for (const [at, t] of LABELS) if (shown >= at) text = t;
      setLabel(text);
      el.steps.forEach((li, i) => {
        const done = shown >= THRESH[i + 1];
        li.classList.toggle('done', done);
        li.classList.toggle('active', shown >= THRESH[i] && !done);
      });
    }

    function frame(now) {
      const t = (now - t0) / 1000;
      if (!finishing) target = 94 * (1 - Math.exp(-t / 6));
      shown += (target - shown) * (finishing ? 0.14 : 0.06);
      if (finishing && 100 - shown < 0.4) shown = 100;
      render();
      if (finishing && shown >= 100) { setTimeout(onDone, 380); return; }
      raf = requestAnimationFrame(frame);
    }

    return {
      start() {
        shown = 0; target = 0; finishing = false; label = '';
        el.stepLabel.textContent = LABELS[0][1];
        render();
        t0 = performance.now();
        raf = requestAnimationFrame(frame);
      },
      finish() {
        finishing = true; target = 100;
        if (document.hidden) { cancelAnimationFrame(raf); shown = 100; render(); return Promise.resolve(); }
        return new Promise((r) => { onDone = r; });
      },
      stop() { cancelAnimationFrame(raf); },
    };
  }

  /* ---------- Analysis flow ---------- */
  let busy = false;
  let abort = null;
  let cancelledByUser = false;

  async function handleFile(file, alreadyPrepared = false) {
    if (busy) return;
    if (!isImage(file)) { toast('That file isn’t an image. Choose a photo.', true); return; }
    if (file.size > 25 * 1024 * 1024) { toast('Image is over 25 MB. Choose a smaller one.', true); return; }

    busy = true;
    haptic(12);
    try {
      const blob = alreadyPrepared ? file : await prepareImage(file);
      if (!OXFORD_TYPES.includes(blob.type)) {
        toast('This photo format isn’t supported. Use JPG, PNG or WebP.', true);
        return;
      }
      if (blob.size > OXFORD_MAX_BYTES) {
        toast('Photo is over 5 MB. Choose a smaller one.', true);
        return;
      }
      setPreview(blob);
      await show(el.viewScan);
      await runAnalysis(blob);
    } finally {
      busy = false;
    }
  }

  async function runAnalysis(blob) {
    const progress = createProgress();
    progress.start();
    abort = new AbortController();
    cancelledByUser = false;
    const timer = setTimeout(() => abort && abort.abort(), TIMEOUT_MS);

    try {
      const data = await requestAnalysis(blob, abort.signal);
      clearTimeout(timer);
      await progress.finish();

      if (data.result && data.result.is_food === false) {
        toast('No food found in this photo. Try another angle.');
        await show(el.viewHome);
        return;
      }

      renderResult(data);
      await show(el.viewResult);
      playResult(data);
      haptic([8, 30, 8]);
    } catch (err) {
      clearTimeout(timer);
      progress.stop();
      if (err.name === 'AbortError') {
        if (!cancelledByUser) toast('The analysis timed out. Try again.', true);
      } else {
        toast(err.message || 'Analysis failed. Try again.', true);
      }
      await show(el.viewHome);
    } finally {
      abort = null;
    }
  }

  async function requestAnalysis(blob, signal) {
    const form = new FormData();
    form.append('message', PROMPT);
    form.append('image', blob, blob.name || 'food.jpg');

    let res;
    try {
      res = await fetch(API_URL, { method: 'POST', body: form, signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('No connection. Check your internet and try again.');
    }

    let data = null;
    try { data = await res.json(); } catch (_) {}

    if (res.status === 429) throw new Error('Too many scans. Wait a minute and try again.');
    if (!res.ok || !data) throw new Error((data && data.error) || 'Oxford AI request failed. Try again.');
    if (data.error) throw new Error(data.error);

    const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
    if (!reply) throw new Error('Oxford AI returned an empty answer. Try another photo.');

    const parsed = extractJson(reply);
    return parsed ? { result: normalize(parsed) } : { raw: reply };
  }

  /* ---------- Reply parsing ---------- */
  function extractJson(text) {
    const t = String(text).replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const d = JSON.parse(t.slice(start, end + 1));
      return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
    } catch (_) {
      return null;
    }
  }

  const clean = (v, max = 160) =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v).replace(/\s+/g, ' ').trim().slice(0, max)
      : '';

  function normalize(d) {
    const items = (list, limit, withLevel = false) =>
      (Array.isArray(list) ? list : []).slice(0, limit).map((it) => {
        if (typeof it === 'string') it = { title: it };
        if (!it || typeof it !== 'object') return null;
        const row = { title: clean(it.title ?? it.name, 70), detail: clean(it.detail ?? it.description, 240) };
        if (!row.title) return null;
        if (withLevel) {
          const lvl = clean(it.level, 10).toLowerCase();
          row.level = ['low', 'medium', 'high'].includes(lvl) ? lvl : 'medium';
        }
        return row;
      }).filter(Boolean);

    const score = Number(d.health_score);
    const hasScore = d.health_score !== null && d.health_score !== '' && d.health_score !== undefined && Number.isFinite(score);

    return {
      is_food: d.is_food !== false && d.is_food !== 'false',
      name: clean(d.name, 60),
      summary: clean(d.summary, 160),
      health_score: hasScore ? Math.max(0, Math.min(100, Math.round(score))) : null,
      calories: clean(d.calories, 40),
      ingredients: (Array.isArray(d.ingredients) ? d.ingredients : [])
        .map((x) => clean(x && typeof x === 'object' ? x.name : x, 40))
        .filter(Boolean)
        .slice(0, 10),
      benefits: items(d.benefits, 4),
      risks: items(d.risks, 4, true),
      tip: clean(d.tip, 180),
    };
  }

  /* ---------- Rendering ---------- */
  function populate(container, items, build) {
    container.replaceChildren(...(items || []).map(build));
    return container.children.length > 0;
  }

  function makeChip(name, i) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--i', i);
    chip.textContent = name;
    return chip;
  }

  function makeRow(item, i, kind) {
    const li = document.createElement('li');
    li.className = `row ${kind}`;
    li.style.setProperty('--i', i);
    if (kind === 'risk') li.dataset.level = item.level || 'medium';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-btn';
    btn.innerHTML =
      `<span class="row-ic">${kind === 'benefit' ? icon('check') : '<i></i>'}</span>` +
      `<span class="row-title"></span>` +
      (kind === 'risk' ? '<span class="row-level"></span>' : '') +
      (item.detail ? icon('chev', 'chev') : '');
    btn.querySelector('.row-title').textContent = item.title;
    if (kind === 'risk') btn.querySelector('.row-level').textContent = item.level || 'medium';
    li.appendChild(btn);

    if (item.detail) {
      const detail = document.createElement('div');
      detail.className = 'row-detail';
      detail.innerHTML = '<div><p></p></div>';
      detail.querySelector('p').textContent = item.detail;
      li.appendChild(detail);
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const open = li.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
        haptic(5);
      });
    } else {
      btn.disabled = true;
    }
    return li;
  }

  function renderResult(data) {
    const r = data.result || null;

    el.foodName.textContent = r ? (r.name || 'Your meal') : 'Analysis';
    el.foodSummary.textContent = r ? (r.summary || '') : '';

    el.caloriesText.textContent = (r && r.calories) || '';
    el.calories.hidden = !(r && r.calories);

    const hasScore = !!r && Number.isFinite(r.health_score);
    el.score.hidden = !hasScore;
    el.scoreBar.style.transition = 'none';
    el.scoreBar.style.strokeDashoffset = SCORE_CIRC;
    el.scoreNum.textContent = '0';

    el.secIngredients.hidden = !populate(el.ingredients, r && r.ingredients, makeChip);
    el.secBenefits.hidden = !populate(el.benefits, r && r.benefits, (b, i) => makeRow(b, i, 'benefit'));
    el.secRisks.hidden = !populate(el.risks, r && r.risks, (x, i) => makeRow(x, i, 'risk'));

    el.tipText.textContent = (r && r.tip) || '';
    el.tip.hidden = !(r && r.tip);

    el.raw.textContent = r ? '' : (data.raw || 'No details returned.');
    el.raw.hidden = !!r;
  }

  function countUp(node, to, duration = 1400, delay = 350) {
    const start = performance.now() + delay;
    const tick = (now) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = Math.round(to * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function playResult(data) {
    const r = data.result;
    if (!r || !Number.isFinite(r.health_score)) return;
    const s = r.health_score;
    const tone = s >= 70 ? 'var(--green)' : s >= 40 ? 'var(--orange)' : 'var(--red)';
    el.score.style.setProperty('--score-color', tone);
    el.score.setAttribute('aria-label', `Health score ${s} out of 100`);
    requestAnimationFrame(() => {
      el.scoreBar.style.transition = '';
      requestAnimationFrame(() => {
        el.scoreBar.style.strokeDashoffset = SCORE_CIRC * (1 - s / 100);
      });
    });
    countUp(el.scoreNum, s);
  }

  /* ---------- Live camera ---------- */
  let stream = null;
  let facing = 'environment';
  const canLiveCamera = () =>
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;

  function stopStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    el.video.srcObject = null;
  }

  async function startStream() {
    stopStream();
    el.camera.classList.add('is-loading');
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
    if (!el.camera.classList.contains('is-open')) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    el.video.srcObject = s;
    await el.video.play().catch(() => {});
    el.camera.classList.toggle('is-front', facing === 'user');
    el.camera.classList.remove('is-loading');
  }

  async function openCamera() {
    el.camera.classList.add('is-open', 'is-loading');
    el.camera.setAttribute('aria-hidden', 'false');
    document.body.classList.add('cam-open');
    try {
      await startStream();
    } catch (e) {
      closeCamera();
      toast(e && e.name === 'NotAllowedError'
        ? 'Camera access is blocked. Allow it in settings, or choose a photo.'
        : 'Camera unavailable. Choose a photo instead.', true);
    }
  }

  function closeCamera() {
    stopStream();
    el.camera.classList.remove('is-open', 'is-loading', 'flipping');
    el.camera.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cam-open');
  }

  async function capture() {
    const v = el.video;
    if (!stream || !v.videoWidth) return;
    haptic(15);
    el.flash.classList.remove('go');
    void el.flash.offsetWidth;
    el.flash.classList.add('go');

    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
    setTimeout(closeCamera, 200);
    if (blob) handleFile(blob, true);
  }

  async function flipCamera() {
    facing = facing === 'environment' ? 'user' : 'environment';
    el.camera.classList.add('flipping');
    try { await startStream(); }
    catch (_) { toast('Couldn’t switch cameras.', true); }
    setTimeout(() => el.camera.classList.remove('flipping'), 150);
  }

  /* ---------- Events ---------- */
  el.btnCamera.addEventListener('click', () => {
    if (busy) return;
    if (canLiveCamera()) openCamera();
    else el.inputCapture.click(); // native camera fallback (HTTP or old browsers)
  });
  el.btnLibrary.addEventListener('click', () => { if (!busy) el.inputLibrary.click(); });

  [el.inputCapture, el.inputLibrary].forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) handleFile(file);
    });
  });

  el.btnShutter.addEventListener('click', capture);
  el.btnFlip.addEventListener('click', flipCamera);
  el.btnCamClose.addEventListener('click', closeCamera);
  el.btnCamLibrary.addEventListener('click', () => { closeCamera(); el.inputLibrary.click(); });

  el.btnCancel.addEventListener('click', () => {
    cancelledByUser = true;
    if (abort) abort.abort();
  });

  const goHome = () => show(el.viewHome);
  el.btnBack.addEventListener('click', goHome);
  el.btnAgain.addEventListener('click', goHome);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (el.camera.classList.contains('is-open')) closeCamera();
    else if (current === el.viewResult) goHome();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && stream) closeCamera();
  });

  /* Drag & drop and paste (desktop) */
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++; el.drop.classList.add('show');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.drop.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; el.drop.classList.remove('show');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  window.addEventListener('paste', (e) => {
    const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (f && isImage(f)) handleFile(f);
  });
})();
