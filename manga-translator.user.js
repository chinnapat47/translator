// ==UserScript==
// @name         iOS Manhwa Context-Aware Translator
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  แปล Manhwa อังกฤษ/ญี่ปุ่นเป็นไทย พร้อมจำบริบทแยกตามเรื่อง วางคำแปลกลืนกับภาพ
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ลิงก์จาก Render ของคุณ
  const API_BASE = 'https://translator-o53c.onrender.com';
  const API_URL = API_BASE + '/translate';

  const MAX_CONCURRENT = 3;          // แปลพร้อมกันได้กี่รูป
  const FAST_INTERVAL_MS = 1200;     // เว้นระยะระหว่างคำขอตามปกติ
  const SLOW_INTERVAL_MS = 6500;     // ถ้าเจอ 429 (โควต้าต่อนาทีเต็ม) จะเปลี่ยนมาใช้ค่านี้ไปจนปิดหน้า
  const USE_PREV_IMAGE = false;      // true = ส่งรูปก่อนหน้าไปช่วยดูบริบทตัวละคร (แม่นขึ้นเล็กน้อย แต่ช้าลงเกือบเท่าตัว)
  const LOOKAHEAD_PX = 2500;         // เริ่มแปลรูปที่อยู่ถัดลงไปล่วงหน้ากี่พิกเซล (ยิ่งมากยิ่งไม่ต้องรอ แต่ใช้โควต้าไวขึ้น)
  const MAX_UPLOAD_WIDTH = 1000;     // ย่อรูปก่อนส่ง ให้ส่งเร็วและไม่เกินขนาดที่เซิร์ฟเวอร์รับ
  const MAX_CANVAS_PIXELS = 16000000; // ขีดจำกัด canvas ของ iOS Safari
  const REQUEST_TIMEOUT = 120000;    // Render ฟรีตื่นจากหลับได้นานถึง ~1 นาที
  const CACHE_PREFIX = 'mtc1:';      // แคชคำแปลในเครื่อง (อ่านซ้ำแล้วขึ้นทันที ไม่เสียโควต้า)

  let isEnabled = false;
  const processedImages = new WeakSet();
  const pendingImages = new WeakSet();
  let mangaImagesList = [];

  // GM_xmlhttpRequest ข้าม CORS และ CSP ของเว็บ (เว็บอย่าง Vortex Scan มักบล็อก fetch ไปโดเมนอื่น)
  const gmXhr =
    typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function'
        ? GM.xmlHttpRequest.bind(GM)
        : null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (!gmXhr) return reject(new Error('ตัวจัดการ userscript ไม่รองรับ GM_xmlhttpRequest'));
      gmXhr({
        timeout: REQUEST_TIMEOUT,
        ...opts,
        onload: resolve,
        onerror: () => reject(new Error('เชื่อมต่อไม่ได้')),
        ontimeout: () => reject(new Error('หมดเวลารอ')),
        onabort: () => reject(new Error('ถูกยกเลิก')),
      });
    });
  }

  // ดึงชื่อเรื่องจาก URL เพื่อใช้แยกไฟล์ความจำ
  function getSeriesId() {
    const cleanPath = window.location.pathname
      .replace(/\/(chapter|ch|ep|episode|vol)[-_]?\d+.*$/i, '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase();
    return cleanPath || document.title.slice(0, 30).replace(/[^a-zA-Z0-9]+/g, '_');
  }

  // ---------- แคชคำแปลในเครื่อง ----------

  function cacheGet(src) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + src);
      return raw ? JSON.parse(raw).d : null;
    } catch (e) {
      return null;
    }
  }

  function trimCache() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) {
        let t = 0;
        try {
          t = JSON.parse(localStorage.getItem(k)).t || 0;
        } catch (e) {
          /* ข้าม */
        }
        items.push([k, t]);
      }
    }
    items.sort((a, b) => a[1] - b[1]);
    items.slice(0, Math.ceil(items.length / 2)).forEach(([k]) => localStorage.removeItem(k));
  }

  function cacheSet(src, data) {
    const key = CACHE_PREFIX + src;
    const val = JSON.stringify({ t: Date.now(), d: data });
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      try {
        trimCache();
        localStorage.setItem(key, val);
      } catch (e2) {
        /* แคชเต็ม/ใช้ไม่ได้ ข้ามไป */
      }
    }
  }

  // ---------- โหลดรูปผ่านเบราว์เซอร์ แล้วส่งให้เซิร์ฟเวอร์ ----------
  // (เซิร์ฟเวอร์ Render โหลดรูปเองมักโดน CDN ของเว็บมังงะบล็อก ได้ HTTP 403)

  async function downloadImage(url) {
    const res = await gmRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: {
        Referer: window.location.href,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (res.status !== 200 || !res.response) {
      throw new Error(`โหลดรูปไม่ได้ (HTTP ${res.status})`);
    }
    return res.response; // ArrayBuffer
  }

  function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // canvas ขนาดเล็กไว้เก็บสีพื้นของกรอบคำพูด (กว้างไม่เกิน 400px ประหยัดหน่วยความจำมือถือ)
  function makeSampleCanvas(srcCanvas) {
    const sw = Math.min(400, srcCanvas.width);
    const sh = Math.max(1, Math.round((srcCanvas.height * sw) / srcCanvas.width));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d').drawImage(srcCanvas, 0, 0, sw, sh);
    return c;
  }

  // ย่อรูป + แปลงเป็น JPEG (ได้ทั้ง avif/webp ที่ Gemini ไม่รับ) ถ้าทำไม่ได้ก็ส่งไฟล์เดิม
  function prepareImage(buf) {
    return new Promise((resolve) => {
      const sendRaw = () => resolve({ b64: bufferToBase64(buf), mime: '', sample: null });
      let objUrl;
      try {
        objUrl = URL.createObjectURL(new Blob([buf]));
        const im = new Image();
        im.onload = () => {
          try {
            const w = im.naturalWidth;
            const h = im.naturalHeight;
            let scale = Math.min(1, MAX_UPLOAD_WIDTH / w);
            scale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (w * h)));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            let sample = null;
            try {
              sample = makeSampleCanvas(canvas);
            } catch (e) {
              /* ไม่มีสีพื้นก็ใช้สีขาวแทน */
            }
            URL.revokeObjectURL(objUrl);
            resolve({ b64: dataUrl.split(',')[1], mime: 'image/jpeg', sample });
          } catch (e) {
            URL.revokeObjectURL(objUrl);
            sendRaw();
          }
        };
        im.onerror = () => {
          URL.revokeObjectURL(objUrl);
          sendRaw();
        };
        im.src = objUrl;
      } catch (e) {
        if (objUrl) URL.revokeObjectURL(objUrl);
        sendRaw();
      }
    });
  }

  // แคชรูปที่เตรียมแล้ว (กรณีเปิด USE_PREV_IMAGE รูปหนึ่งถูกใช้เป็น "รูปก่อนหน้า" ของรูปถัดไปด้วย)
  const prepCache = new Map();
  function getPrepared(src) {
    if (!prepCache.has(src)) {
      const p = downloadImage(src).then(prepareImage);
      p.catch(() => prepCache.delete(src));
      prepCache.set(src, p);
      if (prepCache.size > 6) prepCache.delete(prepCache.keys().next().value);
    }
    return prepCache.get(src);
  }

  async function buildPayload(src, prevSrc) {
    const payload = {
      series_id: getSeriesId(),
      image_url: src,
      prev_image_url: USE_PREV_IMAGE ? prevSrc : null,
      referer: window.location.href,
    };
    let sample = null;
    if (!gmXhr) return { payload, sample }; // ไม่มี GM -> ให้เซิร์ฟเวอร์โหลดเอง
    try {
      const main = await getPrepared(src);
      payload.image_b64 = main.b64;
      payload.image_mime = main.mime;
      sample = main.sample || null;
    } catch (e) {
      console.warn('Translator: โหลดรูปผ่านเบราว์เซอร์ไม่ได้ ให้เซิร์ฟเวอร์ลองโหลดเอง', e);
      return { payload, sample };
    }
    if (USE_PREV_IMAGE && prevSrc) {
      try {
        const prev = await getPrepared(prevSrc);
        payload.prev_image_b64 = prev.b64;
        payload.prev_image_mime = prev.mime;
      } catch (e) {
        /* รูปก่อนหน้าเป็นแค่ตัวช่วย ข้ามได้ */
      }
    }
    return { payload, sample };
  }

  // ---------- เรียก API ----------

  async function callApi(payload) {
    const body = JSON.stringify(payload);
    let status;
    let text;
    if (gmXhr) {
      const res = await gmRequest({
        method: 'POST',
        url: API_URL,
        data: body,
        headers: { 'Content-Type': 'application/json' },
        responseType: 'text',
      });
      status = res.status;
      text = res.responseText;
    } else {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      status = res.status;
      text = await res.text();
    }
    if (status < 200 || status >= 300) {
      let detail = '';
      try {
        const d = JSON.parse(text).detail;
        detail = typeof d === 'string' ? d : JSON.stringify(d);
      } catch (e) {
        /* ไม่ใช่ JSON */
      }
      const err = new Error(detail || `HTTP ${status}`);
      err.status = status;
      throw err;
    }
    return JSON.parse(text);
  }

  // เว้นจังหวะคำขอทั้งหมด (รวมที่ retry) ให้ไม่ถี่เกินโควต้าต่อนาที
  let nextSlot = 0;
  let intervalMs = FAST_INTERVAL_MS;
  async function rateGate() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + intervalMs;
    if (wait) await sleep(wait);
  }

  // ลองใหม่เมื่อเซิร์ฟเวอร์เพิ่งตื่น/ไม่ว่าง (502/503/504), เน็ตสะดุด หรือโควต้าต่อนาทีเต็ม (429)
  // โควต้ารายวันหมดจะไม่ลองซ้ำ เพราะรอไปก็ไม่หาย
  async function callApiWithRetry(payload, onWait) {
    for (let i = 0; ; i++) {
      await rateGate();
      try {
        return await callApi(payload);
      } catch (e) {
        const quota = e.status === 429;
        if (quota) intervalMs = SLOW_INTERVAL_MS; // เจอโควต้าเต็มแล้ว ชะลอจังหวะที่เหลือ
        const daily = quota && /รายวัน/.test(e.message);
        const retriable =
          !daily && (e.status === undefined || quota || [502, 503, 504].includes(e.status));
        const delays = quota ? [20000, 40000] : [3000, 8000];
        if (!retriable || i >= delays.length) throw e;
        if (onWait) onWait(quota ? 'โควต้าเต็มชั่วคราว รอลองใหม่...' : 'เซิร์ฟเวอร์ไม่ว่าง รอลองใหม่...');
        await sleep(delays[i]);
      }
    }
  }

  // คิว: จำกัดจำนวนที่แปลพร้อมกัน และเลือกรูปที่ใกล้จุดที่กำลังอ่านอยู่ก่อน
  let running = 0;
  const queue = [];

  function priorityOf(img) {
    const r = img.getBoundingClientRect();
    if (r.bottom < 0) return 1e6 + Math.abs(r.bottom); // เลื่อนผ่านไปแล้ว ไว้ทำทีหลังสุด
    return Math.max(0, r.top); // รูปที่เห็นอยู่ก่อน แล้วค่อยรูปที่ใกล้ที่สุดถัดลงไป
  }

  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      let bestIdx = 0;
      let bestP = Infinity;
      queue.forEach((job, i) => {
        const p = priorityOf(job.img);
        if (p < bestP) {
          bestP = p;
          bestIdx = i;
        }
      });
      const job = queue.splice(bestIdx, 1)[0];
      running++;
      job.task().then(job.resolve, job.reject).finally(() => {
        running--;
        pump();
      });
    }
  }

  function enqueue(task, img) {
    return new Promise((resolve, reject) => {
      queue.push({ task, img, resolve, reject });
      pump();
    });
  }

  // ปลุกเซิร์ฟเวอร์ Render ล่วงหน้าตอนกดเปิด
  function wakeServer() {
    if (gmXhr) {
      gmRequest({ method: 'GET', url: API_BASE + '/', timeout: 90000 }).catch(() => {});
    } else {
      fetch(API_BASE + '/', { mode: 'no-cors' }).catch(() => {});
    }
  }

  // ---------- สีพื้นกรอบคำพูด (ให้คำแปลกลืนกับภาพ) ----------

  // หาสีที่พบมากที่สุดในกรอบ (ตัวอักษรเดิมเป็นส่วนน้อย จึงได้สีพื้นของกรอบ)
  function sampleBox(canvas, box) {
    try {
      const cw = canvas.width;
      const ch = canvas.height;
      const ys = [Number(box[0]), Number(box[2])].sort((a, b) => a - b);
      const xs = [Number(box[1]), Number(box[3])].sort((a, b) => a - b);
      const x0 = Math.max(0, Math.floor((xs[0] / 1000) * cw));
      const x1 = Math.min(cw, Math.ceil((xs[1] / 1000) * cw));
      const y0 = Math.max(0, Math.floor((ys[0] / 1000) * ch));
      const y1 = Math.min(ch, Math.ceil((ys[1] / 1000) * ch));
      const w = x1 - x0;
      const h = y1 - y0;
      if (!(w >= 2 && h >= 2)) return null;
      const data = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
      const buckets = new Map();
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          let e = buckets.get(key);
          if (!e) {
            e = { c: 0, r: 0, g: 0, b: 0 };
            buckets.set(key, e);
          }
          e.c++;
          e.r += r;
          e.g += g;
          e.b += b;
        }
      }
      let best = null;
      buckets.forEach((e) => {
        if (!best || e.c > best.c) best = e;
      });
      if (!best) return null;
      const r = Math.round(best.r / best.c);
      const g = Math.round(best.g / best.c);
      const b = Math.round(best.b / best.c);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return { bg: `rgb(${r},${g},${b})`, fg: lum > 0.55 ? '#111' : '#fff' };
    } catch (e) {
      return null;
    }
  }

  // ---------- UI ----------

  // ปุ่มเปิด/ปิด ลอยด้านบนขวา (พ้นแถบ Safari และเมนูเว็บ)
  const toggleBtn = document.createElement('button');
  toggleBtn.innerText = 'แปล Manhwa: OFF';
  Object.assign(toggleBtn.style, {
    position: 'fixed',
    top: '120px',
    right: '12px',
    zIndex: '2147483647',
    padding: '10px 14px',
    borderRadius: '20px',
    border: 'none',
    backgroundColor: '#333',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 'bold',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    cursor: 'pointer',
  });
  document.body.appendChild(toggleBtn);

  const observer = new IntersectionObserver(
    (entries) => {
      if (!isEnabled) return;
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          observer.unobserve(img);
          translateImage(img);
        }
      });
    },
    { rootMargin: `${LOOKAHEAD_PX}px 0px` }
  );

  function scanMangaImages() {
    const imgs = Array.from(document.querySelectorAll('img'));
    imgs.forEach((img) => {
      if (processedImages.has(img) || pendingImages.has(img)) return;
      const checkAndObserve = () => {
        if (processedImages.has(img)) return;
        if (img.naturalWidth >= 400 && img.naturalHeight >= 300) {
          processedImages.add(img);
          mangaImagesList.push(img);
          observer.observe(img);
        }
      };
      if (img.complete) {
        checkAndObserve();
      } else {
        pendingImages.add(img);
        img.addEventListener('load', checkAndObserve, { once: true });
      }
    });
  }

  // ปรับขนาดตัวอักษรให้พอดีกรอบ ไม่ล้นไม่ถูกตัด
  function fitFont(box, inner) {
    const availH = box.clientHeight - 4;
    const availW = box.clientWidth - 6;
    if (!(availH > 0 && availW > 0)) return;
    let lo = 7;
    let hi = Math.max(lo, Math.min(availH * 0.85, availW * 0.6, 42));
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      inner.style.fontSize = `${mid}px`;
      if (inner.offsetHeight <= availH && inner.scrollWidth <= availW) lo = mid;
      else hi = mid;
    }
    inner.style.fontSize = `${lo}px`;
  }

  const renderedBoxes = [];
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderedBoxes.forEach((m) => fitFont(m.box, m.inner)), 250);
  });

  function renderBubbles(wrapper, data, img) {
    const W = wrapper.clientWidth || img.clientWidth;
    const H = wrapper.clientHeight || img.clientHeight;
    const ratio = W && H ? W / H : 0.7;
    const padX = 0.8; // ขยายกรอบออกเล็กน้อย (% ของความกว้างรูป) ให้ปิดตัวอักษรเดิมมิด
    const padY = padX * ratio; // ระยะเท่ากันในแนวตั้ง

    const made = [];
    (data.bubbles || []).forEach((b) => {
      const bx = b.box_2d;
      if (!Array.isArray(bx) || bx.length !== 4 || !b.thai_text) return;
      const nums = bx.map(Number);
      if (nums.some(Number.isNaN)) return;
      const ys = [nums[0], nums[2]].sort((a, c) => a - c);
      const xs = [nums[1], nums[3]].sort((a, c) => a - c);
      const left = Math.max(0, xs[0] / 10 - padX);
      const top = Math.max(0, ys[0] / 10 - padY);
      const right = Math.min(100, xs[1] / 10 + padX);
      const bottom = Math.min(100, ys[1] / 10 + padY);
      if (right <= left || bottom <= top) return;

      const bg = b.bg || '#fff';
      const fg = b.fg || '#111';
      const wPx = ((right - left) / 100) * W;
      const hPx = ((bottom - top) / 100) * H;

      const box = document.createElement('div');
      const inner = document.createElement('span');
      inner.textContent = b.thai_text;
      Object.assign(inner.style, { display: 'block', maxWidth: '100%' });
      box.appendChild(inner);

      Object.assign(box.style, {
        position: 'absolute',
        top: `${top}%`,
        left: `${left}%`,
        width: `${right - left}%`,
        height: `${bottom - top}%`,
        backgroundColor: bg,
        color: fg,
        borderRadius: `${Math.round(Math.min(wPx, hPx) * 0.18)}px`,
        boxShadow: `0 0 4px 3px ${bg}`, // ขอบเบลอกลืนเข้าหาภาพ
        padding: '2px 3px',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        lineHeight: '1.25',
        fontWeight: '700',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Thonburi", sans-serif',
        overflow: 'hidden',
        overflowWrap: 'anywhere',
        textWrap: 'balance',
        zIndex: '9',
        opacity: '0',
        transition: 'opacity 0.25s ease',
      });

      // แตะที่กล่องเพื่อดูต้นฉบับชั่วคราว
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        box.style.opacity = box.style.opacity === '0.1' ? '1' : '0.1';
      });

      wrapper.appendChild(box);
      made.push({ box, inner });
    });

    // วัดและปรับฟอนต์หลังใส่ครบทุกกล่อง แล้วค่อยให้ค่อยๆ ปรากฏพร้อมกัน
    made.forEach((m) => fitFont(m.box, m.inner));
    made.forEach((m) => renderedBoxes.push(m));
    requestAnimationFrame(() => {
      made.forEach((m) => {
        m.box.style.opacity = '1';
      });
    });
  }

  async function translateImage(img) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) return;

    // หารูปก่อนหน้าในลำดับการอ่าน
    const idx = mangaImagesList.indexOf(img);
    const prevImg = idx > 0 ? mangaImagesList[idx - 1] : null;
    const prevSrc = prevImg ? prevImg.currentSrc || prevImg.src : null;

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.verticalAlign = 'top';
    wrapper.style.width = img.style.width || '100%';
    img.parentNode.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    // เคยแปลรูปนี้แล้ว -> แสดงทันที ไม่ต้องเรียกเซิร์ฟเวอร์
    const cached = cacheGet(src);
    if (cached) {
      renderBubbles(wrapper, cached, img);
      return;
    }

    const badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'absolute',
      top: '8px',
      left: '8px',
      maxWidth: '90%',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      padding: '4px 8px',
      borderRadius: '6px',
      fontSize: '12px',
      lineHeight: '1.3',
      zIndex: '10',
    });
    wrapper.appendChild(badge);

    const run = async () => {
      badge.innerText = 'กำลังแปล...';
      badge.style.background = 'rgba(0,0,0,0.75)';
      badge.onclick = null;
      try {
        const { data, sample } = await enqueue(async () => {
          const built = await buildPayload(src, prevSrc);
          const result = await callApiWithRetry(built.payload, (m) => {
            badge.innerText = m;
          });
          return { data: result, sample: built.sample };
        }, img);

        const bubbles = (data.bubbles || []).map((b) => {
          const c = sample ? sampleBox(sample, b.box_2d) : null;
          return { box_2d: b.box_2d, thai_text: b.thai_text, bg: c && c.bg, fg: c && c.fg };
        });
        const slim = { bubbles };
        cacheSet(src, slim);
        renderBubbles(wrapper, slim, img);
        badge.remove();
      } catch (err) {
        const reason = String((err && err.message) || err).slice(0, 90);
        badge.innerText = `แปลไม่สำเร็จ: ${reason} (แตะเพื่อลองใหม่)`;
        badge.style.background = 'rgba(200,0,0,0.85)';
        badge.onclick = run;
        console.error('Translator Error:', err);
      }
    };
    run();
  }

  toggleBtn.addEventListener('click', () => {
    isEnabled = !isEnabled;
    toggleBtn.innerText = isEnabled ? 'แปล Manhwa: ON' : 'แปล Manhwa: OFF';
    toggleBtn.style.backgroundColor = isEnabled ? '#10b981' : '#333';
    if (isEnabled) {
      wakeServer();
      scanMangaImages();
    }
  });

  // เว็บอ่านมังงะมักโหลดรูปแบบ lazy-load ระหว่างเลื่อน จึงสแกนซ้ำเป็นระยะ
  setInterval(() => {
    if (isEnabled) scanMangaImages();
  }, 2500);
})();
