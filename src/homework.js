import { SCREENS } from './constants.js';
import { setLoopKey, sleep } from './utils.js';
import { waitFor, click, getQuestionBlocks, blocksToMarkdown, captureElement } from './dom.js';
import { requestAI, parseAnswerLetters } from './api.js';
import { panelNotify } from './panel.js';

// DOM Helper functions for the homework quiz page
export const getHomeworkUnansweredButton = () => {
  return document.querySelector('.border-black\\/20.text-black\\/60.border');
};

export const isHomeworkCurrentAnswered = () => {
  const selectedCircle = document.querySelector('.question-area-content .bg-mainBg');
  return !!selectedCircle;
};

export const getHomeworkSubmitButton = () => {
  const allDivs = [...document.querySelectorAll('div, button')];
  return allDivs.find(el => {
    const classes = el.className || '';
    const hasBg = typeof classes === 'string' && classes.includes('bg-[#0D0D0D]');
    const hasText = (el.innerText || '').includes('提交作业');
    return hasBg || hasText;
  });
};

// AI interaction logic
export const buildHomeworkQuizMessages = (input, images, attempt, chatState, isSingle = true, isScreenshot = false) => {
  const memory = chatState.memory || [];
  const answerFmt = isSingle
    ? '最后一行必须以"答案：X"的格式输出，X 只能为单个字母（对应正确选项）'
    : '最后一行必须以"答案：X"的格式输出，X 为多个连续字母（对应所有正确选项，例如"ABC"表示选A、B、C三个选项）';

  if (!memory.length) {
    memory.push({
      role: 'system',
      content: `你是一个专业的做题助手，你的任务是根据用户的题目（包含题干 and 选项），请逐步用平文本思考并选出正确答案的选项。${answerFmt}。`
    });
  }
  if (attempt > 1 && chatState.lastRaw) {
    memory.push({
      role: 'assistant',
      content: chatState.lastRaw,
    });
  }
  if (memory.length < 2) {
    let content;
    if (isScreenshot) {
      content = [
        { type: 'text', text: `请仔细阅读截图中展示的题目与选项。逐步用平文本思考并选出正确答案的选项。${answerFmt}。` },
        { type: 'image_url', image_url: { url: input } }
      ];
    } else {
      content = [{ type: 'text', text: `完整题目与选项内容如下：\n\n${input}` }];
      images.forEach((src) => content.push({ type: 'image_url', image_url: { url: src } }));
    }
    memory.push({
      role: 'user',
      content
    });
  }

  if (attempt > 1) {
    memory.push({
      role: 'user',
      content: `\n\n你上次回答不合规（需以"答案：X"结尾且 X 为有效选项字母），请你简短总结上一次的回答思路（不超过3句话），按更短的路线继续回答`,
    });
  }

  return memory;
};

export const isValidHomeworkAnswer = (raw) => {
  const match = (raw || '').match(/答案[：:]\s*([A-Z]+)/i);
  return !!match;
};

export const answerHomeworkWithAI = async (input, images, isSingle, isScreenshot = false) => {
  const { raw } = await requestAI(
    (attempt, chatState) => buildHomeworkQuizMessages(input, images, attempt, chatState, isSingle, isScreenshot),
    (raw) => isValidHomeworkAnswer(raw)
  );
  return raw;
};

