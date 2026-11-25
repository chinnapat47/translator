// ==UserScript==
// @name         iOS Manhwa Context-Aware Translator
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  แปล Manhwa อังกฤษ/ญี่ปุ่นเป็นไทย พร้อมจำบริบทแยกตามเรื่อง
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

  const MAX_CONCURRENT = 2;          // แปลพร้อมกันได้กี่รูป
  const MIN_INTERVAL_MS = 6500;      // เว้นระยะระหว่างคำขอ (~9 ครั้ง/นาที) กัน Gemini ตอบ 429 ปรับเลขนี้ได้ตามโควต้าของคุณ
  const MAX_UPLOAD_WIDTH = 1000;     // ย่อรูปก่อนส่ง ให้ส่งเร็วและไม่เกินขนาดที่เซิร์ฟเวอร์รับ
  const MAX_CANVAS_PIXELS = 16000000; // ขีดจำกัด canvas ของ iOS Safari
  const REQUEST_TIMEOUT = 120000;    // Render ฟรีตื่นจากหลับได้นานถึง ~1 นาที

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

  // ย่อรูป + แปลงเป็น JPEG (ได้ทั้ง avif/webp ที่ Gemini ไม่รับ) ถ้าทำไม่ได้ก็ส่งไฟล์เดิม
  function prepareImage(buf) {
    return new Promise((resolve) => {
      const sendRaw = () => resolve({ b64: bufferToBase64(buf), mime: '' });
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
            URL.revokeObjectURL(objUrl);
            resolve({ b64: dataUrl.split(',')[1], mime: 'image/jpeg' });
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

  // แคชรูปที่เตรียมแล้ว (รูปหนึ่งถูกใช้เป็น "รูปก่อนหน้า" ของรูปถัดไปด้วย)
  const prepCache = new Map();
  function getPrepared(src) {
    if (!prepCache.has(src)) {
      const p = downloadImage(src).then(prepareImage);
      p.catch(() => prepCache.delete(src));
      prepCache.set(src, p);
      if (prepCache.size > 8) prepCache.delete(prepCache.keys().next().value);
    }
    return prepCache.get(src);
  }

  async function buildPayload(src, prevSrc) {
    const payload = {
      series_id: getSeriesId(),
      image_url: src,
      prev_image_url: prevSrc,
      referer: window.location.href,
    };
    if (!gmXhr) return payload; // ไม่มี GM -> ให้เซิร์ฟเวอร์โหลดเอง
    try {
      const main = await getPrepared(src);
      payload.image_b64 = main.b64;
      payload.image_mime = main.mime;
    } catch (e) {
      console.warn('Translator: โหลดรูปผ่านเบราว์เซอร์ไม่ได้ ให้เซิร์ฟเวอร์ลองโหลดเอง', e);
      return payload;
    }
    if (prevSrc) {
      try {
        const prev = await getPrepared(prevSrc);
        payload.prev_image_b64 = prev.b64;
        payload.prev_image_mime = prev.mime;
      } catch (e) {
        /* รูปก่อนหน้าเป็นแค่ตัวช่วย ข้ามได้ */
      }
    }
    return payload;
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
  async function rateGate() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
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

  // คิว: จำกัดจำนวนที่แปลพร้อมกัน
  let running = 0;
  const queue = [];
  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      running++;
      job.task().then(job.resolve, job.reject).finally(() => {
        running--;
        pump();
      });
    }
  }
  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
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
    { rootMargin: '900px 0px' }
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

  function renderBubbles(wrapper, data) {
    (data.bubbles || []).forEach(({ box_2d, thai_text }) => {
      if (!Array.isArray(box_2d) || box_2d.length !== 4) return;
      const [ymin, xmin, ymax, xmax] = box_2d;
      const box = document.createElement('div');
      box.textContent = thai_text;

      const widthPct = (xmax - xmin) / 10;
      const heightPct = (ymax - ymin) / 10;

      Object.assign(box.style, {
        position: 'absolute',
        top: `${ymin / 10}%`,
        left: `${xmin / 10}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`,
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        color: '#111',
        borderRadius: '8px',
        padding: '2px 4px',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        lineHeight: '1.2',
        fontWeight: '600',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Thonburi", sans-serif',
        fontSize: `${Math.max(10, Math.min(16, Math.round(heightPct * 1.5)))}px`,
        overflow: 'hidden',
        zIndex: '9',
      });

      // แตะที่กล่องเพื่อดูต้นฉบับชั่วคราว
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        box.style.opacity = box.style.opacity === '0.1' ? '1' : '0.1';
      });

      wrapper.appendChild(box);
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
    wrapper.style.width = img.style.width || '100%';
    img.parentNode.insertBefore(wrapper, img);
    wrapper.appendChild(img);

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
      zIndex: '10',
    });
    wrapper.appendChild(badge);

    const run = async () => {
      badge.innerText = 'กำลังแปล...';
      badge.style.background = 'rgba(0,0,0,0.75)';
      badge.onclick = null;
      try {
        const payload = await buildPayload(src, prevSrc);
        const data = await enqueue(() =>
          callApiWithRetry(payload, (m) => {
            badge.innerText = m;
          })
        );
        renderBubbles(wrapper, data);
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
