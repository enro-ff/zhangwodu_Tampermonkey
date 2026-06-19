import { SCREENS } from './constants.js';
import { getThreshold, updateRetryMax, lowThanMaxRetry, incRetryCount, sleep } from './utils.js';

export const click = (el) => {
  if (!el) return;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: unsafeWindow }));
};

export const clickUntilGone = async (selectorOrFn, timeout = 15000, step = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (unsafeWindow.__ZHS_STOP) return false;
    const el = typeof selectorOrFn === 'function' ? selectorOrFn() : document.querySelector(selectorOrFn);
    if (!el) return true;
    click(el);
    await sleep(step);
  }
  return false;
};

export const waitFor = async (fn, timeout = 30000, step = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (unsafeWindow.__ZHS_STOP) return null;
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};

export const detectScreen = () => {
  if (document.querySelector('.charts-rate')) return SCREENS.RESULT;
  const q = document.querySelector('.questionContent');
  if (q?.innerText?.trim()) return SCREENS.QUIZ;
  if (document.querySelector('.improve-btn')) return SCREENS.PRE_QUIZ;
  if (document.querySelector('.simplified-mastery__action')) return SCREENS.DETAIL;
  const dash = document.querySelector('.el-progress--dashboard');
  if (dash && /\d+/.test(dash.innerText || '')) return SCREENS.LIST;
  return SCREENS.UNKNOWN;
};

export const parsePct = (el) => parseInt((el?.innerText || '').replace(/\D/g, ''), 10);

export const findLowPctProgress = (increase = false) => {
  const threshold = getThreshold();
  const all = [...document.querySelectorAll('.el-progress--dashboard')];
  updateRetryMax(all.length);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const pct = parsePct(el);
    if (!Number.isNaN(pct) && pct < threshold && lowThanMaxRetry(i)) {
      if (increase) incRetryCount(i);
      return el;
    }
  }
  return null;
};

export const hasListWork = () => !!findLowPctProgress();

export const enlargeSmallImage = (imgEl, minTarget = 20) =>
  new Promise((resolve) => {
    const w = imgEl.naturalWidth || imgEl.width || 0;
    const h = imgEl.naturalHeight || imgEl.height || 0;
    if (w > 10 && h > 10) {
      resolve(imgEl.src);
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: imgEl.src,
      responseType: 'blob',
      onload: (resp) => {
        const blob = resp.response;
        const blobUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(blobUrl);
          const scale = minTarget / Math.min(img.width, img.height);
          const nw = Math.round(img.width * scale);
          const nh = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = nw;
          canvas.height = nh;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, nw, nh);
          console.log('url', canvas.toDataURL('image/png'));
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          resolve(imgEl.src);
        };
        img.src = blobUrl;
      },
      onerror: () => resolve(imgEl.src),
    });
  });

