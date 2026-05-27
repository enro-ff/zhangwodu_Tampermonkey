# 智慧树掌握度 · 最小链路油猴脚本

script.js:只有脚本，无任何dom注入纯净版。自己改apikey。

自动刷「掌握度不足 80%」的知识点：入口选题为 → AI 答题 → 提交 → 返回列表 → 循环下一题。  
采用 **DOM 探测当前屏 + 单步 hop 推进**；每次点击会触发 SPA 路由跳转（**不刷新页面**）。

> **关于 class 名**：下列 CSS 选择器来自实际页面抓取，**不一定稳定或完全准确**。  
> 维护时请以「页面语义 / 按钮文案 / 所在界面」为主，选择器为辅。README 里每步都写了界面含义，方便对照 DevTools 修正。

---

## 使用

### 页内控制面板（main.js）

进入匹配页面后，右下角会出现 **掌握度链路** 浮动面板：

| 功能 | 说明 |
|------|------|
| 链路步骤条 | 高亮当前屏：列表 → 详情 → 提升入口 → 答题 → 成绩 |
| 状态标签 | 运行中/已停止、循环开/关、当前页面 |
| 开始/继续、停止 | 与油猴菜单等价，**需手动点击才会执行** |
| 操作日志 | 最近 30 条（如 AI 答题、选中低分题、提交） |
| 折叠 | 点 `−` 收成 **ZHS** 圆钮；点击圆钮展开 |
| 拖拽 | 标题栏或 ZHS 圆钮可拖动；位置会记住 |

### 油猴菜单

| 菜单 | 作用 |
|------|------|
| **最小链路：开始/继续** | 任意界面均可：开启循环，从当前屏接着跑 |
| **最小链路：停止** | 停止并关闭循环 |

持久化：`zhs_loop`（循环开关）、`zhs_panel_pos`（面板位置）、`zhs_panel_collapsed`（是否折叠）。**不存**步骤状态；刷新后靠 DOM 重新识别当前屏。

**不会自动执行**：页面加载 / 刷新后脚本处于待命，必须手动点 **「开始/继续」**（面板或菜单）才会跑。

---

## 总链路（5 屏 + QUIZ 内 2 子阶段）

```text
LIST ──选低分题──► DETAIL ──去提升──► PRE_QUIZ ──开始提升──► QUIZ ──提交──► RESULT
  ▲                  │                                              │
  │                  │         RESULT 退出链：                       │
  │                  │         backup-icon → 小箭头 → 仍落到 DETAIL   │
  │                  └◄──── DETAIL 再点小箭头退回 ────────────────────┘
  └──────── loop 有 <80% 题
```

**注意**

- **不要用 `.backup-icon` 判断 RESULT**：PRE_QUIZ 页也有该元素，RESULT 用 **`.charts-rate`**（正确率/得分图表）识别。
- **不要把 `w-[32px] h-[32px] cursor-pointer` 单独当成一屏**：它只是退出用的点击目标；点完最后一次小箭头后 **路由仍落在 DETAIL**，不是 LIST。
- **DETAIL 有两种走法**（靠 `expectDetailForward` 区分）：
  - 从 LIST 点低分题进来 → 点「去提升」
  - 脚本首次进入 / RESULT 退出链落点 → **先点返回退回 LIST**，再继续正常循环

每次 hop 只推进一步，等 ~200ms 给 SPA 渲染，再 `detectScreen()` 决定下一屏。

---

## 屏状态详解

探测顺序（**从流程靠后往前**，避免路由过渡帧误判）：

`RESULT` → `QUIZ` → `PRE_QUIZ` → `DETAIL` → `LIST`

**不单独探测** `backup-icon` / 小箭头为独立屏——它们只是 RESULT / DETAIL 上的退出点击目标。

---

### LIST · 掌握度列表页

**界面含义**：课程/章节掌握度总览，多个环形进度条，显示百分比。

