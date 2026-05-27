// ==UserScript==
// @name         智慧树掌握度-最小链路(自动续跑-狂点轰炸版)
// @namespace    https://github.com/local/zhihuishu-min-chain
// @version      1.3.0
// @description  入口→答题(AI)→提交返回；刷新后自动续跑。采用“轮询点击直到元素消失”的强力驱动策略。
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

  const STATE_KEY = 'zhs_chain_state';
  const LOOP_KEY = 'zhs_loop';
  const STEPS = { IDLE: 'idle', QUIZ: 'quiz', EXIT: 'exit' };

  // OpenAI 兼容 API 配置
  const API_CFG = {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-2e409f80effa4e86a58ae8a03908cae9',
    model: 'qwen3.6-flash-2026-04-16',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getState = () => GM_getValue(STATE_KEY, { step: STEPS.IDLE });
  const setState = (step) => GM_setValue(STATE_KEY, { step, at: Date.now() });

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

  const callAI = (content) =>
    new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_CFG.baseUrl.replace(/\/$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_CFG.apiKey}`,
        },
        data: JSON.stringify({
          model: API_CFG.model,
          messages: [{ role: 'user', content }],
          temperature: 0.2,
        }),
        onload: (res) => {
          const data = JSON.parse(res.responseText);
          resolve(data.choices[0].message.content.trim());
        },
      });
    });

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

  const answerWithAI = async (blocks) => {
    const opts = [...document.querySelectorAll('ul.radio-view li')];
    if (!opts.length) return;

    const optLines = opts.map((li, i) => `${String.fromCharCode(65 + i)}. ${li.innerText.trim()}`);
    const content = [
      {
        type: 'text',
        text: `请逐步用平文本思考并选出正确答案的选项。最后一行必须以“答案：X”的格式输出，x只能为一个字母，即正确的选项。题目：\n\n${blocksToMarkdown(blocks)}\n\n选项：\n${optLines.join('\n')}`,
      },
    ];
    blocks
      .filter((b) => b.type === 'image')
      .forEach((b) => content.push({ type: 'image_url', image_url: { url: b.src } }));
    // console.log('user:' ,content.toString());

    const raw = await callAI(content);
    const match = raw.match(/答案：([A-Z])/i);
    debugger;
    const letter = match ? match[1].toUpperCase() : '';
    const idx = letter.charCodeAt(0) - 65;
    // console.log('AI:', raw);

    const targetOpt = opts[idx];
    if (targetOpt) {
      const oldClass = targetOpt.className;
      // 选项本身不会消失，但我们可以狂点它，直到它的类名（样式）发生改变，意味着框架成功接收了点击
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

  async function runEntry() {
    // 1. 点击掌握度不足80%的题目，直到该目标在页面上消失
    await clickUntilGone(() => {
      const progresses = document.querySelectorAll('.el-progress--dashboard');
      for (const el of progresses) {
        const pct = parseInt(el.innerText.replace(/\D/g, ''), 10);
        if (!Number.isNaN(pct) && pct < 80) return el;
      }
      return null;
    });
    // 2.进入题目，点击去提升
    await clickUntilGone('.simplified-mastery__action');

    setState(STEPS.QUIZ);

    // 3. 狂点“提升/开始”按钮，直到它消失
    await clickUntilGone('.improve-btn');
  }

  async function runQuiz() {
    for (let i = 0; i < 50; i++) {
      if (unsafeWindow.__ZHS_STOP) break;

      // 答题前，确保题目容器和选项文本被 JS 异步渲染出来
      const isReady = await waitFor(() => {
        const q = document.querySelector('.questionContent');
        const opts = document.querySelectorAll('ul.radio-view li');
        return q && q.innerText.trim() && opts.length > 0 && opts[0].innerText.trim() ? q : null;
      });
      if (!isReady) return;

      const oldText = isReady.innerText; // 备份当前题目的文本用于防错比对
      const blocks = readQuestion();

      await answerWithAI(blocks);

      // 核心重构：轮询点击未完成的题目
      const hasMismatch = getMismatchNode();
      if (hasMismatch) {
        await clickUntilGone(() => {
          const currentQ = document.querySelector('.questionContent');
          // 如果题目文本已经变了，说明已经成功切到下一题，立即停止轰炸
          if (!currentQ || currentQ.innerText !== oldText) return null;
          return getMismatchNode();
        });
        continue; // 继续下一轮答题
      } else {
        // 如果已经没有不匹配的项了，说明全部完成，准备退出
        setState(STEPS.EXIT);
        break;
      }
    }

    if (getState().step === STEPS.EXIT) await runExit();
  }

  async function runExitBackOnly() {
    // 成绩页面退出按钮
    await clickUntilGone('.backup-icon');
    // 退回选择知识点，书掌握度页面
    await clickUntilGone('[class*="w-[32px]"][class*="h-[32px]"].cursor-pointer');
  }

  async function continueLoopIfEnabled() {
    if (!GM_getValue(LOOP_KEY, false) || unsafeWindow.__ZHS_STOP) return;
    await tryContinueLoop();
  }

  async function tryContinueLoop() {
    if (!GM_getValue(LOOP_KEY, false) || unsafeWindow.__ZHS_STOP) return;

    // 等待面板重新加载并带有数据
    const hasDashboard = await waitFor(() => {
      const el = document.querySelector('.el-progress--dashboard');
      return el && /\d+/.test(el.innerText);
    }, 30000);
    if (!hasDashboard) return;

    let hasWork = false;
    for (const el of document.querySelectorAll('.el-progress--dashboard')) {
      const pct = parseInt(el.innerText.replace(/\D/g, ''), 10);
      if (!Number.isNaN(pct) && pct < 80) {
        hasWork = true;
        break;
      }
    }
    if (!hasWork) {
      GM_setValue(LOOP_KEY, false);
      return;
    }

    await runEntry();
  }

  async function runExit() {
    // 狂点“完成查看”按钮直到它消失
    await clickUntilGone('.reviewDone.ZHIHUISHU_QZMD');//提交作业按钮
    await runExitBackOnly();
    setState(STEPS.IDLE);
    await continueLoopIfEnabled();
  }

  async function runByState() {
    if (unsafeWindow.__ZHS_CHAIN_RUNNING) return;
    unsafeWindow.__ZHS_CHAIN_RUNNING = true;
    try {
      const { step } = getState();
      if (step === STEPS.QUIZ) {
        await runQuiz();
        return;
      }
      if (step === STEPS.EXIT) {
        await runExit();
        return;
      }

      if (step === STEPS.IDLE && GM_getValue(LOOP_KEY, false)) {
        await tryContinueLoop();
      }
    } finally {
      unsafeWindow.__ZHS_CHAIN_RUNNING = false;
    }
  }

  function startChain() {
    unsafeWindow.__ZHS_STOP = false;
    GM_setValue(LOOP_KEY, true);
    runEntry();
  }

  function startFromExitAndLoop() {
    unsafeWindow.__ZHS_STOP = false;
    GM_setValue(LOOP_KEY, true);
    setState(STEPS.IDLE);
    runExitBackOnly().then(() => continueLoopIfEnabled());
  }

  function continueQuizOnPage() {
    unsafeWindow.__ZHS_STOP = false;
    GM_setValue(LOOP_KEY, true);
    setState(STEPS.QUIZ);
    runQuiz();
  }

  function stopChain() {
    unsafeWindow.__ZHS_STOP = true;
    GM_setValue(LOOP_KEY, false);
    setState(STEPS.IDLE);
  }

  GM_registerMenuCommand('最小链路：开始', startChain);
  GM_registerMenuCommand('最小链路：题目中继续循环', continueQuizOnPage);
  GM_registerMenuCommand('最小链路：从答题完成退出并循环', startFromExitAndLoop);
  GM_registerMenuCommand('最小链路：停止并重置', stopChain);

  // 动态感知破冰启动：一有数据节点满足，立刻唤醒
  waitFor(() => {
    const dashboard = document.querySelector('.el-progress--dashboard');
    const quiz = document.querySelector('.questionContent');
    return (dashboard && /\d+/.test(dashboard.innerText)) || (quiz && quiz.innerText.trim());
  }, 15000).then(runByState);
})();