export const getQuestionBlocks = async (root) => {
  if (!root) return [];
  const blocks = [];
  let imgIndex = 0;

  const pushText = (s) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') last.content += ' ' + t;
    else blocks.push({ type: 'text', content: t });
  };

  const walk = async (node) => {
    if (node.nodeType === 3) {
      pushText(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    if (/^(SCRIPT|STYLE)$/i.test(node.tagName)) return;
    if (node.classList?.contains('upload')) return;
    if (node.tagName === 'IMG') {
      if (node.src.includes('fc9f26dc-8a16-44b9-b171-17a42641b0da')) {
        pushText('x');
        return;
      }
      const w = node.naturalWidth || node.width || 0;
      const h = node.naturalHeight || node.height || 0;
      if (w > 0 && h > 0) {
        imgIndex += 1;
        const src = await enlargeSmallImage(node);
        blocks.push({
          type: 'image',
          index: imgIndex,
          src,
          alt: node.alt || '',
        });
      }
      return;
    }
    if (node.tagName === 'BR') {
      pushText('\n');
      return;
    }
    for (const child of node.childNodes) await walk(child);
  };

  await walk(root);
  return blocks;
};

export const blocksToMarkdown = (blocks) =>
  blocks.map((b) => (b.type === 'text' ? b.content : `[IMAGE:${b.index}]`)).join('\n');

export const readQuestion = async () => {
  const root = document.querySelector('.questionContent');
  const blocks = await getQuestionBlocks(root);
  unsafeWindow.__questionBlocks = blocks;
  return blocks;
};

export const isMultipleChoice = () => !!document.querySelector('.el-checkbox-group.checkbox-view');

export const getQuizOptions = () => {
  if (isMultipleChoice()) {
    return [...document.querySelectorAll('.el-checkbox-group.checkbox-view .el-checkbox')];
  }
  return [...document.querySelectorAll('ul.radio-view li')];
};

export const getMismatchNode = () => {
  const list = [...document.querySelectorAll('.custom-tree-answer-normal.no-answer')];
  const sortChar = (document.querySelector('.letterSortNum')?.innerText || '').trim().charAt(0);
  if (list.length >= 2) {
    for (let i = 1; i < list.length; i++) {
      const c1 = (list[i].innerText || '').trim().charAt(0);
      if (c1 !== sortChar) return list[i];
    }
  }
  return null;
};

export const getBase64Image = (url) => {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: url,
      responseType: 'blob',
      onload: (response) => {
        if (response.status === 200) {
          const blob = response.response;
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve(reader.result);
          };
          reader.readAsDataURL(blob);
        } else {
          reject(new Error('图片加载失败'));
        }
      },
      onerror: (err) => {
        reject(err);
      },
    });
  });
};

export const processCrossImg = async (originalEl) => {
  const rect = originalEl.getBoundingClientRect();
  const clone = originalEl.cloneNode(true);

  clone.style.position = 'fixed';
  clone.style.left = '-99999px';
  clone.style.top = '0';
  clone.style.width = rect.width + 'px';
  clone.style.height = rect.height + 'px';
  clone.style.boxSizing = 'border-box';

  const computedStyle = window.getComputedStyle(originalEl);
  clone.style.backgroundColor = computedStyle.backgroundColor || '#ffffff';
  clone.style.color = computedStyle.color || '#333333';

  document.body.appendChild(clone);

  const images = clone.querySelectorAll('img');
  const decodePromises = [];

  const promises = Array.from(images).map(async (img) => {
    const src = img.src;
    if (!src || src.startsWith('data:') || src.startsWith(window.location.origin)) {
      return;
    }
    try {
      const base64 = await getBase64Image(src);
      img.src = base64;
      if (typeof img.decode === 'function') {
        decodePromises.push(img.decode().catch(() => {}));
      }
    } catch (e) {
      console.error('图片转换失败: ', src, e);
    }
  });

  await Promise.all(promises);
  await Promise.all(decodePromises);
  await new Promise((resolve) => setTimeout(resolve, 100));

  return clone;
};

export const captureElement = async (element) => {
  if (!element) return null;
  const cleanedElement = await processCrossImg(element);
  const h2c = window.html2canvas || globalThis.html2canvas;
  if (!h2c) {
    cleanedElement.remove();
    throw new Error('未加载 html2canvas 库！请检查脚本 @require 配置。');
  }
  try {
    const canvas = await h2c(cleanedElement, {
      scale: 2,
      useCORS: true,
      backgroundColor: window.getComputedStyle(element).backgroundColor || '#ffffff'
    });
    const imgData = canvas.toDataURL('image/png');
    cleanedElement.remove();
    return imgData;
  } catch (e) {
    cleanedElement.remove();
    throw e;
  }
};

export const getScreenshotTarget = (screen) => {
  if (screen === SCREENS.QUIZ) {
    const q = document.querySelector('.questionContent');
    if (!q) return null;
    const mc = !!document.querySelector('.el-checkbox-group.checkbox-view');
    const opts = mc
      ? document.querySelector('.el-checkbox-group.checkbox-view')
      : document.querySelector('ul.radio-view');
    if (!opts) return q;
    
    let parent = q.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      if (parent.contains(opts)) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return q;
  } else {
    return document.querySelector('.question-area-content');
  }
};

