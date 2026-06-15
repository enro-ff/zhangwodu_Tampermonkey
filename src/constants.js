export const LOOP_KEY = 'zhs_loop';
export const PANEL_POS_KEY = 'zhs_panel_pos';
export const PANEL_COLLAPSED_KEY = 'zhs_panel_collapsed';
export const THRESHOLD_KEY = 'zhs_threshold';
export const RETRY_KEY_PREFIX = 'zhs_retry_';
export const RETRY_MAX_KEY = 'zhs_retry_max';
export const MAX_RETRIES = 4;

export const MAX_HOPS = 500;
export const ROUTE_SETTLE_MS = 200;
export const NAV_BACK_SEL = '[class*="w-[32px]"][class*="h-[32px]"].cursor-pointer';

export const SCREENS = {
  LIST: 'LIST',
  DETAIL: 'DETAIL',
  PRE_QUIZ: 'PRE_QUIZ',
  QUIZ: 'QUIZ',
  RESULT: 'RESULT',
  UNKNOWN: 'UNKNOWN',
};

export const AI_CHAT = {
  maxAttempts: 3,
  timeoutMs: 120000,
  retryDelayMs: 1500,
};

export const AI_STATUS = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  RETRYING: 'retrying',
  SUCCESS: 'success',
  FAILED: 'failed',
};

export const CHAIN_STEPS = [
  { id: SCREENS.LIST, label: '列表' },
  { id: SCREENS.DETAIL, label: '详情' },
  { id: SCREENS.PRE_QUIZ, label: '提升入口' },
  { id: SCREENS.QUIZ, label: '答题' },
  { id: SCREENS.RESULT, label: '成绩' },
];

export const SCREEN_LABELS = {
  [SCREENS.LIST]: '掌握度列表',
  [SCREENS.DETAIL]: '知识点详情',
  [SCREENS.PRE_QUIZ]: '提升入口',
  [SCREENS.QUIZ]: '答题页',
  [SCREENS.RESULT]: '成绩页',
  [SCREENS.UNKNOWN]: '未识别页面',
};
