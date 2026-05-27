// ==UserScript==
// @name         智慧树掌握度-最小链路(自动续跑-狂点轰炸版)
// @namespace    https://github.com/local/zhihuishu-min-chain
// @version      1.6.0
// @description  DOM 探测屏状态 + 页内控制面板；任意界面可续跑，仅手动开始后执行。
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
  const PANEL_POS_KEY = 'zhs_panel_pos';
  const PANEL_COLLAPSED_KEY = 'zhs_panel_collapsed';
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
    baseUrl: GM_getValue('zhs_api_baseurl', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    apiKey: GM_getValue('zhs_api_apikey', 'sk-295db598b44e48d78e16633cf99a1d1e'),
    model: GM_getValue('zhs_api_model', 'qwen3.6-35b-a3b'),
  });

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
        const w = node.naturalWidth || node.width || 0;
        const h = node.naturalHeight || node.height || 0;
        if (w > 10 && h > 10) {
          imgIndex += 1;
          blocks.push({
            type: 'image',
            index: imgIndex,
            src: node.src || '',
            alt: node.alt || '',
          });
        }
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
    panelNotify('quiz', { phase: 'start' });
    try {
      await answerWithAI(readQuestion());
      panelNotify('quiz', { phase: 'done' });
    } catch (e) {
      panelNotify('error', e?.message || 'AI 答题失败');
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

    panelNotify('hop', { screen: SCREENS.QUIZ, action: '提交作业' });
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
        *{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif}
        .wrap{position:fixed;width:280px;background:rgba(18,18,22,.94);color:#e8e8ec;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.45);font-size:12px;overflow:hidden;user-select:none}
        .wrap.collapsed{width:auto;background:transparent;border:none;box-shadow:none}
        .fab{display:none;width:44px;height:44px;border-radius:50%;background:rgba(18,18,22,.94);border:1px solid rgba(255,255,255,.2);color:#7dd3fc;font-weight:700;font-size:11px;cursor:pointer;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
        .wrap.collapsed .fab{display:flex}
        .wrap.collapsed .panel{display:none}
        .header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.06);cursor:move;border-bottom:1px solid rgba(255,255,255,.08)}
        .dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex-shrink:0}
        .dot.running{background:#4ade80;animation:zhs-pulse 1.2s ease infinite}
        @keyframes zhs-pulse{0%,100%{opacity:1}50%{opacity:.35}}
        .title{flex:1;font-weight:600;font-size:13px}
        .icon-btn{background:none;border:none;color:#9ca3af;cursor:pointer;padding:2px 6px;border-radius:4px;font-size:14px;line-height:1}
        .icon-btn:hover{color:#fff;background:rgba(255,255,255,.1)}
        .panel{padding:10px}
        .steps{display:flex;gap:2px;margin-bottom:8px}
        .step{flex:1;text-align:center;padding:4px 2px;border-radius:4px;font-size:10px;color:#6b7280;background:rgba(255,255,255,.04);border:1px solid transparent}
        .step.done{color:#9ca3af;background:rgba(255,255,255,.06)}
        .step.active{color:#7dd3fc;border-color:#38bdf8;background:rgba(56,189,248,.12);font-weight:600}
        .meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;color:#9ca3af;font-size:11px}
        .tag{padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.06)}
        .tag.on{color:#4ade80}.tag.off{color:#6b7280}
        .btns{display:flex;gap:6px;margin-bottom:8px}
        .btn{flex:1;padding:6px 0;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer}
        .btn-start{background:#2563eb;color:#fff}.btn-start:hover{background:#1d4ed8}
        .btn-stop{background:rgba(255,255,255,.08);color:#fca5a5;border:1px solid rgba(252,165,165,.3)}.btn-stop:hover{background:rgba(252,165,165,.15)}
        .log{max-height:100px;overflow-y:auto;background:rgba(0,0,0,.25);border-radius:6px;padding:6px;font-size:10px;line-height:1.5;color:#9ca3af;word-wrap:break-word;word-break:break-all}
        .log-item{margin-bottom:2px}.log-item.err{color:#f87171}
        .log-time{color:#6b7280;margin-right:4px;flex-shrink:0}
        .settings{display:none;background:rgba(0,0,0,.2);border-radius:6px;padding:8px;margin-bottom:8px}
        .settings.open{display:block}
        .form-group{margin-bottom:6px;display:flex;flex-direction:column;gap:4px}
        .form-group label{color:#9ca3af;font-size:10px}
        .form-group input{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.15);color:#e8e8ec;border-radius:4px;padding:4px 6px;font-size:11px;outline:none;width:100%}
        .form-group input:focus{border-color:#38bdf8}
      </style>
      <div class="wrap" id="wrap">
        <button class="fab" id="fab" type="button" title="展开面板">ZHS</button>
        <div class="panel">
          <div class="header" id="drag-handle">
            <span class="dot" id="run-dot"></span>
            <span class="title">掌握度链路</span>
            <button class="icon-btn" id="btn-settings" type="button" title="设置">⚙</button>
            <button class="icon-btn" id="btn-collapse" type="button" title="折叠">−</button>
          </div>
          <div class="panel" style="padding:10px">
            <div class="settings" id="settings-panel">
              <div class="form-group"><label>API Base URL</label><input id="inp-baseurl" type="text"></div>
              <div class="form-group"><label>API Key</label><input id="inp-apikey" type="password"></div>
              <div class="form-group"><label>Model Name</label><input id="inp-model" type="text"></div>
              <div class="btns" style="margin:6px 0 0 0">
                <button class="btn btn-start" id="btn-save-settings" type="button">保存配置</button>
              </div>
            </div>
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
            <div class="log" id="log"></div>
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
    const btnSaveSettings = shadow.getElementById('btn-save-settings');

    const logs = [];
    let running = false;
    let currentScreen = SCREENS.UNKNOWN;

    const fmtTime = () => {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    };

    const renderLogs = () => {
      logEl.innerHTML = logs
        .map(
          (l) =>
            `<div class="log-item${l.err ? ' err' : ''}"><span class="log-time">${l.t}</span>${l.m}</div>`,
        )
        .join('');
      logEl.scrollTop = logEl.scrollHeight;
    };

    const addLog = (msg, err = false) => {
      logs.push({ t: fmtTime(), m: msg, err });
      if (logs.length > 30) logs.shift();
      renderLogs();
    };

    const applyPos = (pos) => {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        wrap.style.left = `${pos.x}px`;
        wrap.style.top = `${pos.y}px`;
        wrap.style.right = 'auto';
        wrap.style.bottom = 'auto';
      } else {
        wrap.style.right = '16px';
        wrap.style.bottom = '16px';
        wrap.style.left = 'auto';
        wrap.style.top = 'auto';
      }
    };

    const savePos = () => {
      const rect = wrap.getBoundingClientRect();
      GM_setValue(PANEL_POS_KEY, { x: Math.round(rect.left), y: Math.round(rect.top) });
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

    const refreshApiStatus = () => {
      const cfg = getApiCfg();
      const baseUrlShort = cfg.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      tagApi.textContent = `API:${cfg.model.split('-')[0]}`;
      tagApi.title = `BaseURL: ${baseUrlShort}\nKey: ${cfg.apiKey.slice(0, 8)}...`;
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
          else if (detail?.phase === 'done') addLog('AI 答题完成');
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
        const rect = wrap.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const startX = e.clientX;
        const startY = e.clientY;
        let dragged = false;
        wrap.style.right = 'auto';
        wrap.style.bottom = 'auto';

        const onMove = (ev) => {
          if (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4) dragged = true;
          wrap.style.left = `${ev.clientX - offsetX}px`;
          wrap.style.top = `${ev.clientY - offsetY}px`;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          savePos();
          if (onTap && !dragged) onTap();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    };

    applyPos(GM_getValue(PANEL_POS_KEY, null));
    setCollapsed(GM_getValue(PANEL_COLLAPSED_KEY, false));

    setupDrag(dragHandle);
    setupDrag(fab, () => setCollapsed(false));

    btnStart.addEventListener('click', () => handlers.onStart());
    btnStop.addEventListener('click', () => handlers.onStop());
    btnCollapse.addEventListener('click', () => setCollapsed(true));

    btnSettings.addEventListener('click', () => {
      const isOpen = settingsPanel.classList.toggle('open');
      if (isOpen) {
        inpBaseUrl.value = GM_getValue('zhs_api_baseurl', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
        inpApiKey.value = GM_getValue('zhs_api_apikey', 'sk-2e409f80effa4e86a58ae8a03908cae9');
        inpModel.value = GM_getValue('zhs_api_model', 'qwen3.6-flash-2026-04-16');
      }
    });

    btnSaveSettings.addEventListener('click', () => {
      GM_setValue('zhs_api_baseurl', inpBaseUrl.value.trim());
      GM_setValue('zhs_api_apikey', inpApiKey.value.trim());
      GM_setValue('zhs_api_model', inpModel.value.trim());
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
          GM_setValue(LOOP_KEY, false);
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
    GM_setValue(LOOP_KEY, true);
    runFromHere();
  }

  function stopChain() {
    unsafeWindow.__ZHS_STOP = true;
    GM_setValue(LOOP_KEY, false);
    panelNotify('stop');
  }

  GM_registerMenuCommand('最小链路：开始/继续', startChain);
  GM_registerMenuCommand('最小链路：停止', stopChain);
  GM_registerMenuCommand('设置 API 配置', () => {
    const url = prompt('输入 API Base URL:', GM_getValue('zhs_api_baseurl', 'https://dashscope.aliyuncs.com/compatible-mode/v1'));
    if (url !== null) GM_setValue('zhs_api_baseurl', url.trim());
    const key = prompt('输入 API Key:', GM_getValue('zhs_api_apikey', 'sk-2e409f80effa4e86a58ae8a03908cae9'));
    if (key !== null) GM_setValue('zhs_api_apikey', key.trim());
    const model = prompt('输入 Model Name:', GM_getValue('zhs_api_model', 'qwen3.6-flash-2026-04-16'));
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
})();