// Homework automation flow
export async function runHomeworkQuiz() {
  while (!unsafeWindow.__ZHS_STOP) {
    // 1. Wait for loading spinner to disappear
    await waitFor(() => !document.querySelector('.el-loading-spinner'), 15000);

    // 2. Wait for question container and options to be fully ready
    const container = await waitFor(() => {
      const el = document.querySelector('.question-area-content');
      if (!el || !el.innerText.trim()) return null;
      const opts = el.querySelectorAll('.flex.items-center.gap-4.user-select.group');
      if (opts.length === 0) return null;
      return opts[0].innerText.trim() ? el : null;
    }, 15000);

    if (!container) return false;

    const oldText = container.innerText;
    panelNotify('quiz', { phase: 'start' });

    const typeEl = document.querySelector('.text-green');
    const isSingle = !!(typeEl && typeEl.innerText.includes('单选'));

    let aiRaw;
    try {
      const engineMode = GM_getValue('zhs_engine_mode', 'traditional');
      if (engineMode === 'screenshot') {
        const screenshot = await captureElement(container);
        aiRaw = await answerHomeworkWithAI(screenshot, [], isSingle, true);
      } else {
        const blocks = await getQuestionBlocks(container);
        const questionContent = blocksToMarkdown(blocks);
        const images = blocks.filter((b) => b.type === 'image').map((b) => b.src);
        aiRaw = await answerHomeworkWithAI(questionContent, images, isSingle, false);
      }
      panelNotify('quiz', { phase: 'done', aiOutput: aiRaw });
    } catch (e) {
      panelNotify('error', e?.message || 'AI 答题失败');
      return false;
    }

    const letters = parseAnswerLetters(aiRaw);
    const optionContainers = [...container.querySelectorAll('.flex.items-center.gap-4.user-select.group')];
    for (const letter of letters) {
      // 1. Try matching by letter text inside circle (cleaning non-alphabetic characters)
      let targetOption = optionContainers.find(opt => {
        const circle = opt.querySelector('.font-AP-65');
        if (!circle) return false;
        const circleLetter = circle.innerText.replace(/[^A-Za-z]/g, '').toUpperCase();
        return circleLetter === letter;
      });

      // 2. Fallback to index-based mapping if circle text match fails
      if (!targetOption) {
        const idx = letter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < optionContainers.length) {
          targetOption = optionContainers[idx];
        }
      }

      if (targetOption) {
        click(targetOption);
        await waitFor(() => {
          const circle = targetOption.querySelector('.font-AP-65');
          return circle && (circle.classList.contains('bg-mainBg') || circle.classList.contains('text-white')) ? true : null;
        }, 3000);
      }
    }

    const nextUnansweredBtn = getHomeworkUnansweredButton();
    if (nextUnansweredBtn) {
      click(nextUnansweredBtn);
      // Let the browser start processing the click and mount the spinner
      await sleep(10);

      // Wait for any active loading spinner to disappear
      await waitFor(() => !document.querySelector('.el-loading-spinner'), 10000);

      const changed = await waitFor(() => {
        const curContainer = document.querySelector('.question-area-content');
        if (!curContainer) return null;
        const text = curContainer.innerText.trim();
        if (text === oldText) return null;
        // Also ensure options of the new question have rendered and contain text
        const opts = curContainer.querySelectorAll('.flex.items-center.gap-4.user-select.group');
        if (opts.length === 0) return null;
        const imgs = curContainer.querySelectorAll('img');
        if ([...imgs].some(img => !img.complete)) return null;
        return opts[0].innerText.trim() ? true : null;
      }, 8000);
      if (!changed) {
        panelNotify('error', '切换下一题失败');
        return false;
      }
    } else {
      if (isHomeworkCurrentAnswered()) {
        const submitBtn = getHomeworkSubmitButton();
        if (submitBtn) {
          click(submitBtn);
          return true;
        } else {
          panelNotify('error', '未找到提交作业按钮');
          return false;
        }
      } else {
        panelNotify('error', '题号答完但当前题目没有被勾选，请重试');
        return false;
      }
    }
  }
  return false;
}

export async function runHomeworkFlow() {
  if (unsafeWindow.__ZHS_CHAIN_RUNNING) return;
  unsafeWindow.__ZHS_CHAIN_RUNNING = true;
  panelNotify('start');
  try {
    panelNotify('screen', SCREENS.QUIZ);
    const success = await runHomeworkQuiz();
    if (success) {
      panelNotify('hop', { screen: SCREENS.QUIZ, action: '作业答题完成并已提交！' });
    } else {
      panelNotify('error', '未识别到题目页面，或答题中断');
    }
  } catch (e) {
    panelNotify('error', e?.message || '作业答题发生错误');
  } finally {
    unsafeWindow.__ZHS_CHAIN_RUNNING = false;
    setLoopKey(false);
    panelNotify('done');
  }
}

// const waitImgLoad = (img) => {
//   return new Promise((resolve, reject) => {
//     if(img.complete){
//       resolve();
//       return;
//     }
//     img.onload = ()=>{
//       resolve();
//     }
//     img.onReject = (e) => {
//       reject(e);
//     }
//   })
// }

