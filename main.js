// ==UserScript==
// @name         智慧树掌握度-最小链路(自动续跑-狂点轰炸版)
// @namespace    https://github.com/local/zhihuishu-min-chain
// @version      1.0.0
// @description  DOM 探测屏状态 + 页内控制面板；支持自定义 AI API（需使用有视觉能力的模型）；任意界面可续跑，仅手动开始后执行。
// @match        https://ai-smart-course-student-pro.zhihuishu.com/*
// @match        https://studentexamcomh5.zhihuishu.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LOOP_KEY = 'zhs_loop';
  const PANEL_POS_KEY = 'zhs_panel_pos';
  const PANEL_COLLAPSED_KEY = 'zhs_panel_collapsed';
  const THRESHOLD_KEY = 'zhs_threshold';
  const MAX_HOPS = 500;
  const ROUTE_SETTLE_MS = 200;
  const NAV_BACK_SEL = '[class*="w-[32px]"][class*="h-[32px]"].cursor-pointer';

  const SCREENS = {
    LIST: 'LIST',
    DETAIL: 'DETAIL',
    PRE_QUIZ: 'PRE_QUIZ',
    QUIZ: 'QUIZ',
    RESULT: 'RESULT',
    UNKNOWN: 'UNKNOWN',
  };

  // OpenAI 兼容 API 配置 (支持本地存储自定义)
  const getApiCfg = () => ({
    baseUrl: GM_getValue('zhs_api_baseurl', ''),
    apiKey: GM_getValue('zhs_api_apikey', ''),
    model: GM_getValue('zhs_api_model', ''),
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isLoopOn = () => {
    const date = Date.now();
    return GM_getValue(LOOP_KEY, 0) >= date
  }

  const setLoopKey = (value = false) => {
    if(value && !unsafeWindow.__ZHS_STOP){
      GM_setValue(LOOP_KEY, Date.now() + 1000 * 60 * 2);
    }else{
      GM_setValue(LOOP_KEY, 0);
    }
  }

  const getThreshold = () => GM_getValue(THRESHOLD_KEY, 80);

  const parsePct = (el) => parseInt((el?.innerText || '').replace(/\D/g, ''), 10);

  const findLowPctProgress = () => {
    const threshold = getThreshold();
    for (const el of document.querySelectorAll('.el-progress--dashboard')) {
      const pct = parsePct(el);
      if (!Number.isNaN(pct) && pct < threshold) return el;
    }
    return null;
  };

  const hasListWork = () => !!findLowPctProgress();

  /** 按流程从后往前探测当前屏（SPA 路由不刷新） */
  const detectScreen = () => {
    // RESULT · 成绩页：有正确率/得分图表（PRE_QUIZ 也有 backup-icon，不能用它判断）
    if (document.querySelector('.charts-rate')) return SCREENS.RESULT;
    // QUIZ · 答题页：题干已渲染（不用 reviewDone 探测，提交钮可能常驻）
    const q = document.querySelector('.questionContent');
    if (q?.innerText?.trim()) return SCREENS.QUIZ;
    // PRE_QUIZ · 提升入口页：「提升 / 开始」按钮
    if (document.querySelector('.improve-btn')) return SCREENS.PRE_QUIZ;
    // DETAIL · 知识点详情：「去提升」（也可能是 RESULT 退出链的落点，需结合 expectDetailForward）
    if (document.querySelector('.simplified-mastery__action')) return SCREENS.DETAIL;
    // LIST · 掌握度列表：环形进度条
    const dash = document.querySelector('.el-progress--dashboard');
    if (dash && /\d+/.test(dash.innerText || '')) return SCREENS.LIST;
    return SCREENS.UNKNOWN;
  };

  const AI_CHAT = {
    maxAttempts: 3,
    timeoutMs: 45000,
    retryDelayMs: 1500,
  };

  const AI_STATUS = {
    IDLE: 'idle',
    REQUESTING: 'requesting',
    RETRYING: 'retrying',
    SUCCESS: 'success',
    FAILED: 'failed',
  };

  const createAIChatState = () => ({
    status: AI_STATUS.IDLE,
    attempt: 0,
    lastRaw: '',
    lastError: null,
  });

  const parseAnswerLetter = (raw) => {
    const match = (raw || '').match(/答案[：:]\s*([A-Z])/i);
    return match ? match[1].toUpperCase() : null;
  };

  const isValidQuizAnswer = (raw, optionCount) => {
    const all = [...(raw || '').matchAll(/答案[：:]\s*([A-Z]+)/ig)];
    const last = all[all.length - 1];
    if (!last) return false;
    const letters = last[1].toUpperCase();
    return [...letters].every(l => {
      const idx = l.charCodeAt(0) - 65;
      return idx >= 0 && idx < optionCount;
    });
  };

  const parseApiError = (res) => {
    let msg = '';
    try {
      const body = JSON.parse(res.responseText);
      msg = body?.error?.message || body?.error?.msg || body?.message || body?.msg || body?.error || '';
      if (typeof msg === 'object') msg = JSON.stringify(msg);
    } catch (_) {
      msg = res.responseText || '';
    }
    return msg.slice(0, 300);
  };

  const callAIOnce = (messages) =>
    new Promise((resolve, reject) => {
      const apiCfg = getApiCfg();
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${apiCfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiCfg.apiKey}`,
        },
        data: JSON.stringify({
          model: apiCfg.model,
          messages,
          temperature: 0.2,
        }),
        timeout: AI_CHAT.timeoutMs,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            const detail = parseApiError(res);
            reject(new Error(`AI HTTP ${res.status}${detail ? ' | ' + detail : ''}`));
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            const text = data?.choices?.[0]?.message?.content;
            resolve(text.trim());
          } catch (e) {
            reject(new Error(`AI 响应解析失败: ${e.message}`));
          }
        },
        onerror: () => reject(new Error('AI 网络错误')),
        ontimeout: () => reject(new Error('AI 请求超时')),
      });
    });

  /**
   * 统一 AI 对话：超时/网络错误自动重试；validate 不通过时带纠错提示重试
   * @param {(attempt: number, state: object) => Array} buildMessages
   * @param {(raw: string) => boolean} validate
   */
  const requestAI = async (buildMessages, validate) => {
    const chatState = createAIChatState();

    for (let attempt = 1; attempt <= AI_CHAT.maxAttempts; attempt++) {
      chatState.attempt = attempt;
      chatState.status = attempt === 1 ? AI_STATUS.REQUESTING : AI_STATUS.RETRYING;

      try {
        const messages = buildMessages(attempt, chatState);
        const raw = await callAIOnce(messages);
        chatState.lastRaw = raw;

        if (validate(raw)) {
          chatState.status = AI_STATUS.SUCCESS;
          return { raw, state: chatState };
        }

        chatState.lastError = '答案格式不合规';
      } catch (e) {
        chatState.lastError = e.message || String(e);
      }

      if (attempt < AI_CHAT.maxAttempts) {
        await sleep(AI_CHAT.retryDelayMs);
      }
    }

    chatState.status = AI_STATUS.FAILED;
    if (chatState.lastError === '答案格式不合规') {
      throw new Error(`AI 答案不合规，已重试 ${AI_CHAT.maxAttempts} 次: ${chatState.lastRaw}`);
    }
    throw new Error(`AI 请求失败，已重试 ${AI_CHAT.maxAttempts} 次: ${chatState.lastError}`);
  };

  const click = (el) => {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: unsafeWindow }));
  };

  /**
   * 核心原子函数：轮询点击指定 DOM 元素，直到该元素不存在（或函数返回 null）
   * @param {string|Function} selectorOrFn 选择器字符串或动态返回 DOM 的函数
   * @param {number} timeout 最大超时时间（毫秒）
   * @param {number} step 点击轮询间隔（毫秒），100ms 保证极高灵敏度
   */
  const clickUntilGone = async (selectorOrFn, timeout = 15000, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (unsafeWindow.__ZHS_STOP) return false;
      const el = typeof selectorOrFn === 'function' ? selectorOrFn() : document.querySelector(selectorOrFn);
      // 如果元素已经不存在了，直接判定成功，跳出并进入下一步
      if (!el) return true;
      click(el);
      await sleep(step);
    }
    return false;
  };

  // 标准异步等待函数（用于被动等待数据加载）
  const waitFor = async (fn, timeout = 30000, step = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (unsafeWindow.__ZHS_STOP) return null;
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };

const enlargeSmallImage = (imgEl, minTarget = 20) =>
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
          URL.revokeObjectURL(blobUrl); // 及时释放内存
          const scale = minTarget / Math.min(img.width, img.height);
          const nw = Math.round(img.width * scale);
          const nh = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = nw;
          canvas.height = nh;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, nw, nh);
          resolve(canvas.toDataURL('image/png'));
          console.log('url',canvas.toDataURL('image/png'));
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

  const getQuestionBlocks = async (root) => {
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
        if(node.src === 'https://hike-export.oss-cn-hangzhou.aliyuncs.com/p…20260130/fc9f26dc-8a16-44b9-b171-17a42641b0da.png'){//傻逼智慧树这个图片ai识别错误
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

  const blocksToMarkdown = (blocks) =>
    blocks.map((b) => (b.type === 'text' ? b.content : `[IMAGE:${b.index}]`)).join('\n');

  const readQuestion = async () => {
    const root = document.querySelector('.questionContent');
    const blocks = await getQuestionBlocks(root);
    unsafeWindow.__questionBlocks = blocks;
    const md = blocksToMarkdown(blocks);
    return blocks;
  };

  const buildQuizMessages = (blocks, optLines, attempt, chatState, isMultiple = false) => {
    const answerFmt = isMultiple
      ? '最后一行必须以"答案：X"的格式输出，X 为多个连续字母（对应所有正确选项，例如"ABC"表示选A、B、C三个选项）'
      : '最后一行必须以"答案：X"的格式输出，X 只能为单个字母（对应正确选项）';
    let prompt = `请逐步用平文本思考并选出正确答案的选项。${answerFmt}。题目：\n\n${blocksToMarkdown(blocks)}\n\n选项：\n${optLines.join('\n')}`;

    if (attempt > 1 && chatState.lastRaw) {
      prompt += `\n\n【重试】你上次回答不合规（需以"答案：X"结尾且 X 为有效选项字母）。请重新作答。上次回答：\n${chatState.lastRaw}`;
    } else if (attempt > 1 && chatState.lastError) {
      prompt = `请逐步用平文本思考并选出正确答案的选项。${answerFmt}。题目：\n\n${blocksToMarkdown(blocks)}\n\n选项：\n${optLines.join('\n')}`;
    }


    const content = [{ type: 'text', text: prompt }];
    blocks
      .filter((b) => b.type === 'image')
      .forEach((b) => content.push({ type: 'image_url', image_url: { url: b.src } }));
    return [{ role: 'user', content }];
  };

  const isMultipleChoice = () => !!document.querySelector('.el-checkbox-group.checkbox-view');

  const getQuizOptions = () => {
    if (isMultipleChoice()) {
      return [...document.querySelectorAll('.el-checkbox-group.checkbox-view .el-checkbox')];
    }
    return [...document.querySelectorAll('ul.radio-view li')];
  };

  const parseAnswerLetters = (raw) => {
    const all = [...(raw || '').matchAll(/答案[：:]\s*([A-Z]+)/ig)];
    const last = all[all.length - 1];
    return last ? [...last[1].toUpperCase()] : [];
  };

  const answerWithAI = async (blocks) => {
    const mc = isMultipleChoice();
    const opts = getQuizOptions();
    if (!opts.length) return null;

    const optLines = opts.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt.innerText.trim()}`);
    const { raw } = await requestAI(
      (attempt, chatState) => buildQuizMessages(blocks, optLines, attempt, chatState, mc),
      (raw) => isValidQuizAnswer(raw, opts.length),
    );

    const letters = parseAnswerLetters(raw);
    for (const letter of letters) {
      const idx = letter.charCodeAt(0) - 65;
      const targetOpt = opts[idx];
      if (!targetOpt) continue;
      if (mc) {
        if (!targetOpt.classList.contains('is-checked')) {
          click(targetOpt);
          await waitFor(() => targetOpt.classList.contains('is-checked') ? true : null, 3000, 50);
        }
      } else {
        const oldClass = targetOpt.className;
        await clickUntilGone(() => {
          return targetOpt.className === oldClass ? targetOpt : null;
        }, 3000);
      }
    }
    return raw;
  };

  // 获取当前未答题目
  const getMismatchNode = () => {
    const list = [...document.querySelectorAll('.custom-tree-answer-normal.no-answer')];
    const sortChar = (document.querySelector('.letterSortNum')?.innerText || '').trim().charAt(0);//当前题号，避免打完没有更新
    if (list.length >= 2) {
      for (let i = 1; i < list.length; i++) {
        const c1 = (list[i].innerText || '').trim().charAt(0);
        if (c1 !== sortChar) return list[i];
      }
    }
    return null;
  };

  async function runListHop() {
    if (!isLoopOn()) return false;

    // 等待掌握度列表面板重新加载并带有百分比数字
    const hasDashboard = await waitFor(() => {
      const el = document.querySelector('.el-progress--dashboard');
      return el && /\d+/.test(el.innerText || '') ? el : null;
    }, 30000);
    if (!hasDashboard) return false;

    if (!hasListWork()) {
      setLoopKey(false);
      return false;
    }

    // 点击掌握度不足 80% 的题目，直到该目标在页面上消失
    return clickUntilGone(() => findLowPctProgress());
  }

  async function runDetailHop() {
    setLoopKey(true);//更新时间戳
    // 从 LIST 点进 DETAIL 后：进入题目，点击「去提升」
    return clickUntilGone('.simplified-mastery__action');
  }

  async function runDetailExitHop() {
    setLoopKey(true);//更新时间戳
    // DETAIL 退回 LIST：脚本首次进入、或 RESULT 退出链落点（小箭头实际路由仍到 DETAIL 的上一级）
    return clickUntilGone(NAV_BACK_SEL);
  }

  async function runPreQuizHop() {
    setLoopKey(true);//更新时间戳
    // �提升 / 开始提升 / 开始」按钮，直到它消失
    return clickUntilGone('.improve-btn',undefined, 10000);//傻逼智慧树不做防抖
  }

  /** QUIZ = 答题 + 提交（同一屏）；是否提交由 getMismatchNode 判断，不用 reviewDone 是否存在 */
  async function runQuizHop() {
    // 确保题目容器和选项文本被 JS 异步渲染出来
    const isReady = await waitFor(() => {
      const q = document.querySelector('.questionContent');
      if (!q || !q.innerText.trim()) return null;
      const mc = !!document.querySelector('.el-checkbox-group.checkbox-view');
      const opts = mc
        ? document.querySelectorAll('.el-checkbox-group.checkbox-view .el-checkbox')
        : document.querySelectorAll('ul.radio-view li');
      return opts.length > 0 && opts[0].innerText.trim() ? q : null;
    }, 30000);
    if (!isReady) return false;

    const oldText = isReady.innerText; // 备份当前题目文本，用于防错比对
    panelNotify('quiz', { phase: 'start' });
    try {
      const aiRaw = await answerWithAI(await readQuestion());
      panelNotify('quiz', { phase: 'done', aiOutput: aiRaw });
    } catch (e) {
      panelNotify('error', e?.message || 'AI 答题失败');
      return false;
    }

    setLoopKey(true);//更新时间戳

    // 侧栏还有未答题 → 切下一题（不能提交）
    if (getMismatchNode()) {
      return clickUntilGone(() => {
        const currentQ = document.querySelector('.questionContent');
        if (!currentQ || currentQ.innerText !== oldText) return null;
        return getMismatchNode();
      });
    }

    panelNotify('hop', { screen: SCREENS.QUIZ, action: '提交作业' });
    // 侧栏无未答题 → 提交（reviewDone 可能一直存在，仅作点击目标）
    setLoopKey(true);//更新时间戳
    return clickUntilGone('.reviewDone.ZHIHUISHU_QZMD');
  }

  async function runResultHop() {
    // RESULT · 成绩页：先点 backup-icon，再点小箭头（后者实际落到 DETAIL 而非 LIST）
    if (!document.querySelector('.charts-rate')) return false;
    const ok1 = await clickUntilGone('.backup-icon');
    if (!ok1) return false;
    await sleep(ROUTE_SETTLE_MS);
    return clickUntilGone(NAV_BACK_SEL);
  }

  async function runOneHop(screen, expectDetailForward) {
    switch (screen) {
      case SCREENS.LIST:
        return runListHop();
      case SCREENS.DETAIL:
        return expectDetailForward ? runDetailHop() : runDetailExitHop();
      case SCREENS.PRE_QUIZ:
        return runPreQuizHop();
      case SCREENS.QUIZ:
        return runQuizHop();
      case SCREENS.RESULT:
        return runResultHop();
      default:
        return false;
    }
  }

  const CHAIN_STEPS = [
    { id: SCREENS.LIST, label: '列表' },
    { id: SCREENS.DETAIL, label: '详情' },
    { id: SCREENS.PRE_QUIZ, label: '提升入口' },
    { id: SCREENS.QUIZ, label: '答题' },
    { id: SCREENS.RESULT, label: '成绩' },
  ];

  const SCREEN_LABELS = {
    [SCREENS.LIST]: '掌握度列表',
    [SCREENS.DETAIL]: '知识点详情',
    [SCREENS.PRE_QUIZ]: '提升入口',
    [SCREENS.QUIZ]: '答题页',
    [SCREENS.RESULT]: '成绩页',
    [SCREENS.UNKNOWN]: '未识别页面',
  };

  const hopActionLabel = (screen, expectDetailForward) => {
    switch (screen) {
      case SCREENS.LIST:
        return '选中低分题';
      case SCREENS.DETAIL:
        return expectDetailForward ? '去提升' : '退回列表';
      case SCREENS.PRE_QUIZ:
        return '开始提升';
      case SCREENS.QUIZ:
        return '答题/切题';
      case SCREENS.RESULT:
        return '退出成绩页';
      default:
        return '未知操作';
    }
  };

  let panelCtx = null;

  const panelNotify = (event, detail) => {
    if (panelCtx) panelCtx.handle(event, detail);
  };

  const createPanel = (handlers) => {
    const host = document.createElement('div');
    host.id = 'zhs-panel-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;margin:0;padding:0;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
        .wrap{position:fixed;top:0;right:0;width:28vw;height:100vh;color:#355148;font-size:12px;overflow:hidden;user-select:none;border-left:1px solid rgba(102,152,129,.16);background:linear-gradient(180deg,#f9fcf9 0%,#f3f8f3 56%,#edf4ee 100%);box-shadow:-12px 0 32px rgba(62,86,66,.06)}
        .wrap::before,.wrap::after{content:"";position:absolute;pointer-events:none}
        .wrap::before{top:-5vh;right:-4vw;width:12vw;height:14vw;background:radial-gradient(circle,rgba(164,212,179,.18),rgba(164,212,179,0));filter:blur(8px)}
        .wrap::after{bottom:-4vh;left:-3vw;width:10vw;height:10vw;background:radial-gradient(circle,rgba(215,234,220,.36),rgba(215,234,220,0));filter:blur(10px)}
        .wrap.collapsed{width:auto;height:auto;background:transparent;border:none;box-shadow:none}
        .fab{display:none;width:58px;height:58px;border-radius:18px;background:linear-gradient(180deg,#dcefe0,#cfe8d5);border:1px solid rgba(125,164,138,.3);color:#456556;font-weight:800;font-size:12px;letter-spacing:.12em;cursor:pointer;align-items:center;justify-content:center;box-shadow:0 14px 32px rgba(87,118,96,.15)}
        .wrap.collapsed .fab{display:flex}
        .wrap.collapsed .panel-shell{display:none}
        .panel-shell{display:flex;flex-direction:column;height:100%}
        .header{display:flex;align-items:center;gap:10px;padding:20px 18px 16px;background:linear-gradient(180deg,#e4f2e7 0%,#dceee1 100%);border-bottom:1px solid rgba(121,159,135,.16)}
        .dot{width:10px;height:10px;border-radius:999px;background:#8ea69b;flex-shrink:0;box-shadow:0 0 0 5px rgba(255,255,255,.42)}
        .dot.running{background:#67b67a;box-shadow:0 0 0 5px rgba(255,255,255,.52),0 0 18px rgba(103,182,122,.34);animation:zhs-pulse 1.4s ease infinite}
        @keyframes zhs-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.92);opacity:.72}}
        .title-wrap{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
        .title{font-family:"Georgia","Times New Roman",serif;font-weight:700;font-size:20px;letter-spacing:.02em;color:#2d4a3d}
        .subtitle{font-size:10px;color:#6e8d7a;letter-spacing:.16em;text-transform:uppercase}
        .icon-btn{border:none;color:#5f7d6b;cursor:pointer;width:34px;height:34px;border-radius:12px;font-size:14px;line-height:1;background:rgba(255,255,255,.54);border:1px solid rgba(121,159,135,.16);transition:.18s ease;box-shadow:inset 0 1px 0 rgba(255,255,255,.6)}
        .icon-btn:hover{color:#264437;background:#eef8f0;border-color:rgba(121,159,135,.3);transform:translateY(-1px)}
        .panel-body{position:relative;display:flex;flex-direction:column;gap:0;flex:1;min-height:0;padding:16px 16px 18px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
        .panel-body::-webkit-scrollbar{width:10px}
        .panel-body::-webkit-scrollbar-thumb{background:rgba(125,164,138,.28);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
        .panel-body::-webkit-scrollbar-track{background:transparent}
        .section-label{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px 0;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#7a9888}
        .section-label::after{content:"";flex:1;height:1px;margin-left:10px;background:linear-gradient(90deg,rgba(120,159,136,.26),rgba(120,159,136,0))}
        .settings{display:none;background:linear-gradient(180deg,rgba(255,255,255,.86),rgba(249,252,249,.9));border:1px solid rgba(131,170,146,.16);border-radius:20px;padding:14px;margin-bottom:12px;box-shadow:0 8px 22px rgba(83,112,89,.045),inset 0 1px 0 rgba(255,255,255,.8)}
        .settings.open{display:block}
        .settings-hint{margin:-2px 0 10px 0;color:#789383;font-size:11px;line-height:1.5}
        .vision-tip{margin-bottom:10px;padding:10px 12px;border-radius:14px;background:linear-gradient(180deg,#f2f9f3,#ebf5ee);border:1px solid rgba(119,171,134,.16);color:#4f6d5b;font-size:10px;line-height:1.6}
        .form-grid{display:grid;gap:8px}
        .form-group{display:flex;flex-direction:column;gap:5px}
        .form-group label{color:#789686;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
        .form-group input{background:rgba(255,255,255,.84);border:1px solid rgba(131,170,146,.18);color:#365044;border-radius:14px;padding:11px 12px;font-size:11px;outline:none;width:100%;transition:.18s ease;box-shadow:inset 0 1px 0 rgba(255,255,255,.8)}
        .form-group input::placeholder{color:#9ab0a1}
        .form-group input:focus{border-color:rgba(116,173,133,.45);background:#ffffff;box-shadow:0 0 0 4px rgba(164,212,179,.18)}
        .steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-bottom:12px}
        .step{text-align:center;padding:9px 4px;border-radius:14px;font-size:10px;color:#88a093;background:rgba(255,255,255,.54);border:1px solid rgba(125,164,138,.12);letter-spacing:.04em;box-shadow:inset 0 1px 0 rgba(255,255,255,.6)}
        .step.done{color:#5c7a69;background:rgba(221,239,226,.92)}
        .step.active{color:#295040;border-color:rgba(111,165,127,.22);background:linear-gradient(180deg,#dff1e3,#d5ebdb);box-shadow:0 6px 16px rgba(102,152,129,.1)}
        .meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
        .tag{padding:7px 11px;border-radius:999px;background:rgba(255,255,255,.62);border:1px solid rgba(125,164,138,.12);color:#768d80;font-size:10px;letter-spacing:.03em}
        .tag.on{color:#2f6a45;border-color:rgba(103,182,122,.18);background:#e4f4e8}
        .tag.off{color:#8fa497}
        .btns{display:flex;gap:8px;margin-bottom:12px}
        .btn{flex:1;padding:11px 0;border:none;border-radius:16px;font-size:12px;font-weight:800;letter-spacing:.02em;cursor:pointer;transition:.18s ease}
        .btn:hover{transform:translateY(-1px)}
        .btn-start{background:linear-gradient(180deg,#95caa4,#7fbb93);color:#ffffff;box-shadow:0 8px 18px rgba(116,181,138,.18)}
        .btn-start:hover{filter:brightness(1.02)}
        .btn-stop{background:rgba(255,255,255,.66);color:#90706e;border:1px solid rgba(180,141,141,.16)}
        .btn-stop:hover{background:#fff7f7}
        .log-wrap{display:flex;flex-direction:column;min-height:220px;flex:1}
        .log{flex:1;min-height:180px;max-height:34vh;overflow-y:auto;background:linear-gradient(180deg,rgba(255,255,255,.88),rgba(247,250,247,.96));border-radius:18px;padding:10px;border:1px solid rgba(125,164,138,.1);font-size:10px;line-height:1.6;color:#5b7568;word-wrap:break-word;word-break:break-all;box-shadow:inset 0 1px 0 rgba(255,255,255,.78)}
        .log-item{display:flex;gap:6px;margin-bottom:4px;padding:6px 7px;border-radius:11px;background:rgba(233,242,235,.65)}
        .log-item.err{color:#a45d5d;background:rgba(255,235,235,.88)}
        .log-time{color:#90a497;min-width:52px;flex-shrink:0}
        .log-empty{color:#97aa9e;text-align:center;padding:8px 0}
      </style>
      <div class="wrap" id="wrap">
        <button class="fab" id="fab" type="button" title="展开面板">ZHS</button>
        <div class="panel-shell">
          <div class="header" id="drag-handle">
            <span class="dot" id="run-dot"></span>
            <div class="title-wrap">
              <span class="title">掌握度链路</span>
              <span class="subtitle">Vision AI Control Panel</span>
            </div>
            <button class="icon-btn" id="btn-settings" type="button" title="设置">⚙</button>
            <button class="icon-btn" id="btn-collapse" type="button" title="折叠">−</button>
          </div>
          <div class="panel-body">
            <div class="settings open" id="settings-panel">
              <div class="section-label">AI 配置</div>
              <div class="settings-hint">首次使用请先填入接口地址、密钥和模型名。</div>
              <div class="vision-tip">建议优先使用带视觉能力的模型，例如 <b>qwen-vl-plus</b>。纯文本模型遇到题目图片时更容易失败。</div>
              <div class="form-grid">
                <div class="form-group"><label>API Base URL</label><input id="inp-baseurl" type="text" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></div>
                <div class="form-group"><label>API Key</label><input id="inp-apikey" type="password" placeholder="输入你的 API Key"></div>
                <div class="form-group"><label>Model Name</label><input id="inp-model" type="text" placeholder="推荐：qwen-vl-plus"></div>
                <div class="form-group"><label>掌握度阈值 (%)</label><input id="inp-threshold" type="number" min="0" max="100" placeholder="默认 80"></div>
              </div>
              <div class="btns" style="margin:6px 0 0 0">
                <button class="btn btn-start" id="btn-save-settings" type="button">保存配置</button>
              </div>
            </div>
            <div class="section-label">运行状态</div>
            <div class="steps" id="steps">${CHAIN_STEPS.map((s) => `<div class="step" data-id="${s.id}">${s.label}</div>`).join('')}</div>
            <div class="meta">
              <span class="tag" id="tag-run">已停止</span>
              <span class="tag" id="tag-loop">循环关</span>
              <span class="tag" id="tag-screen">当前：—</span>
              <span class="tag" id="tag-api" title="当前 API 配置">API：—</span>
            </div>
            <div class="btns">
              <button class="btn btn-start" id="btn-start" type="button">开始/继续</button>
              <button class="btn btn-stop" id="btn-stop" type="button">停止</button>
            </div>
            <div class="log-wrap">
              <div class="section-label">运行日志</div>
              <div class="log" id="log"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const wrap = shadow.getElementById('wrap');
    const fab = shadow.getElementById('fab');
    const dragHandle = shadow.getElementById('drag-handle');
    const stepsEl = shadow.getElementById('steps');
    const runDot = shadow.getElementById('run-dot');
    const tagRun = shadow.getElementById('tag-run');
    const tagLoop = shadow.getElementById('tag-loop');
    const tagScreen = shadow.getElementById('tag-screen');
    const tagApi = shadow.getElementById('tag-api');
    const logEl = shadow.getElementById('log');
    const btnStart = shadow.getElementById('btn-start');
    const btnStop = shadow.getElementById('btn-stop');
    const btnCollapse = shadow.getElementById('btn-collapse');
    const btnSettings = shadow.getElementById('btn-settings');
    const settingsPanel = shadow.getElementById('settings-panel');
    const inpBaseUrl = shadow.getElementById('inp-baseurl');
    const inpApiKey = shadow.getElementById('inp-apikey');
    const inpModel = shadow.getElementById('inp-model');
    const inpThreshold = shadow.getElementById('inp-threshold');
    const btnSaveSettings = shadow.getElementById('btn-save-settings');

    const logs = [];
    let running = false;
    let currentScreen = SCREENS.UNKNOWN;

    const fmtTime = () => {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    };

    const renderLogs = () => {
      logEl.innerHTML = logs.length
        ? logs
          .map(
            (l) =>
              `<div class="log-item${l.err ? ' err' : ''}"><span class="log-time">${l.t}</span><span>${l.m}</span></div>`,
          )
          .join('')
        : '<div class="log-empty">等待任务开始…</div>';
      logEl.scrollTop = logEl.scrollHeight;
    };

    const addLog = (msg, err = false) => {
      logs.push({ t: fmtTime(), m: msg, err });
      if (logs.length > 30) logs.shift();
      renderLogs();
    };

    const applyPos = (offsetX = 0) => {
      wrap.style.right = `${offsetX}px`;
      wrap.style.top = '0';
      wrap.style.left = 'auto';
      wrap.style.bottom = 'auto';
      wrap.style.height = '100vh';
      wrap.style.width = '28vw';
    };

    const savePos = (offsetX) => {
      GM_setValue(PANEL_POS_KEY, { x: Math.round(offsetX) });
    };

    const setCollapsed = (collapsed) => {
      wrap.classList.toggle('collapsed', collapsed);
      GM_setValue(PANEL_COLLAPSED_KEY, collapsed);
    };

    const updateSteps = (screen) => {
      const idx = CHAIN_STEPS.findIndex((s) => s.id === screen);
      stepsEl.querySelectorAll('.step').forEach((el, i) => {
        el.classList.remove('active', 'done');
        if (idx < 0) return;
        if (i < idx) el.classList.add('done');
        else if (i === idx) el.classList.add('active');
      });
    };

    const loadSettingsInputs = () => {
      inpBaseUrl.value = GM_getValue('zhs_api_baseurl', '');
      inpApiKey.value = GM_getValue('zhs_api_apikey', '');
      inpModel.value = GM_getValue('zhs_api_model', '');
      inpThreshold.value = GM_getValue(THRESHOLD_KEY, 80);
    };

    const refreshApiStatus = () => {
      const cfg = getApiCfg();
      const modelLabel = cfg.model ? cfg.model.split('-')[0] : '未配置';
      const baseUrlShort = cfg.baseUrl ? cfg.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : '未配置';
      const keyLabel = cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}...` : '未配置';
      tagApi.textContent = `API:${modelLabel}`;
      tagApi.title = `BaseURL: ${baseUrlShort}\nKey: ${keyLabel}`;
    };

    const refreshStatus = () => {
      const loop = isLoopOn();
      running = !!unsafeWindow.__ZHS_CHAIN_RUNNING;
      runDot.classList.toggle('running', running);
      tagRun.textContent = running ? '运行中' : '已停止';
      tagRun.className = `tag ${running ? 'on' : 'off'}`;
      tagLoop.textContent = loop ? '循环开' : '循环关';
      tagLoop.className = `tag ${loop ? 'on' : 'off'}`;
      tagScreen.textContent = `当前：${SCREEN_LABELS[currentScreen] || currentScreen}`;
      refreshApiStatus();
      updateSteps(currentScreen);
    };

    const handle = (event, detail) => {
      switch (event) {
        case 'init':
          addLog('待命，点击「开始/继续」启动');
          refreshStatus();
          break;
        case 'start':
          addLog('已开始');
          refreshStatus();
          break;
        case 'stop':
          addLog('已停止');
          refreshStatus();
          break;
        case 'screen':
          if (detail) currentScreen = detail;
          refreshStatus();
          break;
        case 'hop':
          if (detail?.action) addLog(`${SCREEN_LABELS[detail.screen] || detail.screen} → ${detail.action}`);
          else if (detail?.screen)
            addLog(`${SCREEN_LABELS[detail.screen] || detail.screen} → ${hopActionLabel(detail.screen, detail.expectDetailForward)}`);
          refreshStatus();
          break;
        case 'quiz':
          if (detail?.phase === 'start') addLog('AI 答题中…');
          else if (detail?.phase === 'done') addLog(`AI 答题完成 | ${detail.aiOutput || ''}`);
          break;
        case 'error':
          addLog(detail || '发生错误', true);
          refreshStatus();
          break;
        case 'done':
          addLog('本轮结束');
          refreshStatus();
          break;
        default:
          break;
      }
    };

    const setupDrag = (handleEl, onTap) => {
      handleEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const saved = GM_getValue(PANEL_POS_KEY, { x: 0 });
        const startOffsetX = typeof saved?.x === 'number' ? saved.x : 0;
        let moved = false;

        const onMove = (ev) => {
          const deltaX = startX - ev.clientX;
          if (Math.abs(deltaX) > 3) moved = true;
          const maxOffset = Math.max(window.innerWidth - 72, 0);
          const nextOffset = Math.min(Math.max(startOffsetX + deltaX, 0), maxOffset);
          applyPos(nextOffset);
        };

        const onUp = (ev) => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const deltaX = startX - ev.clientX;
          const maxOffset = Math.max(window.innerWidth - 72, 0);
          const nextOffset = Math.min(Math.max(startOffsetX + deltaX, 0), maxOffset);
          savePos(nextOffset);
          if (!moved && onTap) onTap();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    };

    const savedPos = GM_getValue(PANEL_POS_KEY, { x: 0 });
    applyPos(typeof savedPos?.x === 'number' ? savedPos.x : 0);
    setCollapsed(GM_getValue(PANEL_COLLAPSED_KEY, false));

    setupDrag(dragHandle);
    setupDrag(fab, () => setCollapsed(false));
    loadSettingsInputs();

    btnStart.addEventListener('click', () => handlers.onStart());
    btnStop.addEventListener('click', () => handlers.onStop());
    btnCollapse.addEventListener('click', () => setCollapsed(true));

    btnSettings.addEventListener('click', () => {
      const isOpen = settingsPanel.classList.toggle('open');
      if (isOpen) loadSettingsInputs();
    });

    btnSaveSettings.addEventListener('click', () => {
      GM_setValue('zhs_api_baseurl', inpBaseUrl.value.trim());
      GM_setValue('zhs_api_apikey', inpApiKey.value.trim());
      GM_setValue('zhs_api_model', inpModel.value.trim());
      const threshold = parseInt(inpThreshold.value, 10);
      if (!Number.isNaN(threshold) && threshold >= 0 && threshold <= 100) {
        GM_setValue(THRESHOLD_KEY, threshold);
      }
      settingsPanel.classList.remove('open');
      addLog('API 配置已保存');
      refreshApiStatus();
    });

    return { handle, refreshStatus, setScreen: (s) => { currentScreen = s; refreshStatus(); } };
  };

  async function runFromHere() {
    if (unsafeWindow.__ZHS_CHAIN_RUNNING) return;
    unsafeWindow.__ZHS_CHAIN_RUNNING = true;
    panelNotify('start');
    try {
      let hops = 0;
      // false = DETAIL 上应点返回（首次进入 / RESULT 退出链落点）；true = 从 LIST 点进，应点「去提升」
      let expectDetailForward = false;

      while (hops < MAX_HOPS && isLoopOn() && !unsafeWindow.__ZHS_STOP) {
        hops += 1;

        let screen = detectScreen();
        if (screen === SCREENS.UNKNOWN) {
          const found = await waitFor(() => (detectScreen() !== SCREENS.UNKNOWN ? true : null), 15000);
          if (!found) {
            panelNotify('error', '未识别页面，停止');
            break;
          }
          screen = detectScreen();
          if (screen === SCREENS.UNKNOWN) {
            panelNotify('error', '未识别页面，停止');
            break;
          }
        }

        panelNotify('screen', screen);

        const progressed = await runOneHop(screen, expectDetailForward);
        if (!progressed) {
          panelNotify('error', `${SCREEN_LABELS[screen] || screen}：本步未推进`);
          break;
        }

        panelNotify('hop', { screen, expectDetailForward });

        if (screen === SCREENS.LIST && progressed) expectDetailForward = true;
        if (screen === SCREENS.DETAIL && expectDetailForward && progressed) expectDetailForward = false;

        await sleep(ROUTE_SETTLE_MS);

        if (detectScreen() === SCREENS.LIST && !hasListWork()) {
          setLoopKey(false);
          panelNotify('hop', { screen: SCREENS.LIST, action: '无待刷题目，关闭循环' });
          break;
        }
      }
    } finally {
      unsafeWindow.__ZHS_CHAIN_RUNNING = false;
      panelNotify('done');
    }
  }

  function startChain() {
    unsafeWindow.__ZHS_STOP = false;
    setLoopKey(true);
    runFromHere();
  }

  function stopChain() {
    unsafeWindow.__ZHS_STOP = true;
    setLoopKey(false);
    panelNotify('stop');
  }

  GM_registerMenuCommand('最小链路：开始/继续', startChain);
  GM_registerMenuCommand('最小链路：停止', stopChain);
  GM_registerMenuCommand('设置 API 配置', () => {
    const url = prompt('输入 API Base URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）:', GM_getValue('zhs_api_baseurl', ''));
    if (url !== null) GM_setValue('zhs_api_baseurl', url.trim());
    const key = prompt('输入 API Key:', GM_getValue('zhs_api_apikey', ''));
    if (key !== null) GM_setValue('zhs_api_apikey', key.trim());
    const model = prompt('输入 Model Name（如 qwen-vl-plus,qwen3.6-flash-2026-04-16）:', GM_getValue('zhs_api_model', ''));
    if (model !== null) GM_setValue('zhs_api_model', model.trim());
  });

  panelCtx = createPanel({ onStart: startChain, onStop: stopChain });
  panelNotify('init');
  panelNotify('screen', detectScreen());

  const idleRefreshTimer = setInterval(() => {
    if (!unsafeWindow.__ZHS_CHAIN_RUNNING) {
      panelNotify('screen', detectScreen());
    }
  }, 2000);
  window.addEventListener('beforeunload', () => clearInterval(idleRefreshTimer));

  waitFor(() => (detectScreen() !== SCREENS.UNKNOWN ? true : null), 15000).then(() => {
    if (isLoopOn() && !unsafeWindow.__ZHS_STOP) runFromHere();
  });
})();

