import { AI_CHAT, AI_STATUS } from './constants.js';
import { getApiCfg, sleep } from './utils.js';
import { isMultipleChoice, getQuizOptions, click, clickUntilGone, waitFor, readQuestion } from './dom.js';

export const createAIChatState = () => ({
  status: AI_STATUS.IDLE,
  attempt: 0,
  lastRaw: '',
  lastError: null,
});

export const parseAnswerLetter = (raw) => {
  const match = (raw || '').match(/答案[：:]\s*([A-Z])/i);
  return match ? match[1].toUpperCase() : null;
};

export const isValidQuizAnswer = (raw, optionCount) => {
  const all = [...(raw || '').matchAll(/答案[：:]\s*([A-Z]+)/ig)];
  const last = all[all.length - 1];
  if (!last) return false;
  const letters = last[1].toUpperCase();
  return [...letters].every(l => {
    const idx = l.charCodeAt(0) - 65;
    return idx >= 0 && idx < optionCount;
  });
};

export const parseApiError = (res) => {
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

export const callAIOnce = (messages) =>
  new Promise((resolve, reject) => {
    console.log(messages, 'messages');
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
        max_tokens: apiCfg.maxTokens,
      }),
      timeout: apiCfg.timeoutMs,
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

export const requestAI = async (buildMessages, validate) => {
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

export const buildQuizMessages = (blocks, optLines, attempt, chatState, isMultiple = false) => {
  const memory = chatState.memory || [];
  const answerFmt = isMultiple
    ? '最后一行必须以"答案：X"的格式输出，X 为多个连续字母（对应所有正确选项，例如"ABC"表示选A、B、C三个选项）'
    : '最后一行必须以"答案：X"的格式输出，X 只能为单个字母（对应正确选项）';

  if (!memory.length) {
    memory.push({
      role: 'system',
      content: `你是一个专业的做题助手，你的任务是根据用户的题目，生成符合要求的选项，请逐步用平文本思考并选出正确答案的选项。${answerFmt}。`
    });
  }
  if (attempt > 1 && chatState.lastRaw) {
    memory.push({
      role: 'assistant',
      content: chatState.lastRaw,
    });
  }
  if (memory.length < 2) {
    const blocksToMarkdown = (blks) =>
      blks.map((b) => (b.type === 'text' ? b.content : `[IMAGE:${b.index}]`)).join('\n');
      
    const content = [{ type: 'text', text: `题目：\n\n${blocksToMarkdown(blocks)}\n\n选项：\n${optLines.join('\n')}` }];
    blocks
      .filter((b) => b.type === 'image')
      .forEach((b) => content.push({ type: 'image_url', image_url: { url: b.src } }));
    memory.push({
      role: 'user',
      content
    });
  }

  if (attempt > 1) {
    memory.push({
      role: 'user',
      content: `\n\n你上次回答不合规（需以"答案：X"结尾且 X 为有效选项字母），有可能是因为回答太长截断。请你简短的总结上一次的回答思路（不超过3句话），按更短的链路继续上次的思路回答`,
    });
  }

  return memory;
};

export const parseAnswerLetters = (raw) => {
  const all = [...(raw || '').matchAll(/答案[：:]\s*([A-Z]+)/ig)];
  const last = all[all.length - 1];
  return last ? [...last[1].toUpperCase()] : [];
};

export const answerWithAI = async (blocks) => {
  const mc = isMultipleChoice();
  const opts = getQuizOptions();
  if (!opts.length) return null;

  const optLines = opts.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt.innerText.trim()}`);
  const { raw } = await requestAI(
    (attempt, chatState) => buildQuizMessages(blocks, optLines, attempt, chatState, mc),
    (raw) => isValidQuizAnswer(raw, opts.length),
  );

  const letters = parseAnswerLetters(raw);
  for (const letter of letters) {
    const idx = letter.charCodeAt(0) - 65;
    const targetOpt = opts[idx];
    if (!targetOpt) continue;
    if (mc) {
      if (!targetOpt.classList.contains('is-checked')) {
        click(targetOpt);
        await waitFor(() => targetOpt.classList.contains('is-checked') ? true : null, 3000, 50);
      }
    } else {
      const oldClass = targetOpt.className;
      await clickUntilGone(() => {
        return targetOpt.className === oldClass ? targetOpt : null;
      }, 3000);
    }
  }
  return raw;
};
