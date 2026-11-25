// ==UserScript==
// @name         iOS Manhwa Context-Aware Translator
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  แปล Manhwa อังกฤษ/ญี่ปุ่นเป็นไทย พร้อมจำบริบทแยกตามเรื่อง
// @match        *://*/*
// @grant        none
// ==/UserScript==
 
(function () {
  'use strict';
 
  // เปลี่ยนเป็นลิงก์จาก Render ของคุณ (ต้องมี /translate ต่อท้าย)
  const API_URL = 'https://translator-xxxx.onrender.com/translate';
 
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
 
  // ปุ่มเปิด/ปิด ลอยมุมขวาล่าง
  const toggleBtn = document.createElement('button');
  toggleBtn.innerText = 'แปล Manhwa: OFF';
  Object.assign(toggleBtn.style, {
    position: 'fixed',
    bottom: '24px',
    right: '16px',
    zIndex: '999999',
    padding: '10px 14px',
    borderRadius: '20px',
    border: 'none',
    backgroundColor: '#333',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 'bold',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
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
      else img.addEventListener('load', checkAnd
