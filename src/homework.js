import { SCREENS } from './constants.js';
import { setLoopKey, sleep } from './utils.js';
import { waitFor, click, getQuestionBlocks, blocksToMarkdown } from './dom.js';
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
export const buildHomeworkQuizMessages = (questionText, images, attempt, chatState, isSingle = true) => {
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
    const content = [{ type: 'text', text: `完整题目与选项内容如下：\n\n${questionText}` }];
    images.forEach((src) => content.push({ type: 'image_url', image_url: { url: src } }));
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

export const answerHomeworkWithAI = async (questionText, images, isSingle) => {
  const { raw } = await requestAI(
    (attempt, chatState) => buildHomeworkQuizMessages(questionText, images, attempt, chatState, isSingle),
    (raw) => isValidHomeworkAnswer(raw)
  );
  return raw;
};

// Homework automation flow
export async function runHomeworkQuiz() {
  while (!unsafeWindow.__ZHS_STOP) {
    const container = await waitFor(() => {
      const el = document.querySelector('.question-area-content');
      return el && el.innerText.trim() ? el : null;
    }, 15000);

    if (!container) return false;

    const oldText = container.innerText;
    panelNotify('quiz', { phase: 'start' });

    const blocks = await getQuestionBlocks(container);
    const questionContent = blocksToMarkdown(blocks);
    const images = blocks.filter((b) => b.type === 'image').map((b) => b.src);
    const typeEl = document.querySelector('.text-green');
    const isSingle = !!(typeEl && typeEl.innerText.includes('单选'));

    let aiRaw;
    try {
      aiRaw = await answerHomeworkWithAI(questionContent, images, isSingle);
      panelNotify('quiz', { phase: 'done', aiOutput: aiRaw });
    } catch (e) {
      panelNotify('error', e?.message || 'AI 答题失败');
      return false;
    }

    const letters = parseAnswerLetters(aiRaw);
    const optionContainers = [...container.querySelectorAll('.flex.items-center.gap-4.user-select.group')];
    for (const letter of letters) {
      const targetOption = optionContainers.find(opt => {
        const circle = opt.querySelector('.font-AP-65');
        return circle && circle.innerText.trim().toUpperCase() === letter;
      });

      if (targetOption) {
        click(targetOption);
        await waitFor(() => {
          const circle = targetOption.querySelector('.font-AP-65');
          return circle && circle.classList.contains('bg-mainBg') ? true : null;
        }, 3000);
      }
    }

    const nextUnansweredBtn = getHomeworkUnansweredButton();
    if (nextUnansweredBtn) {
      click(nextUnansweredBtn);
      const changed = await waitFor(() => {
        const curContainer = document.querySelector('.question-area-content');
        return curContainer && curContainer.innerText.trim() !== oldText ? true : null;
      }, 5000);
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
