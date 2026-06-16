import esbuild from 'esbuild';
import fs from 'fs';

const header = `// ==UserScript==
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
`;

async function build() {
  const result = await esbuild.build({
    entryPoints: ['src/index.js'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
  });
  
  const outputCode = result.outputFiles[0].text;
  const finalCode = header + '\n' + outputCode;
  
  fs.writeFileSync('main.js', finalCode, 'utf8');
  console.log('Build completed successfully!');
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