| 用途 | 选择器 / 逻辑 | 说明 |
|------|---------------|------|
| 识别本屏 | `.el-progress--dashboard` 且 `innerText` 含数字 | 掌握度环形进度组件 |
| 等待数据 | 同上，`/\d+/` 匹配百分比 | 等待面板异步加载出数字 |
| 是否有活 | 遍历 `.el-progress--dashboard`，解析数字 **< 80** | 掌握度不足 80% 才需要刷 |
| 本步点击 | 第一个 `< 80` 的 `.el-progress--dashboard` | **点击掌握度不足 80% 的题目**，直到该目标消失（进入下一屏） |
| 结束循环 | 回到 LIST 且没有任何 `< 80` 的项 | 自动 `zhs_loop = false` |

对应代码：`runListHop()`、`findLowPctProgress()`、`hasListWork()`

---

### DETAIL · 知识点掌握度详情页

**界面含义**：单个知识点的掌握度详情，有「去提升」类入口。也是 **RESULT 退出链的最终落点**（点小箭头后会回到这里，而不是 LIST）。

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 识别本屏 | `.simplified-mastery__action` | 简化掌握度卡片上的操作区 |
| 前进点击 | `.simplified-mastery__action` | 从 LIST 点低分题进来后：**点击「去提升」** |
| 退出点击 | `[class*="w-[32px]"][class*="h-[32px]"].cursor-pointer` | 脚本首次进入、或 RESULT 退出链落点：**点小箭头退回 LIST** |

**`expectDetailForward` 标志**

| 值 | 含义 | DETAIL 上做什么 |
|----|------|-----------------|
| `true` | 上一步 LIST 刚点了低分题 | `runDetailHop()` → 去提升 |
| `false` | 脚本刚启动 / RESULT 退出后落到 DETAIL | `runDetailExitHop()` → 先退回 LIST |

对应代码：`runDetailHop()`、`runDetailExitHop()`

---

### PRE_QUIZ · 提升入口 / 预答题页

**界面含义**：进入刷题前的中间页，有「提升」「开始」类按钮。页上可能有 `.backup-icon`，**与 RESULT 不是同一页**。

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 识别本屏 | `.improve-btn` | 提升/开始按钮 |
| 本步点击 | `.improve-btn` | **狂点「提升 / 开始」按钮**，直到消失，进入正式答题页 |

对应代码：`runPreQuizHop()`

---

### QUIZ · 答题 + 提交（同一屏状态，两个子阶段）

**界面含义**：正式做题页。答完所有题后仍在同一 SPA 流程内，会出现提交钮。**不单独设 EXIT 状态**。

#### 子阶段 1：答题（原 B 段）

| 用途 | 选择器 / 逻辑 | 说明 |
|------|---------------|------|
| 识别本屏 | `.questionContent` 有非空 `innerText` | 题干容器；**不用 `.reviewDone` 探测**（提交钮可能常驻） |
| 等待就绪 | `.questionContent` + `ul.radio-view li` 有选项文案 | **答题前，确保题目和选项被 JS 异步渲染出来** |
| 读题 | `.questionContent` 内文本与 `IMG` | 送 AI；图片题会附带 `image_url` |
| 选项 | `ul.radio-view li` | 单选列表 |
| 点选 | 某个 `ul.radio-view li`（按 AI 返回的 A/B/C…） | 轮询点击直到 `className` 变化（选中态） |
| 当前题号 | `.letterSortNum` | **当前题号，避免侧栏还没更新就误点** |
| 未答题 | `.custom-tree-answer-normal.no-answer` | 侧栏答题树里标记未答的节点 |
| 切下一题 | `getMismatchNode()` 返回的侧栏节点 | **轮询点击未完成的题目**；若 `.questionContent` 文本已变，**说明已切到下一题，立即停止点击** |

`getMismatchNode()` 逻辑：在 `.no-answer` 列表里找题号（首字符）与 `.letterSortNum` 不一致的项。

