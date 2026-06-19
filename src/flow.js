import {
  SCREENS,
  MAX_HOPS,
  ROUTE_SETTLE_MS,
  NAV_BACK_SEL,
  SCREEN_LABELS
} from './constants.js';
import {
  isLoopOn,
  setLoopKey,
  sleep
} from './utils.js';
import {
  waitFor,
  findLowPctProgress,
  clickUntilGone,
  readQuestion,
  getMismatchNode,
  hasListWork,
  detectScreen,
  captureElement,
  getScreenshotTarget
} from './dom.js';
import { answerWithAI } from './api.js';
import { panelNotify } from './panel.js';
import { runHomeworkFlow } from './homework.js';

export async function runListHop() {
  if (!isLoopOn()) return false;

  const hasDashboard = await waitFor(() => {
    const el = document.querySelector('.el-progress--dashboard');
    return el && /\d+/.test(el.innerText || '') ? el : null;
  }, 30000);
  if (!hasDashboard) return false;

  if (!hasListWork()) {
    setLoopKey(false);
    return false;
  }
  const el = await waitFor(() => findLowPctProgress(true));
  
  return clickUntilGone(() => findLowPctProgress());
}

export async function runDetailHop() {
  setLoopKey(true);
  return clickUntilGone('.simplified-mastery__action');
}

export async function runDetailExitHop() {
  setLoopKey(true);
  return clickUntilGone(NAV_BACK_SEL);
}

export async function runPreQuizHop() {
  setLoopKey(true);
  return clickUntilGone('.improve-btn', 20000, 5000);
}

export async function runQuizHop() {
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

  const oldText = isReady.innerText;
  panelNotify('quiz', { phase: 'start' });
  try {
    const engineMode = GM_getValue('zhs_engine_mode', 'traditional');
    let aiRaw;
    if (engineMode === 'screenshot') {
      const target = getScreenshotTarget(SCREENS.QUIZ);
      if (!target) throw new Error('未找到截图目标元素');
      const screenshot = await captureElement(target);
      aiRaw = await answerWithAI(null, screenshot);
    } else {
      aiRaw = await answerWithAI(await readQuestion());
    }
    panelNotify('quiz', { phase: 'done', aiOutput: aiRaw });
  } catch (e) {
    panelNotify('error', e?.message || 'AI 答题失败');
    return false;
  }

  setLoopKey(true);

  if (getMismatchNode()) {
    return clickUntilGone(() => {
      const currentQ = document.querySelector('.questionContent');
      if (!currentQ || currentQ.innerText !== oldText) return null;
      return getMismatchNode();
    });
  }

  panelNotify('hop', { screen: SCREENS.QUIZ, action: '提交作业' });
  setLoopKey(true);
  return clickUntilGone('.reviewDone.ZHIHUISHU_QZMD');
}

export async function runResultHop() {
  if (!document.querySelector('.charts-rate')) return false;
  const ok1 = await clickUntilGone('.backup-icon');
  if (!ok1) return false;
  await sleep(ROUTE_SETTLE_MS);
  return clickUntilGone(NAV_BACK_SEL);
}

export async function runOneHop(screen, expectDetailForward) {
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



export async function runFromHere() {
  if (unsafeWindow.__ZHS_CHAIN_RUNNING) return;

  const mode = GM_getValue('zhs_run_mode', 'chain');
  if (mode === 'homework') {
    return runHomeworkFlow();
  }

  unsafeWindow.__ZHS_CHAIN_RUNNING = true;
  panelNotify('start');
  try {
    let hops = 0;
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

export function startChain() {
  unsafeWindow.__ZHS_STOP = false;
  setLoopKey(true);
  runFromHere();
}

export function stopChain() {
  unsafeWindow.__ZHS_STOP = true;
  setLoopKey(false);
  panelNotify('stop');
}
