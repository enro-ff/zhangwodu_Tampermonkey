import {
  PANEL_POS_KEY,
  PANEL_COLLAPSED_KEY,
  THRESHOLD_KEY,
  SCREENS,
  CHAIN_STEPS,
  SCREEN_LABELS
} from './constants.js';
import {
  getApiCfg,
  saveMaxTokens,
  saveTimeout,
  isLoopOn,
  resetRetryCounts
} from './utils.js';

export const hopActionLabel = (screen, expectDetailForward) => {
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

export const panelNotify = (event, detail) => {
  if (panelCtx) panelCtx.handle(event, detail);
};

export const createPanel = (handlers) => {
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
  const inpMaxTokens = shadow.getElementById('inp-maxtokens');
  const inpTimeout = shadow.getElementById('inp-timeout');
  const inpThreshold = shadow.getElementById('inp-threshold');
  const btnSaveSettings = shadow.getElementById('btn-save-settings');
  const btnResetRetry = shadow.getElementById('btn-reset-retry');

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
    if (wrap.classList.contains('collapsed')) {
      wrap.style.height = '';
      wrap.style.width = '';
    } else {
      wrap.style.height = '100vh';
      wrap.style.width = '28vw';
    }
  };

  const savePos = (offsetX) => {
    GM_setValue(PANEL_POS_KEY, { x: Math.round(offsetX) });
  };

  const setCollapsed = (collapsed) => {
    wrap.classList.toggle('collapsed', collapsed);
    const savedPos = GM_getValue(PANEL_POS_KEY, { x: 0 });
    applyPos(typeof savedPos?.x === 'number' ? savedPos.x : 0);
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
    inpMaxTokens.value = GM_getValue('zhs_api_maxtokens', 2048);
    inpTimeout.value = GM_getValue('zhs_api_timeout', 120000);
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
        wrap.classList.remove('error');
        addLog('待命，点击「开始/继续」启动');
        refreshStatus();
        break;
      case 'start':
        wrap.classList.remove('error');
        addLog('已开始');
        refreshStatus();
        break;
      case 'stop':
        wrap.classList.remove('error');
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
        wrap.classList.add('error');
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
    saveMaxTokens(inpMaxTokens.value);
    saveTimeout(inpTimeout.value);
    const threshold = parseInt(inpThreshold.value, 10);
    if (!Number.isNaN(threshold) && threshold >= 0 && threshold <= 100) {
      GM_setValue(THRESHOLD_KEY, threshold);
    }
    settingsPanel.classList.remove('open');
    addLog('API 配置已保存');
    refreshApiStatus();
  });

  btnResetRetry.addEventListener('click', () => {
    resetRetryCounts();
    addLog('做题次数已重置');
  });

  panelCtx = { handle, refreshStatus, setScreen: (s) => { currentScreen = s; refreshStatus(); } };
  return panelCtx;
};
