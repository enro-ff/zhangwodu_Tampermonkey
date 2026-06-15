import { SCREENS } from './constants.js';
import { isLoopOn, saveMaxTokens, saveTimeout } from './utils.js';
import { detectScreen, waitFor } from './dom.js';
import { createPanel, panelNotify } from './panel.js';
import { startChain, stopChain, runFromHere } from './flow.js';

GM_registerMenuCommand('最小链路：开始/继续', startChain);
GM_registerMenuCommand('最小链路：停止', stopChain);
GM_registerMenuCommand('设置 API 配置', () => {
  const url = prompt('输入 API Base URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）:', GM_getValue('zhs_api_baseurl', ''));
  if (url !== null) GM_setValue('zhs_api_baseurl', url.trim());
  const key = prompt('输入 API Key:', GM_getValue('zhs_api_apikey', ''));
  if (key !== null) GM_setValue('zhs_api_apikey', key.trim());
  const model = prompt('输入 Model Name（如 qwen-vl-plus,qwen3.6-flash-2026-04-16）:', GM_getValue('zhs_api_model', ''));
  if (model !== null) GM_setValue('zhs_api_model', model.trim());
  const maxTokens = prompt('输入 Max Tokens（默认 2048）:', GM_getValue('zhs_api_maxtokens', 2048));
  if (maxTokens !== null) saveMaxTokens(maxTokens);
  const timeout = prompt('输入 Timeout (ms)（默认 120000）:', GM_getValue('zhs_api_timeout', 120000));
  if (timeout !== null) saveTimeout(timeout);
});

const panelCtx = createPanel({ onStart: startChain, onStop: stopChain });
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
