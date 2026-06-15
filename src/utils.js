import {
  LOOP_KEY,
  THRESHOLD_KEY,
  RETRY_KEY_PREFIX,
  RETRY_MAX_KEY,
  MAX_RETRIES
} from './constants.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const getPageUrlKey = () => {
  try {
    return new URL(window.location.href).pathname.replace(/\//g, '_').replace(/^_+|_+$/g, '') || 'root';
  } catch {
    return 'unknown';
  }
};

export const makeRetryKey = (index) => `${RETRY_KEY_PREFIX}${getPageUrlKey()}_${index}`;
export const makeRetryMaxKey = () => `${RETRY_MAX_KEY}_${getPageUrlKey()}`;

export const isLoopOn = () => {
  const date = Date.now();
  return GM_getValue(LOOP_KEY, 0) >= date;
};

export const setLoopKey = (value = false) => {
  if (value && !unsafeWindow.__ZHS_STOP) {
    GM_setValue(LOOP_KEY, Date.now() + 1000 * 60 * 2);
  } else {
    GM_setValue(LOOP_KEY, 0);
  }
};

export const getThreshold = () => GM_getValue(THRESHOLD_KEY, 80);

export const parsePct = (el) => parseInt((el?.innerText || '').replace(/\D/g, ''), 10);

export const getRetryCount = (index) => GM_getValue(makeRetryKey(index), 0);
export const setRetryCount = (index, count) => GM_setValue(makeRetryKey(index), count);
export const incRetryCount = (index) => setRetryCount(index, getRetryCount(index) + 1);

export const resetRetryCounts = () => {
  const max = GM_getValue(makeRetryMaxKey(), 0);
  for (let i = 0; i < max; i++) {
    setRetryCount(i, 0);
  }
};

export const updateRetryMax = (newV) => {
  const current = GM_getValue(makeRetryMaxKey(), 0);
  const num = parseInt(newV, 10);
  if (!Number.isNaN(num) && num >= current) GM_setValue(makeRetryMaxKey(), num + 1);
};

export const lowThanMaxRetry = (i) => {
  return getRetryCount(i) <= MAX_RETRIES;
};

export const getApiCfg = () => ({
  baseUrl: GM_getValue('zhs_api_baseurl', ''),
  apiKey: GM_getValue('zhs_api_apikey', ''),
  model: GM_getValue('zhs_api_model', ''),
  maxTokens: GM_getValue('zhs_api_maxtokens', 2048),
  timeoutMs: GM_getValue('zhs_api_timeout', 120000),
});

export const saveMaxTokens = (val) => {
  const num = parseInt(val, 10);
  if (!Number.isNaN(num) && num >= 256 && num <= 8192) {
    GM_setValue('zhs_api_maxtokens', num);
    return true;
  }
  return false;
};

export const saveTimeout = (val) => {
  const num = parseInt(val, 10);
  if (!Number.isNaN(num) && num >= 10000 && num <= 300000) {
    GM_setValue('zhs_api_timeout', num);
    return true;
  }
  return false;
};
