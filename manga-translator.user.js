// ==UserScript==
// @name         iOS Manhwa Context-Aware Translator
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  แปล Manhwa อังกฤษ/ญี่ปุ่นเป็นไทย พร้อมจำบริบทแยกตามเรื่อง
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // เปลี่ยนเป็นลิงก์จาก Render ของคุณ (ต้องมี /translate ต่อท้าย)
const API_URL = 'https://translator-o53c.onrender.com/translate';

  let isEnabled = false;
  const processedImages = new WeakSet();
  let mangaImagesList = [];

  // ดึงชื่อเรื่องจาก URL เพื่อใช้แยกไฟล์ความจำ
  function getSeriesId() {
    const cleanPath = window.location.pathname
      .replace(/\/(chapter|ch|ep|episode|vol)[-_]?\d+.*$/i, '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase();
    return cleanPath || document.title.slice(0, 30).replace(/[^a-zA-Z0-9]+/g, '_');
  }

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
      if (processedImages.has(img)) return;
      const checkAndObserve = () => {
        if (img.naturalWidth >= 400 && img.naturalHeight >= 300) {
          processedImages.add(img);
          mangaImagesList.push(img);
          observer.observe(img);
        }
      };
      if (img.complete) checkAndObserve();
      else img.addEventListener('load', checkAndObserve, { once: true });
    });
  }

  async function translateImage(img) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) return;

    // หารูปก่อนหน้าในลำดับการอ่าน
    const idx = mangaImagesList.indexOf(img);
    const prevImg = idx > 0 ? mangaImagesList[idx - 1] : null;
    const prevSrc = prevImg ? (prevImg.currentSrc || prevImg.src) : null;

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.width = img.style.width || '100%';
    img.parentNode.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    const badge = document.createElement('div');
    badge.innerText = 'กำลังแปล...';
    Object.assign(badge.style, {
      position: 'absolute',
      top: '8px',
      left: '8px',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      padding: '4px 8px',
      borderRadius: '6px',
      fontSize: '12px',
      zIndex: '10',
    });
    wrapper.appendChild(badge);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series_id: getSeriesId(),
          image_url: src,
          prev_image_url: prevSrc,
          referer: window.location.href,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      data.bubbles.forEach(({ box_2d, thai_text }) => {
        const [ymin, xmin, ymax, xmax] = box_2d;
        const box = document.createElement('div');
        box.innerText = thai_text;

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

      badge.remove();
    } catch (err) {
      badge.innerText = 'แปลไม่สำเร็จ';
      badge.style.background = 'rgba(200,0,0,0.85)';
      console.error('Translator Error:', err);
    }
  }

  toggleBtn.addEventListener('click', () => {
    isEnabled = !isEnabled;
    toggleBtn.innerText = isEnabled ? 'แปล Manhwa: ON' : 'แปล Manhwa: OFF';
    toggleBtn.style.backgroundColor = isEnabled ? '#10b981' : '#333';
    if (isEnabled) scanMangaImages();
  });
})();