#### 子阶段 2：提交（原 C 段，仍在 QUIZ）

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 何时提交 | `getMismatchNode()` 返回 `null` | **侧栏无其他未答题**时才提交；`.reviewDone` 可能一直存在，不能用它判断是否该提交 |
| 点击目标 | `.reviewDone.ZHIHUISHU_QZMD` | **狂点「完成查看 / 提交作业」**，直到消失 → 进入成绩页 |

流程：先答当前题 → `getMismatchNode()` 有值则切题 → 无值则点 `.reviewDone` 提交。

对应代码：`runQuizHop()`、`answerWithAI()`、`getMismatchNode()`

---

### RESULT · 成绩 / 结果页

**界面含义**：提交后展示正确率、得分的页面。

| 用途 | 选择器 | 说明 |
|------|--------|------|
| 识别本屏 | **`.charts-rate`** | 正确率/得分图表（**不用 `.backup-icon`**，PRE_QUIZ 也有） |
| 退出第 1 步 | `.backup-icon` | **成绩页退出按钮** |
| 退出第 2 步 | `[class*="w-[32px]"][class*="h-[32px]"].cursor-pointer` | 小箭头；**点后实际落到 DETAIL 而非 LIST** |

`runResultHop()` 连续执行上述两步；下一轮 hop 在 DETAIL 上走 `runDetailExitHop()` 退回 LIST。

对应代码：`runResultHop()`

---

## 核心机制

### `detectScreen()`

看当前 URL 对应哪一屏，**不读**持久化 step。任意界面点「开始/继续」都从这里续跑。

### `runFromHere()`

```text
expectDetailForward = false
while (loop 开启 && 未停止 && hop < 500)
  screen = detectScreen()
  runOneHop(screen, expectDetailForward)
  LIST 成功推进 → expectDetailForward = true
  DETAIL 且 expectDetailForward 且成功 → expectDetailForward = false
  sleep(200ms)
  若在 LIST 且无 <80% 题 → 关 loop
```

首次进入时 `expectDetailForward = false`：若当前在 DETAIL，会先执行 `runDetailExitHop()` 退回 LIST，再正常循环。

### `clickUntilGone(selector)`

**轮询点击直到元素不存在**（或动态函数返回 `null`）。  
若元素已不存在，直接判成功。默认 100ms 间隔、15s 超时。

### `waitFor(fn)`

被动等待 DOM / 条件就绪（如题目加载、提交钮出现）。

---

## AI 答题

- 接口：OpenAI 兼容 Chat Completions（脚本内 `API_CFG`）
- 要求模型最后一行输出 `答案：X`（X 为 A–Z 单字母）
- 最多重试 3 次（格式不对 / 网络 / 超时）
- 支持题干中的图片（`questionContent` 内 `IMG` → `image_url`）

---

## 调试建议

1. **先认界面，再改选择器**：对照上表「界面含义」和按钮文案，在 Elements 里找稳定节点。
2. **RESULT vs PRE_QUIZ**：看有没有 `.charts-rate`，不要只看 `.backup-icon`。
3. **DETAIL 误点「去提升」**：检查 `expectDetailForward` 是否为 false（应先退出）。
4. **过渡帧**：点击后 200ms 内可能同时存在新旧 DOM，`detectScreen` 按靠后优先级取屏。
5. **QUIZ 误提交**：确认是否因 `.reviewDone` 一直存在导致；应用 `getMismatchNode()` 判断是否答完。
6. **QUIZ 卡住**：看是「选项未渲染」还是「AI 失败」。
6. **LIST 不循环**：确认是否所有进度都已 ≥ 80%。
7. 控制台可查看 `unsafeWindow.__questionBlocks`（最近一次读题结构）。

---

## 文件

| 文件 | 说明 |
|------|------|
| `main.js` | 油猴脚本本体 |
