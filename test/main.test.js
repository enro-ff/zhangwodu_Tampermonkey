import { vi } from 'vitest';

// Setup global mocks before importing any script files
const store = new Map();
const windowMock = {
  location: {
    href: 'https://ai-smart-course-student-pro.zhihuishu.com/course/123'
  }
};

globalThis.window = windowMock;
globalThis.unsafeWindow = { __ZHS_STOP: false };
globalThis.GM_getValue = (key, def) => store.has(key) ? store.get(key) : def;
globalThis.GM_setValue = (key, val) => { store.set(key, val); };
globalThis.GM_registerMenuCommand = vi.fn();

// Now statically import the source modules
import { describe, it, expect, beforeEach } from 'vitest';
import * as utils from '../src/utils.js';
import * as api from '../src/api.js';

describe('Modular source tests', () => {
  beforeEach(() => {
    store.clear();
    windowMock.location.href = 'https://ai-smart-course-student-pro.zhihuishu.com/course/123';
    globalThis.unsafeWindow.__ZHS_STOP = false;
  });

  describe('getPageUrlKey', () => {
    it('should extract path correct for student-pro domain', () => {
      windowMock.location.href = 'https://ai-smart-course-student-pro.zhihuishu.com/course/123/play';
      expect(utils.getPageUrlKey()).toBe('course_123_play');
    });

    it('should return root for home page url', () => {
      windowMock.location.href = 'https://studentexamcomh5.zhihuishu.com/';
      expect(utils.getPageUrlKey()).toBe('root');
    });

    it('should return unknown for invalid URL', () => {
      windowMock.location.href = 'invalid-url';
      expect(utils.getPageUrlKey()).toBe('unknown');
    });
  });

  describe('retry keys', () => {
    it('should generate makeRetryKey correctly', () => {
      windowMock.location.href = 'https://ai-smart-course-student-pro.zhihuishu.com/course/123';
      expect(utils.makeRetryKey(3)).toBe('zhs_retry_course_123_3');
    });

    it('should generate makeRetryMaxKey correctly', () => {
      windowMock.location.href = 'https://ai-smart-course-student-pro.zhihuishu.com/course/123';
      expect(utils.makeRetryMaxKey()).toBe('zhs_retry_max_course_123');
    });
  });

  describe('loop logic', () => {
    it('should return false initially', () => {
      expect(utils.isLoopOn()).toBe(false);
    });

    it('should turn loop on', () => {
      utils.setLoopKey(true);
      expect(utils.isLoopOn()).toBe(true);
    });

    it('should turn loop off when false passed', () => {
      utils.setLoopKey(true);
      utils.setLoopKey(false);
      expect(utils.isLoopOn()).toBe(false);
    });

    it('should turn loop off if __ZHS_STOP is true', () => {
      globalThis.unsafeWindow.__ZHS_STOP = true;
      utils.setLoopKey(true);
      expect(utils.isLoopOn()).toBe(false);
    });
  });

  describe('AI answer validation and parsing', () => {
    it('should validate answers correctly with optionCount', () => {
      expect(api.isValidQuizAnswer('答案：A', 4)).toBe(true);
      expect(api.isValidQuizAnswer('答案：D', 4)).toBe(true);
      expect(api.isValidQuizAnswer('答案：E', 4)).toBe(false);
      expect(api.isValidQuizAnswer('答案：AB', 4)).toBe(true);
      expect(api.isValidQuizAnswer('答案：ABC', 3)).toBe(true);
      expect(api.isValidQuizAnswer('答案：ABCD', 3)).toBe(false);
      expect(api.isValidQuizAnswer('一些思考...答案: B', 4)).toBe(true);
      expect(api.isValidQuizAnswer('选项不对', 4)).toBe(false);
    });

    it('should parse answer letters correctly', () => {
      expect(api.parseAnswerLetters('答案：A')).toEqual(['A']);
      expect(api.parseAnswerLetters('答案：ABC')).toEqual(['A', 'B', 'C']);
      expect(api.parseAnswerLetters('思考...答案: B')).toEqual(['B']);
      expect(api.parseAnswerLetters('无符合格式 of 答案')).toEqual([]);
    });

    it('should parse single answer letter correctly', () => {
      expect(api.parseAnswerLetter('答案：A')).toBe('A');
      expect(api.parseAnswerLetter('答案:B')).toBe('B');
      expect(api.parseAnswerLetter('答案：ABC')).toBe('A');
      expect(api.parseAnswerLetter('无答案')).toBeNull();
    });
  });

  describe('threshold and pct parsing', () => {
    it('should get threshold value', () => {
      expect(utils.getThreshold()).toBe(80);
      globalThis.GM_setValue('zhs_threshold', 75);
      expect(utils.getThreshold()).toBe(75);
    });

    it('should parse percentage correctly', () => {
      const mockEl = { innerText: '掌握度: 75%' };
      expect(utils.parsePct(mockEl)).toBe(75);
      expect(utils.parsePct({ innerText: '80' })).toBe(80);
      expect(utils.parsePct(null)).toBeNaN();
    });
  });
});
