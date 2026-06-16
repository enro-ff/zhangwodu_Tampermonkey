// ==UserScript==
// @name         智慧树掌握度-最小链路(自动续跑-狂点轰炸版)
// @namespace    https://github.com/local/zhihuishu-min-chain
// @version      1.0.0
// @description  DOM 探测屏状态 + 页内控制面板；支持自定义 AI API（需使用有视觉能力的模型）；任意界面可续跑，仅手动开始后执行。
// @match        https://ai-smart-course-student-pro.zhihuishu.com/*
// @match        https://studentexamcomh5.zhihuishu.com/*
// @match        https://examloop.zhihuishu.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  // src/constants.js
  var LOOP_KEY = "zhs_loop";
  var PANEL_POS_KEY = "zhs_panel_pos";
  var PANEL_COLLAPSED_KEY = "zhs_panel_collapsed";
  var THRESHOLD_KEY = "zhs_threshold";
  var RETRY_KEY_PREFIX = "zhs_retry_";
  var RETRY_MAX_KEY = "zhs_retry_max";
  var MAX_RETRIES = 4;
  var MAX_HOPS = 500;
  var ROUTE_SETTLE_MS = 200;
  var NAV_BACK_SEL = '[class*="w-[32px]"][class*="h-[32px]"].cursor-pointer';
  var SCREENS = {
    LIST: "LIST",
    DETAIL: "DETAIL",
    PRE_QUIZ: "PRE_QUIZ",
    QUIZ: "QUIZ",
    RESULT: "RESULT",
    UNKNOWN: "UNKNOWN"
  };
  var AI_CHAT = {
    maxAttempts: 3,
    timeoutMs: 12e4,
    retryDelayMs: 1500
  };
  var AI_STATUS = {
    IDLE: "idle",
    REQUESTING: "requesting",
    RETRYING: "retrying",
    SUCCESS: "success",
    FAILED: "failed"
  };
  var CHAIN_STEPS = [
    { id: SCREENS.LIST, label: "列表" },
    { id: SCREENS.DETAIL, label: "详情" },
    { id: SCREENS.PRE_QUIZ, label: "提升入口" },
    { id: SCREENS.QUIZ, label: "答题" },
    { id: SCREENS.RESULT, label: "成绩" }
  ];
  var SCREEN_LABELS = {
    [SCREENS.LIST]: "掌握度列表",
    [SCREENS.DETAIL]: "知识点详情",
    [SCREENS.PRE_QUIZ]: "提升入口",
    [SCREENS.QUIZ]: "答题页",
    [SCREENS.RESULT]: "成绩页",
    [SCREENS.UNKNOWN]: "未识别页面"
  };

  // src/utils.js
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var getPageUrlKey = () => {
    try {
      return new URL(window.location.href).pathname.replace(/\//g, "_").replace(/^_+|_+$/g, "") || "root";
    } catch {
      return "unknown";
    }
  };
  var makeRetryKey = (index) => `${RETRY_KEY_PREFIX}${getPageUrlKey()}_${index}`;
  var makeRetryMaxKey = () => `${RETRY_MAX_KEY}_${getPageUrlKey()}`;
  var isLoopOn = () => {
    const date = Date.now();
    return GM_getValue(LOOP_KEY, 0) >= date;
  };
  var setLoopKey = (value = false) => {
    if (value && !unsafeWindow.__ZHS_STOP) {
      GM_setValue(LOOP_KEY, Date.now() + 1e3 * 60 * 2);
    } else {
      GM_setValue(LOOP_KEY, 0);
    }
  };
  var getThreshold = () => GM_getValue(THRESHOLD_KEY, 80);
  var getRetryCount = (index) => GM_getValue(makeRetryKey(index), 0);
  var setRetryCount = (index, count) => GM_setValue(makeRetryKey(index), count);
  var incRetryCount = (index) => setRetryCount(index, getRetryCount(index) + 1);
  var resetRetryCounts = () => {
    const max = GM_getValue(makeRetryMaxKey(), 0);
    for (let i = 0; i < max; i++) {
      setRetryCount(i, 0);
    }
  };
  var updateRetryMax = (newV) => {
    const current = GM_getValue(makeRetryMaxKey(), 0);
    const num = parseInt(newV, 10);
    if (!Number.isNaN(num) && num >= current) GM_setValue(makeRetryMaxKey(), num + 1);
  };
  var lowThanMaxRetry = (i) => {
    return getRetryCount(i) <= MAX_RETRIES;
  };
  var getApiCfg = () => ({
    baseUrl: GM_getValue("zhs_api_baseurl", ""),
    apiKey: GM_getValue("zhs_api_apikey", ""),
    model: GM_getValue("zhs_api_model", ""),
    maxTokens: GM_getValue("zhs_api_maxtokens", 2048),
    timeoutMs: GM_getValue("zhs_api_timeout", 12e4)
  });
  var saveMaxTokens = (val) => {
    const num = parseInt(val, 10);
    if (!Number.isNaN(num) && num >= 256 && num <= 8192) {
      GM_setValue("zhs_api_maxtokens", num);
      return true;
    }
    return false;
  };
  var saveTimeout = (val) => {
    const num = parseInt(val, 10);
    if (!Number.isNaN(num) && num >= 1e4 && num <= 3e5) {
      GM_setValue("zhs_api_timeout", num);
      return true;
    }
    return false;
  };

  // src/dom.js
  var click = (el) => {
    if (!el) return;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: unsafeWindow }));
  };
  var clickUntilGone = async (selectorOrFn, timeout = 15e3, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (unsafeWindow.__ZHS_STOP) return false;
      const el = typeof selectorOrFn === "function" ? selectorOrFn() : document.querySelector(selectorOrFn);
      if (!el) return true;
      click(el);
      await sleep(step);
    }
    return false;
  };
  var waitFor = async (fn, timeout = 3e4, step = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (unsafeWindow.__ZHS_STOP) return null;
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  var detectScreen = () => {
    if (document.querySelector(".charts-rate")) return SCREENS.RESULT;
    const q = document.querySelector(".questionContent");
    if (q?.innerText?.trim()) return SCREENS.QUIZ;
    if (document.querySelector(".improve-btn")) return SCREENS.PRE_QUIZ;
    if (document.querySelector(".simplified-mastery__action")) return SCREENS.DETAIL;
    const dash = document.querySelector(".el-progress--dashboard");
    if (dash && /\d+/.test(dash.innerText || "")) return SCREENS.LIST;
    return SCREENS.UNKNOWN;
  };
  var parsePct = (el) => parseInt((el?.innerText || "").replace(/\D/g, ""), 10);
  var findLowPctProgress = (increase = false) => {
    const threshold = getThreshold();
    const all = [...document.querySelectorAll(".el-progress--dashboard")];
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
  var hasListWork = () => !!findLowPctProgress();
  var enlargeSmallImage = (imgEl, minTarget = 20) => new Promise((resolve) => {
    const w = imgEl.naturalWidth || imgEl.width || 0;
    const h = imgEl.naturalHeight || imgEl.height || 0;
    if (w > 10 && h > 10) {
      resolve(imgEl.src);
      return;
    }
    GM_xmlhttpRequest({
      method: "GET",
      url: imgEl.src,
      responseType: "blob",
      onload: (resp) => {
        const blob = resp.response;
        const blobUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(blobUrl);
          const scale = minTarget / Math.min(img.width, img.height);
          const nw = Math.round(img.width * scale);
          const nh = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = nw;
          canvas.height = nh;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, nw, nh);
          console.log("url", canvas.toDataURL("image/png"));
          resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          resolve(imgEl.src);
        };
        img.src = blobUrl;
      },
      onerror: () => resolve(imgEl.src)
    });
  });
  var getQuestionBlocks = async (root) => {
    if (!root) return [];
    const blocks = [];
    let imgIndex = 0;
    const pushText = (s) => {
      const t = (s || "").replace(/\s+/g, " ").trim();
      if (!t) return;
      const last = blocks[blocks.length - 1];
      if (last && last.type === "text") last.content += " " + t;
      else blocks.push({ type: "text", content: t });
    };
    const walk = async (node) => {
      if (node.nodeType === 3) {
        pushText(node.textContent);
        return;
      }
      if (node.nodeType !== 1) return;
      if (/^(SCRIPT|STYLE)$/i.test(node.tagName)) return;
      if (node.classList?.contains("upload")) return;
      if (node.tagName === "IMG") {
        if (node.src.includes("fc9f26dc-8a16-44b9-b171-17a42641b0da")) {
          pushText("x");
          return;
        }
        const w = node.naturalWidth || node.width || 0;
        const h = node.naturalHeight || node.height || 0;
        if (w > 0 && h > 0) {
          imgIndex += 1;
          const src = await enlargeSmallImage(node);
          blocks.push({
            type: "image",
            index: imgIndex,
            src,
            alt: node.alt || ""
          });
        }
        return;
      }
      if (node.tagName === "BR") {
        pushText("\n");
        return;
      }
      for (const child of node.childNodes) await walk(child);
    };
    await walk(root);
    return blocks;
  };
  var blocksToMarkdown = (blocks) => blocks.map((b) => b.type === "text" ? b.content : `[IMAGE:${b.index}]`).join("\n");
  var readQuestion = async () => {
    const root = document.querySelector(".questionContent");
    const blocks = await getQuestionBlocks(root);
    unsafeWindow.__questionBlocks = blocks;
    return blocks;
  };
  var isMultipleChoice = () => !!document.querySelector(".el-checkbox-group.checkbox-view");
  var getQuizOptions = () => {
    if (isMultipleChoice()) {
      return [...document.querySelectorAll(".el-checkbox-group.checkbox-view .el-checkbox")];
    }
    return [...document.querySelectorAll("ul.radio-view li")];
  };
  var getMismatchNode = () => {
    const list = [...document.querySelectorAll(".custom-tree-answer-normal.no-answer")];
    const sortChar = (document.querySelector(".letterSortNum")?.innerText || "").trim().charAt(0);
    if (list.length >= 2) {
      for (let i = 1; i < list.length; i++) {
        const c1 = (list[i].innerText || "").trim().charAt(0);
        if (c1 !== sortChar) return list[i];
      }
    }
    return null;
  };

  // src/panel.js
  var hopActionLabel = (screen, expectDetailForward) => {
    switch (screen) {
      case SCREENS.LIST:
        return "选中低分题";
      case SCREENS.DETAIL:
        return expectDetailForward ? "去提升" : "退回列表";
      case SCREENS.PRE_QUIZ:
        return "开始提升";
      case SCREENS.QUIZ:
        return "答题/切题";
      case SCREENS.RESULT:
        return "退出成绩页";
      default:
        return "未知操作";
    }
  };
  var panelCtx = null;
  var panelNotify = (event, detail) => {
    if (panelCtx) panelCtx.handle(event, detail);
  };
  var createPanel = (handlers) => {
    const host = document.createElement("div");
    host.id = "zhs-panel-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483646;";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
    <style>
      *{box-sizing:border-box;margin:0;padding:0;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
      .wrap{position:fixed;top:0;right:0;width:28vw;height:100vh;color:#355148;font-size:12px;overflow:hidden;user-select:none;border-left:1px solid rgba(102,152,129,.16);background:linear-gradient(180deg,#f9fcf9 0%,#f3f8f3 56%,#edf4ee 100%);box-shadow:-12px 0 32px rgba(62,86,66,.06)}
      .wrap::before,.wrap::after{content:"";position:absolute;pointer-events:none}
      .wrap::before{top:-5vh;right:-4vw;width:12vw;height:14vw;background:radial-gradient(circle,rgba(164,212,179,.18),rgba(164,212,179,0));filter:blur(8px)}
      .wrap::after{bottom:-4vh;left:-3vw;width:10vw;height:10vw;background:radial-gradient(circle,rgba(215,234,220,.36),rgba(215,234,220,0));filter:blur(10px)}
      .wrap.collapsed{width:auto;height:auto;background:transparent;border:none;box-shadow:none}
      .wrap.collapsed::before,.wrap.collapsed::after{display:none}
      .wrap.error{color:#6b2525;border-left:1px solid rgba(180,110,110,.25);background:linear-gradient(180deg,#fff5f5 0%,#ffebeb 56%,#ffd6d6 100%);box-shadow:-12px 0 32px rgba(110,60,60,.1)}
      .wrap.error::before{background:radial-gradient(circle,rgba(239,154,154,.28),rgba(239,154,154,0))}
      .wrap.error::after{background:radial-gradient(circle,rgba(255,138,128,.38),rgba(255,138,128,0))}
      .wrap.error .header{background:linear-gradient(180deg,#ffe3e3 0%,#ffd6d6 100%);border-bottom:1px solid rgba(180,121,121,.22)}
      .wrap.error .title{color:#6b2525}
      .wrap.error .subtitle{color:#a35c5c}
      .wrap.error .section-label{color:#a85353}
      .wrap.error .section-label::after{background:linear-gradient(90deg,rgba(180,120,120,.26),rgba(180,120,120,0))}
      .wrap.error .fab{background:linear-gradient(180deg,#ffd6d6,#fca3a3);border:1px solid rgba(180,125,125,.4);color:#6b2525;box-shadow:0 14px 32px rgba(118,87,87,.15)}
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
            <div class="vision-tip">建议优先使用带视觉能力的模型。纯文本模型遇到题目图片时更容易失败。</div>
            <div class="form-grid">
              <div class="form-group"><label>API Base URL</label><input id="inp-baseurl" type="text" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></div>
              <div class="form-group"><label>API Key</label><input id="inp-apikey" type="password" placeholder="输入你的 API Key"></div>
              <div class="form-group"><label>Model Name</label><input id="inp-model" type="text" placeholder="推荐：qwen-vl-plus"></div>
              <div class="form-group"><label>Max Tokens</label><input id="inp-maxtokens" type="number" min="256" max="8192" placeholder="默认 2048"></div>
              <div class="form-group"><label>Timeout (ms)</label><input id="inp-timeout" type="number" min="10000" max="300000" step="10000" placeholder="默认 120000"></div>
              <div class="form-group"><label>掌握度阈值 (%)</label><input id="inp-threshold" type="number" min="0" max="100" placeholder="默认 80"></div>
            </div>
            <div class="btns" style="margin:6px 0 0 0">
              <button class="btn btn-start" id="btn-save-settings" type="button">保存配置</button>
            </div>
            <div class="btns" style="margin:6px 0 0 0">
              <button class="btn btn-stop" id="btn-reset-retry" type="button">重置做题次数</button>
            </div>
          </div>
          <div class="section-label">运行模式</div>
          <div style="display:flex;gap:12px;margin: 4px 0 12px 0;">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#355148;font-weight:500;">
              <input type="radio" name="run-mode" value="chain" checked style="accent-color:#7fbb93;"> 掌握度自适应
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#355148;font-weight:500;">
              <input type="radio" name="run-mode" value="homework" style="accent-color:#7fbb93;"> 课后作业/测试
            </label>
          </div>
          <div class="section-label">运行状态</div>
          <div class="steps" id="steps">${CHAIN_STEPS.map((s) => `<div class="step" data-id="${s.id}">${s.label}</div>`).join("")}</div>
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
    const wrap = shadow.getElementById("wrap");
    const fab = shadow.getElementById("fab");
    const dragHandle = shadow.getElementById("drag-handle");
    const stepsEl = shadow.getElementById("steps");
    const runDot = shadow.getElementById("run-dot");
    const tagRun = shadow.getElementById("tag-run");
    const tagLoop = shadow.getElementById("tag-loop");
    const tagScreen = shadow.getElementById("tag-screen");
    const tagApi = shadow.getElementById("tag-api");
    const logEl = shadow.getElementById("log");
    const btnStart = shadow.getElementById("btn-start");
    const btnStop = shadow.getElementById("btn-stop");
    const btnCollapse = shadow.getElementById("btn-collapse");
    const btnSettings = shadow.getElementById("btn-settings");
    const settingsPanel = shadow.getElementById("settings-panel");
    const inpBaseUrl = shadow.getElementById("inp-baseurl");
    const inpApiKey = shadow.getElementById("inp-apikey");
    const inpModel = shadow.getElementById("inp-model");
    const inpMaxTokens = shadow.getElementById("inp-maxtokens");
    const inpTimeout = shadow.getElementById("inp-timeout");
    const inpThreshold = shadow.getElementById("inp-threshold");
    const btnSaveSettings = shadow.getElementById("btn-save-settings");
    const btnResetRetry = shadow.getElementById("btn-reset-retry");
    const logs = [];
    let running = false;
    let currentScreen = SCREENS.UNKNOWN;
    const fmtTime = () => {
      const d = /* @__PURE__ */ new Date();
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    };
    const renderLogs = () => {
      logEl.innerHTML = logs.length ? logs.map(
        (l) => `<div class="log-item${l.err ? " err" : ""}"><span class="log-time">${l.t}</span><span>${l.m}</span></div>`
      ).join("") : '<div class="log-empty">等待任务开始…</div>';
      logEl.scrollTop = logEl.scrollHeight;
    };
    const addLog = (msg, err = false) => {
      logs.push({ t: fmtTime(), m: msg, err });
      if (logs.length > 30) logs.shift();
      renderLogs();
    };
    const applyPos = (offsetX = 0) => {
      wrap.style.right = `${offsetX}px`;
      wrap.style.top = "0";
      wrap.style.left = "auto";
      wrap.style.bottom = "auto";
      if (wrap.classList.contains("collapsed")) {
        wrap.style.height = "";
        wrap.style.width = "";
      } else {
        wrap.style.height = "100vh";
        wrap.style.width = "28vw";
      }
    };
    const savePos = (offsetX) => {
      GM_setValue(PANEL_POS_KEY, { x: Math.round(offsetX) });
    };
    const setCollapsed = (collapsed) => {
      wrap.classList.toggle("collapsed", collapsed);
      const savedPos = GM_getValue(PANEL_POS_KEY, { x: 0 });
      applyPos(typeof savedPos?.x === "number" ? savedPos.x : 0);
      GM_setValue(PANEL_COLLAPSED_KEY, collapsed);
    };
    const updateSteps = (screen) => {
      const idx = CHAIN_STEPS.findIndex((s) => s.id === screen);
      stepsEl.querySelectorAll(".step").forEach((el, i) => {
        el.classList.remove("active", "done");
        if (idx < 0) return;
        if (i < idx) el.classList.add("done");
        else if (i === idx) el.classList.add("active");
      });
    };
    const loadSettingsInputs = () => {
      inpBaseUrl.value = GM_getValue("zhs_api_baseurl", "");
      inpApiKey.value = GM_getValue("zhs_api_apikey", "");
      inpModel.value = GM_getValue("zhs_api_model", "");
      inpMaxTokens.value = GM_getValue("zhs_api_maxtokens", 2048);
      inpTimeout.value = GM_getValue("zhs_api_timeout", 12e4);
      inpThreshold.value = GM_getValue(THRESHOLD_KEY, 80);
      const savedMode = GM_getValue("zhs_run_mode", "chain");
      const radio = shadow.querySelector(`input[name="run-mode"][value="${savedMode}"]`);
      if (radio) radio.checked = true;
    };
    const refreshApiStatus = () => {
      const cfg = getApiCfg();
      const modelLabel = cfg.model ? cfg.model.split("-")[0] : "未配置";
      const baseUrlShort = cfg.baseUrl ? cfg.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") : "未配置";
      const keyLabel = cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}...` : "未配置";
      tagApi.textContent = `API:${modelLabel}`;
      tagApi.title = `BaseURL: ${baseUrlShort}
Key: ${keyLabel}`;
    };
    const refreshStatus = () => {
      const loop = isLoopOn();
      running = !!unsafeWindow.__ZHS_CHAIN_RUNNING;
      runDot.classList.toggle("running", running);
      tagRun.textContent = running ? "运行中" : "已停止";
      tagRun.className = `tag ${running ? "on" : "off"}`;
      tagLoop.textContent = loop ? "循环开" : "循环关";
      tagLoop.className = `tag ${loop ? "on" : "off"}`;
      tagScreen.textContent = `当前：${SCREEN_LABELS[currentScreen] || currentScreen}`;
      refreshApiStatus();
      updateSteps(currentScreen);
    };
    const handle = (event, detail) => {
      switch (event) {
        case "init":
          wrap.classList.remove("error");
          addLog("待命，点击「开始/继续」启动");
          refreshStatus();
          break;
        case "start":
          wrap.classList.remove("error");
          addLog("已开始");
          refreshStatus();
          break;
        case "stop":
          wrap.classList.remove("error");
          addLog("已停止");
          refreshStatus();
          break;
        case "screen":
          if (detail) currentScreen = detail;
          refreshStatus();
          break;
        case "hop":
          if (detail?.action) addLog(`${SCREEN_LABELS[detail.screen] || detail.screen} → ${detail.action}`);
          else if (detail?.screen)
            addLog(`${SCREEN_LABELS[detail.screen] || detail.screen} → ${hopActionLabel(detail.screen, detail.expectDetailForward)}`);
          refreshStatus();
          break;
        case "quiz":
          if (detail?.phase === "start") addLog("AI 答题中…");
          else if (detail?.phase === "done") addLog(`AI 答题完成 | ${detail.aiOutput || ""}`);
          break;
        case "error":
          wrap.classList.add("error");
          addLog(detail || "发生错误", true);
          refreshStatus();
          break;
        case "done":
          addLog("本轮结束");
          refreshStatus();
          break;
        default:
          break;
      }
    };
    const setupDrag = (handleEl, onTap) => {
      handleEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const saved = GM_getValue(PANEL_POS_KEY, { x: 0 });
        const startOffsetX = typeof saved?.x === "number" ? saved.x : 0;
        let moved = false;
        const onMove = (ev) => {
          const deltaX = startX - ev.clientX;
          if (Math.abs(deltaX) > 3) moved = true;
          const maxOffset = Math.max(window.innerWidth - 72, 0);
          const nextOffset = Math.min(Math.max(startOffsetX + deltaX, 0), maxOffset);
          applyPos(nextOffset);
        };
        const onUp = (ev) => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          const deltaX = startX - ev.clientX;
          const maxOffset = Math.max(window.innerWidth - 72, 0);
          const nextOffset = Math.min(Math.max(startOffsetX + deltaX, 0), maxOffset);
          savePos(nextOffset);
          if (!moved && onTap) onTap();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    };
    setCollapsed(GM_getValue(PANEL_COLLAPSED_KEY, false));
    setupDrag(dragHandle);
    setupDrag(fab, () => setCollapsed(false));
    loadSettingsInputs();
    shadow.querySelectorAll('input[name="run-mode"]').forEach((input) => {
      input.addEventListener("change", (e) => {
        GM_setValue("zhs_run_mode", e.target.value);
        addLog(`已切换运行模式：${e.target.value === "chain" ? "掌握度自适应" : "课后作业/测试"}`);
      });
    });
    btnStart.addEventListener("click", () => handlers.onStart());
    btnStop.addEventListener("click", () => handlers.onStop());
    btnCollapse.addEventListener("click", () => setCollapsed(true));
    btnSettings.addEventListener("click", () => {
      const isOpen = settingsPanel.classList.toggle("open");
      if (isOpen) loadSettingsInputs();
    });
    btnSaveSettings.addEventListener("click", () => {
      GM_setValue("zhs_api_baseurl", inpBaseUrl.value.trim());
      GM_setValue("zhs_api_apikey", inpApiKey.value.trim());
      GM_setValue("zhs_api_model", inpModel.value.trim());
      saveMaxTokens(inpMaxTokens.value);
      saveTimeout(inpTimeout.value);
      const threshold = parseInt(inpThreshold.value, 10);
      if (!Number.isNaN(threshold) && threshold >= 0 && threshold <= 100) {
        GM_setValue(THRESHOLD_KEY, threshold);
      }
      settingsPanel.classList.remove("open");
      addLog("API 配置已保存");
      refreshApiStatus();
    });
    btnResetRetry.addEventListener("click", () => {
      resetRetryCounts();
      addLog("做题次数已重置");
    });
    panelCtx = { handle, refreshStatus, setScreen: (s) => {
      currentScreen = s;
      refreshStatus();
    } };
    return panelCtx;
  };

  // src/api.js
  var createAIChatState = () => ({
    status: AI_STATUS.IDLE,
    attempt: 0,
    lastRaw: "",
    lastError: null
  });
  var isValidQuizAnswer = (raw, optionCount) => {
    const all = [...(raw || "").matchAll(/答案[：:]\s*([A-Z]+)/ig)];
    const last = all[all.length - 1];
    if (!last) return false;
    const letters = last[1].toUpperCase();
    return [...letters].every((l) => {
      const idx = l.charCodeAt(0) - 65;
      return idx >= 0 && idx < optionCount;
    });
  };
  var parseApiError = (res) => {
    let msg = "";
    try {
      const body = JSON.parse(res.responseText);
      msg = body?.error?.message || body?.error?.msg || body?.message || body?.msg || body?.error || "";
      if (typeof msg === "object") msg = JSON.stringify(msg);
    } catch (_) {
      msg = res.responseText || "";
    }
    return msg.slice(0, 300);
  };
  var callAIOnce = (messages) => new Promise((resolve, reject) => {
    console.log(messages, "messages");
    const apiCfg = getApiCfg();
    GM_xmlhttpRequest({
      method: "POST",
      url: `${apiCfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiCfg.apiKey}`
      },
      data: JSON.stringify({
        model: apiCfg.model,
        messages,
        temperature: 0.2,
        max_tokens: apiCfg.maxTokens
      }),
      timeout: apiCfg.timeoutMs,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          const detail = parseApiError(res);
          reject(new Error(`AI HTTP ${res.status}${detail ? " | " + detail : ""}`));
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
      onerror: () => reject(new Error("AI 网络错误")),
      ontimeout: () => reject(new Error("AI 请求超时"))
    });
  });
  var requestAI = async (buildMessages, validate) => {
    const chatState = createAIChatState();
    for (let attempt = 1; attempt <= AI_CHAT.maxAttempts; attempt++) {
      chatState.attempt = attempt;
      chatState.status = attempt === 1 ? AI_STATUS.REQUESTING : AI_STATUS.RETRYING;
      try {
        const messages = buildMessages(attempt, chatState);
        chatState.memory = messages;
        const raw = await callAIOnce(messages);
        console.log(`AI 响应: ${raw}`);
        chatState.lastRaw = raw;
        if (validate(raw)) {
          chatState.status = AI_STATUS.SUCCESS;
          return { raw, state: chatState };
        }
        chatState.lastError = "答案格式不合规";
      } catch (e) {
        chatState.lastError = e.message || String(e);
      }
      if (attempt < AI_CHAT.maxAttempts) {
        await sleep(AI_CHAT.retryDelayMs);
      }
    }
    chatState.status = AI_STATUS.FAILED;
    if (chatState.lastError === "答案格式不合规") {
      throw new Error(`AI 答案不合规，已重试 ${AI_CHAT.maxAttempts} 次: ${chatState.lastRaw}`);
    }
    throw new Error(`AI 请求失败，已重试 ${AI_CHAT.maxAttempts} 次: ${chatState.lastError}`);
  };
  var buildQuizMessages = (blocks, optLines, attempt, chatState, isMultiple = false) => {
    const memory = chatState.memory || [];
    const answerFmt = isMultiple ? '最后一行必须以"答案：X"的格式输出，X 为多个连续字母（对应所有正确选项，例如"ABC"表示选A、B、C三个选项）' : '最后一行必须以"答案：X"的格式输出，X 只能为单个字母（对应正确选项）';
    if (!memory.length) {
      memory.push({
        role: "system",
        content: `你是一个专业的做题助手，你的任务是根据用户的题目，生成符合要求的选项，请逐步用平文本思考并选出正确答案的选项。${answerFmt}。`
      });
    }
    if (attempt > 1 && chatState.lastRaw) {
      memory.push({
        role: "assistant",
        content: chatState.lastRaw
      });
    }
    if (memory.length < 2) {
      const blocksToMarkdown2 = (blks) => blks.map((b) => b.type === "text" ? b.content : `[IMAGE:${b.index}]`).join("\n");
      const content = [{ type: "text", text: `题目：

${blocksToMarkdown2(blocks)}

选项：
${optLines.join("\n")}` }];
      blocks.filter((b) => b.type === "image").forEach((b) => content.push({ type: "image_url", image_url: { url: b.src } }));
      memory.push({
        role: "user",
        content
      });
    }
    if (attempt > 1) {
      memory.push({
        role: "user",
        content: `

你上次回答不合规（需以"答案：X"结尾且 X 为有效选项字母），有可能是因为回答太长截断。请你简短的总结上一次的回答思路（不超过3句话），按更短的链路继续上次的思路回答`
      });
    }
    return memory;
  };
  var parseAnswerLetters = (raw) => {
    const all = [...(raw || "").matchAll(/答案[：:]\s*([A-Z]+)/ig)];
    const last = all[all.length - 1];
    return last ? [...last[1].toUpperCase()] : [];
  };
  var answerWithAI = async (blocks) => {
    const mc = isMultipleChoice();
    const opts = getQuizOptions();
    if (!opts.length) return null;
    const optLines = opts.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt.innerText.trim()}`);
    const { raw } = await requestAI(
      (attempt, chatState) => buildQuizMessages(blocks, optLines, attempt, chatState, mc),
      (raw2) => isValidQuizAnswer(raw2, opts.length)
    );
    const letters = parseAnswerLetters(raw);
    for (const letter of letters) {
      const idx = letter.charCodeAt(0) - 65;
      const targetOpt = opts[idx];
      if (!targetOpt) continue;
      if (mc) {
        if (!targetOpt.classList.contains("is-checked")) {
          click(targetOpt);
          await waitFor(() => targetOpt.classList.contains("is-checked") ? true : null, 3e3, 50);
        }
      } else {
        const oldClass = targetOpt.className;
        await clickUntilGone(() => {
          return targetOpt.className === oldClass ? targetOpt : null;
        }, 3e3);
      }
    }
    return raw;
  };

  // src/homework.js
  var getHomeworkUnansweredButton = () => {
    return document.querySelector(".border-black\\/20.text-black\\/60.border");
  };
  var isHomeworkCurrentAnswered = () => {
    const selectedCircle = document.querySelector(".question-area-content .bg-mainBg");
    return !!selectedCircle;
  };
  var getHomeworkSubmitButton = () => {
    const allDivs = [...document.querySelectorAll("div, button")];
    return allDivs.find((el) => {
      const classes = el.className || "";
      const hasBg = typeof classes === "string" && classes.includes("bg-[#0D0D0D]");
      const hasText = (el.innerText || "").includes("提交作业");
      return hasBg || hasText;
    });
  };
  var buildHomeworkQuizMessages = (questionText, images, attempt, chatState, isSingle = true) => {
    const memory = chatState.memory || [];
    const answerFmt = isSingle ? '最后一行必须以"答案：X"的格式输出，X 只能为单个字母（对应正确选项）' : '最后一行必须以"答案：X"的格式输出，X 为多个连续字母（对应所有正确选项，例如"ABC"表示选A、B、C三个选项）';
    if (!memory.length) {
      memory.push({
        role: "system",
        content: `你是一个专业的做题助手，你的任务是根据用户的题目（包含题干 and 选项），请逐步用平文本思考并选出正确答案的选项。${answerFmt}。`
      });
    }
    if (attempt > 1 && chatState.lastRaw) {
      memory.push({
        role: "assistant",
        content: chatState.lastRaw
      });
    }
    if (memory.length < 2) {
      const content = [{ type: "text", text: `完整题目与选项内容如下：

${questionText}` }];
      images.forEach((src) => content.push({ type: "image_url", image_url: { url: src } }));
      memory.push({
        role: "user",
        content
      });
    }
    if (attempt > 1) {
      memory.push({
        role: "user",
        content: `

你上次回答不合规（需以"答案：X"结尾且 X 为有效选项字母），请你简短总结上一次的回答思路（不超过3句话），按更短的路线继续回答`
      });
    }
    return memory;
  };
  var isValidHomeworkAnswer = (raw) => {
    const match = (raw || "").match(/答案[：:]\s*([A-Z]+)/i);
    return !!match;
  };
  var answerHomeworkWithAI = async (questionText, images, isSingle) => {
    const { raw } = await requestAI(
      (attempt, chatState) => buildHomeworkQuizMessages(questionText, images, attempt, chatState, isSingle),
      (raw2) => isValidHomeworkAnswer(raw2)
    );
    return raw;
  };
  async function runHomeworkQuiz() {
    while (!unsafeWindow.__ZHS_STOP) {
      const container = await waitFor(() => {
        const el = document.querySelector(".question-area-content");
        return el && el.innerText.trim() ? el : null;
      }, 15e3);
      if (!container) return false;
      const oldText = container.innerText;
      panelNotify("quiz", { phase: "start" });
      const blocks = await getQuestionBlocks(container);
      const questionContent = blocksToMarkdown(blocks);
      const images = blocks.filter((b) => b.type === "image").map((b) => b.src);
      const typeEl = document.querySelector(".text-green");
      const isSingle = !!(typeEl && typeEl.innerText.includes("单选"));
      let aiRaw;
      try {
        aiRaw = await answerHomeworkWithAI(questionContent, images, isSingle);
        panelNotify("quiz", { phase: "done", aiOutput: aiRaw });
      } catch (e) {
        panelNotify("error", e?.message || "AI 答题失败");
        return false;
      }
      const letters = parseAnswerLetters(aiRaw);
      const optionContainers = [...container.querySelectorAll(".flex.items-center.gap-4.user-select.group")];
      for (const letter of letters) {
        const targetOption = optionContainers.find((opt) => {
          const circle = opt.querySelector(".font-AP-65");
          return circle && circle.innerText.trim().toUpperCase() === letter;
        });
        if (targetOption) {
          click(targetOption);
          await waitFor(() => {
            const circle = targetOption.querySelector(".font-AP-65");
            return circle && circle.classList.contains("bg-mainBg") ? true : null;
          }, 3e3);
        }
      }
      const nextUnansweredBtn = getHomeworkUnansweredButton();
      if (nextUnansweredBtn) {
        click(nextUnansweredBtn);
        const changed = await waitFor(() => {
          const curContainer = document.querySelector(".question-area-content");
          return curContainer && curContainer.innerText.trim() !== oldText ? true : null;
        }, 5e3);
        if (!changed) {
          panelNotify("error", "切换下一题失败");
          return false;
        }
      } else {
        if (isHomeworkCurrentAnswered()) {
          const submitBtn = getHomeworkSubmitButton();
          if (submitBtn) {
            click(submitBtn);
            return true;
          } else {
            panelNotify("error", "未找到提交作业按钮");
            return false;
          }
        } else {
          panelNotify("error", "题号答完但当前题目没有被勾选，请重试");
          return false;
        }
      }
    }
    return false;
  }
  async function runHomeworkFlow() {
    if (unsafeWindow.__ZHS_CHAIN_RUNNING) return;
    unsafeWindow.__ZHS_CHAIN_RUNNING = true;
    panelNotify("start");
    try {
      panelNotify("screen", SCREENS.QUIZ);
      const success = await runHomeworkQuiz();
      if (success) {
        panelNotify("hop", { screen: SCREENS.QUIZ, action: "作业答题完成并已提交！" });
      } else {
        panelNotify("error", "未识别到题目页面，或答题中断");
      }
    } catch (e) {
      panelNotify("error", e?.message || "作业答题发生错误");
    } finally {
      unsafeWindow.__ZHS_CHAIN_RUNNING = false;
      setLoopKey(false);
      panelNotify("done");
    }
  }

  // src/flow.js
  async function runListHop() {
    if (!isLoopOn()) return false;
    const hasDashboard = await waitFor(() => {
      const el2 = document.querySelector(".el-progress--dashboard");
      return el2 && /\d+/.test(el2.innerText || "") ? el2 : null;
    }, 3e4);
    if (!hasDashboard) return false;
    if (!hasListWork()) {
      setLoopKey(false);
      return false;
    }
    const el = await waitFor(() => findLowPctProgress(true));
    return clickUntilGone(() => findLowPctProgress());
  }
  async function runDetailHop() {
    setLoopKey(true);
    return clickUntilGone(".simplified-mastery__action");
  }
  async function runDetailExitHop() {
    setLoopKey(true);
    return clickUntilGone(NAV_BACK_SEL);
  }
  async function runPreQuizHop() {
    setLoopKey(true);
    return clickUntilGone(".improve-btn", 2e4, 5e3);
  }
  async function runQuizHop() {
    const isReady = await waitFor(() => {
      const q = document.querySelector(".questionContent");
      if (!q || !q.innerText.trim()) return null;
      const mc = !!document.querySelector(".el-checkbox-group.checkbox-view");
      const opts = mc ? document.querySelectorAll(".el-checkbox-group.checkbox-view .el-checkbox") : document.querySelectorAll("ul.radio-view li");
      return opts.length > 0 && opts[0].innerText.trim() ? q : null;
    }, 3e4);
    if (!isReady) return false;
    const oldText = isReady.innerText;
    panelNotify("quiz", { phase: "start" });
    try {
      const aiRaw = await answerWithAI(await readQuestion());
      panelNotify("quiz", { phase: "done", aiOutput: aiRaw });
    } catch (e) {
      panelNotify("error", e?.message || "AI 答题失败");
      return false;
    }
    setLoopKey(true);
    if (getMismatchNode()) {
      return clickUntilGone(() => {
        const currentQ = document.querySelector(".questionContent");
        if (!currentQ || currentQ.innerText !== oldText) return null;
        return getMismatchNode();
      });
    }
    panelNotify("hop", { screen: SCREENS.QUIZ, action: "提交作业" });
    setLoopKey(true);
    return clickUntilGone(".reviewDone.ZHIHUISHU_QZMD");
  }
  async function runResultHop() {
    if (!document.querySelector(".charts-rate")) return false;
    const ok1 = await clickUntilGone(".backup-icon");
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
    const mode = GM_getValue("zhs_run_mode", "chain");
    if (mode === "homework") {
      return runHomeworkFlow();
    }
    unsafeWindow.__ZHS_CHAIN_RUNNING = true;
    panelNotify("start");
    try {
      let hops = 0;
      let expectDetailForward = false;
      while (hops < MAX_HOPS && isLoopOn() && !unsafeWindow.__ZHS_STOP) {
        hops += 1;
        let screen = detectScreen();
        if (screen === SCREENS.UNKNOWN) {
          const found = await waitFor(() => detectScreen() !== SCREENS.UNKNOWN ? true : null, 15e3);
          if (!found) {
            panelNotify("error", "未识别页面，停止");
            break;
          }
          screen = detectScreen();
          if (screen === SCREENS.UNKNOWN) {
            panelNotify("error", "未识别页面，停止");
            break;
          }
        }
        panelNotify("screen", screen);
        const progressed = await runOneHop(screen, expectDetailForward);
        if (!progressed) {
          panelNotify("error", `${SCREEN_LABELS[screen] || screen}：本步未推进`);
          break;
        }
        panelNotify("hop", { screen, expectDetailForward });
        if (screen === SCREENS.LIST && progressed) expectDetailForward = true;
        if (screen === SCREENS.DETAIL && expectDetailForward && progressed) expectDetailForward = false;
        await sleep(ROUTE_SETTLE_MS);
        if (detectScreen() === SCREENS.LIST && !hasListWork()) {
          setLoopKey(false);
          panelNotify("hop", { screen: SCREENS.LIST, action: "无待刷题目，关闭循环" });
          break;
        }
      }
    } finally {
      unsafeWindow.__ZHS_CHAIN_RUNNING = false;
      panelNotify("done");
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
    panelNotify("stop");
  }

  // src/index.js
  GM_registerMenuCommand("最小链路：开始/继续", startChain);
  GM_registerMenuCommand("最小链路：停止", stopChain);
  GM_registerMenuCommand("设置 API 配置", () => {
    const url = prompt("输入 API Base URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）:", GM_getValue("zhs_api_baseurl", ""));
    if (url !== null) GM_setValue("zhs_api_baseurl", url.trim());
    const key = prompt("输入 API Key:", GM_getValue("zhs_api_apikey", ""));
    if (key !== null) GM_setValue("zhs_api_apikey", key.trim());
    const model = prompt("输入 Model Name（如 qwen-vl-plus,qwen3.6-flash-2026-04-16）:", GM_getValue("zhs_api_model", ""));
    if (model !== null) GM_setValue("zhs_api_model", model.trim());
    const maxTokens = prompt("输入 Max Tokens（默认 2048）:", GM_getValue("zhs_api_maxtokens", 2048));
    if (maxTokens !== null) saveMaxTokens(maxTokens);
    const timeout = prompt("输入 Timeout (ms)（默认 120000）:", GM_getValue("zhs_api_timeout", 12e4));
    if (timeout !== null) saveTimeout(timeout);
  });
  var panelCtx2 = createPanel({ onStart: startChain, onStop: stopChain });
  panelNotify("init");
  panelNotify("screen", detectScreen());
  var idleRefreshTimer = setInterval(() => {
    if (!unsafeWindow.__ZHS_CHAIN_RUNNING) {
      panelNotify("screen", detectScreen());
    }
  }, 2e3);
  window.addEventListener("beforeunload", () => clearInterval(idleRefreshTimer));
  waitFor(() => detectScreen() !== SCREENS.UNKNOWN ? true : null, 15e3).then(() => {
    if (isLoopOn() && !unsafeWindow.__ZHS_STOP) runFromHere();
  });
})();
