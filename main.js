// ==UserScript==
// @name         智慧树掌握度-最小链路(自动续跑-狂点轰炸版)
// @namespace    https://github.com/local/zhihuishu-min-chain
// @version      1.5.1
// @description  DOM 探测屏状态，任意界面可续跑；答题+提交合一。仅菜单点击后执行，不自动启动。
// @match        https://ai-smart-course-student-pro.zhihuishu.com/*
// @match        https://smartcoursestudent.zhihuishu.com/*
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

  // OpenAI 兼容 API 配置
  const API_CFG = {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-2e409f80effa4e86a58ae8a03908cae9',
    model: 'qwen3.6-flash-2026-04-16',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isLoopOn = () => GM_getValue(LOOP_KEY, false);

  const parsePct = (el) => parseInt((el?.innerText || '').replace(/\D/g, ''), 10);

  const findLowPctProgress = () => {
    for (const el of document.querySelectorAll('.el-progress--dashboard')) {
      const pct = parsePct(el);
      if (!Number.isNaN(pct) && pct < 80) return el;
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
    const letter = parseAnswerLetter(raw);
    if (!letter) return false;
    const idx = letter.charCodeAt(0) - 65;
    return idx >= 0 && idx < optionCount;
  };

  const callAIOnce = (messages) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_CFG.baseUrl.replace(/\/$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_CFG.apiKey}`,
        },
        data: JSON.stringify({
          model: API_CFG.model,
          messages,
          temperature: 0.2,
        }),
        timeout: AI_CHAT.timeoutMs,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(`AI HTTP ${res.status}`));
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
  const clickUntilGone = async (selectorOrFn, timeout = 15000, step = 100) => {
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

  const getQuestionBlocks = (root) => {
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

    const walk = (node) => {
      if (node.nodeType === 3) {
        pushText(node.textContent);
        return;
      }
      if (node.nodeType !== 1) return;
      if (/^(SCRIPT|STYLE)$/i.test(node.tagName)) return;
      if (node.classList?.contains('upload')) return;
      if (node.tagName === 'IMG') {
        imgIndex += 1;
        blocks.push({
          type: 'image',
          index: imgIndex,
          src: node.src || '',
          alt: node.alt || '',
        });
        return;
      }
      if (node.tagName === 'BR') {
        pushText('\n');
        return;
      }
      for (const child of node.childNodes) walk(child);
    };

    walk(root);
    return blocks;
  };

  const blocksToMarkdown = (blocks) =>
    blocks.map((b) => (b.type === 'text' ? b.content : `[IMAGE:${b.index}]`)).join('\n');

  const readQuestion = () => {
    const root = document.querySelector('.questionContent');
    const blocks = getQuestionBlocks(root);
    unsafeWindow.__questionBlocks = blocks;
    const md = blocksToMarkdown(blocks);
    // if (md) console.log(md);
    // blocks.filter((b) => b.type === 'image').forEach((b) => console.log(b.src));
    return blocks;
  };

  const buildQuizMessages = (blocks, optLines, attempt, chatState) => {
    let prompt = `请逐步用平文本思考并选出正确答案的选项。最后一行必须以“答案：X”的格式输出，X 只能为单个字母（对应正确选项）。题目：\n\n${blocksToMarkdown(blocks)}\n\n选项：\n${optLines.join('\n')}`;

    if (attempt > 1 && chatState.lastRaw) {
      prompt += `\n\n【重试】你上次回答不合规（需以“答案：X”结尾且 X 为有效选项字母）。请重新作答。上次回答：\n${chatState.lastRaw}`;
    } else if (attempt > 1 && chatState.lastError) {
      prompt = `请逐步用平文本思考并选出正确答案的选项。最后一行必须以“答案：X”的格式输出，X 只能为单个字母（对应正确选项）。题目：\n\n${blocksToMarkdown(blocks)}\n\n选项：\n${optLines.join('\n')}`;
    }

    const content = [{ type: 'text', text: prompt }];
    blocks
      .filter((b) => b.type === 'image')
      .forEach((b) => content.push({ type: 'image_url', image_url: { url: b.src } }));
    return [{ role: 'user', content }];
  };

  const answerWithAI = async (blocks) => {
    const opts = [...document.querySelectorAll('ul.radio-view li')];
    if (!opts.length) return;

    const optLines = opts.map((li, i) => `${String.fromCharCode(65 + i)}. ${li.innerText.trim()}`);
    const { raw } = await requestAI(
      (attempt, chatState) => buildQuizMessages(blocks, optLines, attempt, chatState),
      (raw) => isValidQuizAnswer(raw, opts.length),
    );

    const letter = parseAnswerLetter(raw);
    const idx = letter.charCodeAt(0) - 65;
    const targetOpt = opts[idx];
    if (targetOpt) {
      const oldClass = targetOpt.className;
      await clickUntilGone(() => {
        return targetOpt.className === oldClass ? targetOpt : null;
      }, 3000, 100);
    }
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
      GM_setValue(LOOP_KEY, false);
      return false;
    }

    // 点击掌握度不足 80% 的题目，直到该目标在页面上消失
    return clickUntilGone(() => findLowPctProgress());
  }

  async function runDetailHop() {
    // 从 LIST 点进 DETAIL 后：进入题目，点击「去提升」
    return clickUntilGone('.simplified-mastery__action');
  }

  async function runDetailExitHop() {
    // DETAIL 退回 LIST：脚本首次进入、或 RESULT 退出链落点（小箭头实际路由仍到 DETAIL 的上一级）
    return clickUntilGone(NAV_BACK_SEL);
  }

  async function runPreQuizHop() {
    // 狂点「提升 / 开始」按钮，直到它消失
    return clickUntilGone('.improve-btn');
  }

  /** QUIZ = 答题 + 提交（同一屏）；是否提交由 getMismatchNode 判断，不用 reviewDone 是否存在 */
  async function runQuizHop() {
    // 确保题目容器和选项文本被 JS 异步渲染出来
    const isReady = await waitFor(() => {
      const q = document.querySelector('.questionContent');
      const opts = document.querySelectorAll('ul.radio-view li');
      return q && q.innerText.trim() && opts.length > 0 && opts[0].innerText.trim() ? q : null;
    }, 30000);
    if (!isReady) return false;

    const oldText = isReady.innerText; // 备份当前题目文本，用于防错比对
    try {
      await answerWithAI(readQuestion());
    } catch {
      return false;
    }

    // 侧栏还有未答题 → 切下一题（不能提交）
    if (getMismatchNode()) {
      return clickUntilGone(() => {
        const currentQ = document.querySelector('.questionContent');
        if (!currentQ || currentQ.innerText !== oldText) return null;
        return getMismatchNode();
      });
    }

    // 侧栏无未答题 → 提交（reviewDone 可能一直存在，仅作点击目标）
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

  async function runFromHere() {
    if (unsafeWindow.__ZHS_CHAIN_RUNNING) return;
    unsafeWindow.__ZHS_CHAIN_RUNNING = true;
    try {
      let hops = 0;
      // false = DETAIL 上应点返回（首次进入 / RESULT 退出链落点）；true = 从 LIST 点进，应点「去提升」
      let expectDetailForward = false;

      while (hops < MAX_HOPS && isLoopOn() && !unsafeWindow.__ZHS_STOP) {
        hops += 1;

        let screen = detectScreen();
        if (screen === SCREENS.UNKNOWN) {
          const found = await waitFor(() => (detectScreen() !== SCREENS.UNKNOWN ? true : null), 15000);
          if (!found) break;
          screen = detectScreen();
          if (screen === SCREENS.UNKNOWN) break;
        }

        const progressed = await runOneHop(screen, expectDetailForward);
        if (!progressed) break;

        if (screen === SCREENS.LIST && progressed) expectDetailForward = true;
        if (screen === SCREENS.DETAIL && expectDetailForward && progressed) expectDetailForward = false;

        await sleep(ROUTE_SETTLE_MS);

        if (detectScreen() === SCREENS.LIST && !hasListWork()) {
          GM_setValue(LOOP_KEY, false);
          break;
        }
      }
    } finally {
      unsafeWindow.__ZHS_CHAIN_RUNNING = false;
    }
  }

  function startChain() {
    unsafeWindow.__ZHS_STOP = false;
    GM_setValue(LOOP_KEY, true);
    runFromHere();
  }

  function stopChain() {
    unsafeWindow.__ZHS_STOP = true;
    GM_setValue(LOOP_KEY, false);
  }

  GM_registerMenuCommand('最小链路：开始/继续', startChain);
  GM_registerMenuCommand('最小链路：停止', stopChain);
})();
