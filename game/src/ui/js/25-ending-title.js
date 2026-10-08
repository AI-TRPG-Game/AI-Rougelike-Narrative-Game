// ═══════════════════════════════════════════════════════════════════
// 结局全屏演出（2026-10-06 用户裁定：「为结局做**专门的全屏动画**，
// 而不是简单的弹窗」）
//
// ⚠️ **为什么不用 `#overlay`（档 A 弹窗 / 详情）那一套**：
//    那一套是"**遮挡**世界"（模糊 ＋ 压暗 ＋ 一张卡片居中"）—— 那是"打断"；
//    结局是"**这一局结束了**" ⇒ 它该**接管整个屏幕**、把世界收进暗里再放开。
//    ⇒ 独立 DOM（`#endingscreen`）＋ 独立 CSS ＋ 独立状态（`endingPlayed`）。
//
// ⚠️ **两段式（成功结局）**：判定落账那一刻**标题就有值**了
//    （`rules/ending.ts·finalEndingOf` 现在当场写 `title` —— 2026-10-06 起
//    标题不再由 LLM 给）⇒ **先把标题演出掉**，判词后到再补上。
//    失败结局**没有第二段**（系统预写话术，判定时就已经齐了）。
//
// ⚠️ **可跳过**：长文本必须能跳过（`prefers-reduced-motion` 那条已经兜了一层，
//    但玩家的主动点击也要能立刻出全文）。
// ═══════════════════════════════════════════════════════════════════

/** 这一局的结局**已经播过没有（页面上的临时状态 —— 读档/重渲染都不该重播） */
let endingPlayed = false;
/** 结局层当前有没有开着的（`render()` 用它判断"要不要重播"） */
let endingBusy = false;
/** 「正在逐字浮现」那个定时器的游标（点跳过时清掉它） */
let endingTyping = 0;

/**
 * 结局正文 —— **前端这一份是兜底**。
 *
 * ⚠️ 服务端 `ui/session.ts·endingText` 是同一口径的**正本**，但那个文件是 TS 模块、
 *    **浏览器端 import 不到** ⇒ 这一份必须自己写（前端本来就是零构建、零依赖）。
 *    ⚠️ 两边**判据要一致**：有 `text` 就用它；没有 ⇒ 给一句占位，而不是空白。
 *    ⚠️ 占位那句话**不能剧透**（别写"LLM 没写出来"这种系统话）——
 *    玩家看到的是"这一局还没有留下判词"，那本身就是这一局的状态。
 */
function endingText(e){
  if (e && e.text) return e.text;
  const nm = (e && e.name) || '结局';
  const d = (e && e.day) || 0;
  return '第 ' + d + ' 天。这一局停在这里，' + nm + '——还没有人替它写下收尾的那一段。';
}

/** 关掉结局层（跳过 / 播完都走它） */
function hideEnding(){
  const el = $('endingscreen');
  if (el) el.classList.add('hidden');
  endingBusy = false;
  if (endingTyping) { clearInterval(endingTyping); endingTyping = 0; }
}

/**
 * 演一遍结局。
 *
 * @param e   `view.ending`（`UiEnding`）—— 判据都在这儿，**不由本函数判定**
 * @param opts.pre   已经齐了（失败结局 / 判词已到）⇒ 不做"等判词"那一步
 * @param opts.text  判词正文（**可后到**）；不给就用 `endingText(e)`
 */
function playEnding(e, opts){
  opts = opts || {};
  const el = $('endingscreen');
  if (!el || !e) return;
  // ⚠️ 同一局**只播一次**：`endingPlayed` 是判据（不是"这一帧有没有 DOM"）
  //    —— 后台切页/重渲染会反复调 `render()`。
  if (endingPlayed || endingBusy) return;
  endingPlayed = true;
  endingBusy = true;

  const failed = e.kind !== '成功';
  // ⚠️ **系统词一律不进这一屏**：「风味 A」「第 28 天 · 欲念 ∈…」这些是给开发者看的。
  //    这一屏只留：结局名 ＋ 标题 ＋ 判词。
  const title = e.title || e.name;
  const kicker = failed ? '这一局到此为止' : '第 ' + e.day + ' 天 · 终局';
  const txt = tidyProse(opts.text || endingText(e));

  el.className = failed ? 'es-fail' : '';
  el.innerHTML =
    '<div class="es-kicker">' + esc(kicker) + '</div>' +
    '<h1 class="es-title">' + esc(title) + '</h1>' +
    // ⚠️ 2026-10-08 用户裁定「两个重复标题」：失败结局账本里的 `title` 是 null
    //    （`fromFailure` 只写 name），上面 `title = e.title || e.name` 已回落成结局名
    //    ⇒ 大标题与副标题会是**同一个词**（截图里两个「陨命」）。两者相同 ⇒ 副标题不渲染；
    //    只有成功结局（风味标题 ≠ 结局名）才出这行小字。
    (title === e.name ? '' : '<div class="es-sub">' + esc(e.name) + '</div>') +
    '<div class="es-rule"></div>' +
    '<div class="es-text" id="es-text"></div>' +
    '<div class="es-skip" id="es-skip">点一下 · 立即显示全文</div>' +
    // ⚠️ 2026-10-07 用户裁定：结局画面要有**出口** —— 看完回到标题屏，
    //    不必刷新页面。走服务端现成的 `/api/title`（与「保存并退出」同一条路）。
    '<div class="es-exits"><button data-act="endTitle">回到开局</button></div>';
  el.classList.remove('hidden');

  // 逐字浮现：先全暗，再一段段点亮（**跳过时立刻全亮并停掉定时器**）
  // ⚠️⚠️ 2026-10-08 修「结算后结局正文一片空白」：原来每个 span 都是**空壳**
  //    （`chars.map(() => '<span></span>')` —— 字符从未进 DOM，点亮的只是
  //    一排看不见的 opacity），玩家只能靠点一下跳过才看到全文。
  //    ⇒ span 里真正填字符；`\n` 不进 span（inline 里会折叠），换成 `<br>`。
  const box = $('es-text');
  if (box) {
    box.classList.add('es-typing');
    const chars = Array.from(txt);
    box.innerHTML = chars.map((c) => (c === '\n' ? '<br>' : '<span>' + esc(c) + '</span>')).join('');
    const spans = box.querySelectorAll('span');
    let i = 0;
    // ⚠️ 一段一段（不是一个字一个字）—— 太快看不清，太慢读不完
    const step = Math.max(1, Math.ceil(chars.length / 34));
    endingTyping = setInterval(() => {
      for (let k = 0; k < step && i < spans.length; k++, i++) spans[i].classList.add('on');
      if (i >= spans.length) { clearInterval(endingTyping); endingTyping = 0; }
    }, 42);
  }
  // 点一下 ⇒ 立即出全文（不必等）
  el.onclick = () => {
    if (endingTyping) {
      clearInterval(endingTyping);
      endingTyping = 0;
      const box2 = $('es-text');
      if (box2) { box2.classList.remove('es-typing'); box2.textContent = txt; }
    }
    const skip = $('es-skip');
    if (skip) skip.textContent = '这一局结束了';
  };
  // ⚠️ 键盘也能跳（无障碍：能不靠鼠标关掉的东西，就别只靠鼠标）
  const onKey = (ev) => {
    if (ev.key === 'Escape' || ev.key === ' ' || ev.key === 'Enter') {
      el.onclick && el.onclick();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
}

/**
 * 结局的**第二段** —— 判词后到时，把它补上（**不重播标题**）。
 *
 * ⚠️ **为什么要分两段**（2026-10-06 用户裁定）：
 *   成功结局的判词由 `ending` 侧链**异步**写（`turn/ending.ts·writeEnding`），
 *   而**标题在 `finalEndingOf` 判定那一刻就有值了**（标题不再由 LLM 给）。
 *   ⇒ 若等判词齐了才播 ⇒ 玩家盯着一段空白等网络；
 *     若不等 ⇒ 播出一段占位字，然后被真判词顶替（更糟）。
 *   ⇒ 拆两段：**标题 ＋ 结局名先演**，判词到了再把正文那一块换掉。
 *
 * ⚠️ **失败结局不走这里**（系统预写话术，判定时已齐 ⇒ 一次播完）。
 */
function endingSecondHalf(e){
  const box = $('es-text');
  if (!box) return;                       // 玩家已经跳过了/关掉了 ⇒ 不补
  const txt = endingText(e);
  if (endingTyping) { clearInterval(endingTyping); endingTyping = 0; }
  box.classList.remove('es-typing');
  box.textContent = txt;
  // 逐字重演一次（判词是这一局最后该被看见的东西）
  // ⚠️ 2026-10-08 与 playEnding 同修：span 里填字符、`\n` 换 `<br>`（空壳 span 的教训见上）
  const chars = Array.from(txt);
  box.innerHTML = chars.map((c) => (c === '\n' ? '<br>' : '<span>' + esc(c) + '</span>')).join('');
  const spans = box.querySelectorAll('span');
  let i = 0;
  const step = Math.max(1, Math.ceil(chars.length / 34));
  endingTyping = setInterval(() => {
    for (let k = 0; k < step && i < spans.length; k++, i++) spans[i].classList.add('on');
    if (i >= spans.length) { clearInterval(endingTyping); endingTyping = 0; }
  }, 42);
  const skip = $('es-skip');
  if (skip) skip.textContent = '点一下 · 立即显示全文';
}

function resetLocalViewState(){
  // ⚠️⚠️ 2026-10-06：结局层的三个状态**也要归零** —— 否则开第二局时
  //    `endingPlayed` 还是 true ⇒ **新那一局的结局永远播不出来**（静默失效最难查）。
  //    同 `handled` / `histMore` 那几条：一个都不能漏。
  endingPlayed = false;
  endingBusy = false;
  if (endingTyping) { clearInterval(endingTyping); endingTyping = 0; }
  const es = $('endingscreen');
  if (es) { es.classList.add('hidden'); es.className = 'hidden'; es.onclick = null; es.innerHTML = ''; }
  picks = {};
  // ⚠️⚠️ 2026-10-06 清单第 4B 条：「你的欲望」四行卡槽**也要归零** ——
  //    否则上一局放进去的凭证会挂在新一局的卡位上，而那些凭证在新账本里根本不存在
  //    （`vSlots` 找不到对应记录 ⇒ 卡位显示成空的，而 `vPicks` 还占着位）。
  vPicks.slots = null;
  try { localStorage.removeItem(VPERSIST_KEY); } catch (e) {}   // 换局/读档 ⇒ 持久化的格子一并清（新账本里没有那些凭证）
  popupResults = [];
  // 骰子动画弹窗的押注态跟着清（换局后没有"正在看的骰"可言）。
  diceState = { entry: null, rolled: false, done: false };
  // 刚处理完、还没点「确认」的那一条（`handled`）也是局内临时状态：
  // 不清的话，读另一局回来会先弹一张**上一局**的事件的"你做了这一步"。
  handled = null;
  // 结算游标也要归零：下一局的第一份信封会把游标推到它的长度（历史不重播）。
  feedCursorReady = false;
  feedShown = 0;
  // ⚠️ 2026-10-07：读档的「跳过一次重播」标记也在这里清 ——
  //    读档失败（服务器回错、屏留在 title）时它已经置真，不清的话
  //    下一次**开新局**的序幕新结果会被误当"该跳过的历史"吞掉。
  feedCursorSkipOnce = false;
  slots = { 成果: '', 手段: '', 共鸣: '' };
  // 历史展开了多少也算"局内临时状态"—— 不清的话，读另一局回来会带着上一局展开的清单。
  // ⚠️ 这一份**必须与顶上那处声明逐字一致**（同一个状态两处初始化 —— 漏一个键，
  //    那一栏的「展开」按钮就点不动：`moreHist` 的判据是 `if (!(k in histMore)) return;`）。
  histMore = { people: 0, peopleOut: 0 };
  // 事件卡展开了哪几条、那个面板开着没有、面板里写着什么 —— 同样是局内的临时状态。
  openCards = {};
  composeOpen = false;
  composeText = '';
  detailOpen = null;
  // ⚠️ 2026-10-08（用户第 3 条）：觉醒后的「自动弹欲望面板」待办也是局内一次性状态 ——
  //    回标题屏就作废（下一局要弹自然有新的 pickCommit 置位）。
  desireIntroPending = false;
  desireIntroToastWanted = false;
  // ⚠️ 2026-10-08（用户第 5 条）：难度弹窗也是局内一次性页面态 —— 回标题屏就作废
  //   （下一局要选自然有新的 pickCommit 置位；账本里的 difficulty 才是事实）。
  difficultyOpen = false;
  difficultyPicked = 0;
  // ⚠️ 2026-10-07 用户第 3 条：「尚未入队」那块弹窗里**选中的是哪个人**也是页面态 ——
  //   不清的话，读另一局回来右边会先显示**上一局那个人**的详情（而他在新账本里可能不存在）。
  outSel = null;
  // 被点开的档 A（2026-10-05）：也是局内临时状态 —— 不清的话，读另一局回来
  // 会先弹出一张**上一局**事件的"你当场就得拿主意"。
  popupOpenId = '';
  // 开局选择面板的本地草稿（2026-10-05）：同样是局内临时状态。
  // ⚠️ 清成"空"（`pickKit = -1` ＝ 未选）而不是某个默认值 —— "没选过"与"选了第 0 条"
  //    是两回事，混起来读档回来会假装玩家已经选好了。
  pickKit = -1;
  // 固定功能事件的页面态（2026-10-07）：换局/读档清空 —— 人是上一局的人了。
  fixPicks['医馆'] = '';
  fixPicks['大神殿'] = '';
  fixGold['医馆'] = false;
  fixGold['大神殿'] = false;
  // ⚠️ 2026-10-06：三步流程的**阶段**也要跟着清（与 `pickKit` 同一处，见用户裁定问题 5/6/7）
  pickStage = '';
  pickAdv = {};
  // 拖拽的半途状态：按住不放的时候切存档 / 读档 ⇒ 那张幽灵小纸片会永远挂在屏幕上
  dragSrc = null;
  dragMoved = false;
  justDragged = false;
  dragEnd();
  // 画布的平移/缩放（2026-10-05）：同样是**页面上的临时状态**，账本里没有。
  // ⚠️ 不清的话，读另一局回来会看到"上一局被我推到哪儿了"的视角 —— 那是上一局的地图。
  cvPan = null;
  cvView = { scale: 1, x: 0, y: 0 };
  if (document.body && document.body.classList) document.body.classList.remove('panning');
  applyCanvasView();
}

/** 槽位编号（罗马数字 —— 只用来给人看，槽号本身仍是 0~3） */
const SLOT_NO = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'];

/**
 * 王徽 —— 塞兰的「两半轮子」：上半天轮实描（已走过的），下半虚描（还没到的）。
 * ⚠️ 纯 SVG 内联：不引外部图片（换设备 / 断网都照样画得出来）。
 *
 * ⚠️ 2026-10-05（暗色）：三处改动，**形状与含义一字未改** ——
 *   ① 尺寸 100 → **152**：它在暖白底上只是个 100px 的小饰物，
 *      在暗底封面上必须是**画面的主体**（业界：徽记/logo 是标题屏的视觉锚点）；
 *   ② 描边色换成**变量**（`--accent` / `--accent-2`）—— 原来写死 `#c9a86a` / `#b0813f`，
 *      那是**暖白底**上算出来的金，在暗底上偏暗偏脏；
 *   ③ 中心圆加了 `filter:drop-shadow` 的辉光（由 `.ts-sigil svg` 那条 CSS 承担）——
 *      暗底上纯线稿会"浮"不起来，得有一圈微光才像被照着。
 */
const SIGIL =
  '<svg viewBox="0 0 120 120" width="152" height="152" aria-hidden="true">' +
  '<circle cx="60" cy="60" r="54" fill="none" stroke="var(--accent-2)" stroke-width="1.2"/>' +
  '<circle cx="60" cy="60" r="47" fill="none" stroke="var(--accent-2)" stroke-width="0.8" stroke-dasharray="2 6" opacity=".75"/>' +
  '<path d="M20 60 A40 40 0 0 1 100 60" fill="none" stroke="var(--accent)" stroke-width="2.6"/>' +
  '<path d="M100 60 A40 40 0 0 1 20 60" fill="none" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="5 4" opacity=".8"/>' +
  '<circle cx="60" cy="60" r="8.5" fill="var(--accent)" opacity=".92"/>' +
  '</svg>';


/** 标题屏上那个"指定种子"输入框的值；没填 / 填 0 / 填了非数 ⇒ `undefined`（= 让后端随机） */
function seedValue(){
  const el = $('seedInput');
  if (!el) return undefined;
  const n = Number(el.value);
  if (String(el.value).replace(/\s/g, '') === '') return undefined;
  return (isFinite(n) && n !== 0) ? Math.trunc(n) : undefined;
}

/** ISO 时间 ⇒ `MM-DD HH:mm`（本地时区）。读不动就回空串 —— 一个坏时间戳不该让整张卡画不出来 */
function fmtWhen(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 一张存档卡（`s === null` ⇒ 空槽）。
 * ⚠️ 只印**摘要列**：这一屏**不解析**那份几十 KB 的快照 JSON（`SaveDb.list` 的设计意图）。
 * ⚠️ 欲念印 `desireBand` ＋ `desire`（**区间名 ＋ 数值**）—— 见 `renderTop` 顶栏那段（2026-09-22 用户裁定）。
 *
 * ⚠️ 2026-10-05（封面轮）：唯一改动是**给每张卡写一个 `--i`**（进场错开的序号）。
 *    `data-act`（`newGame` / `loadGame` / `askDelete`）、`data-slot`、文案、字段 ——
 *    **一个字节都没动**。动效由 CSS 的 `animation-delay:calc(.75s + var(--i) * 90ms)` 消费。
 */
function slotCardHtml(s, i){
  const head = '<div class="ts-no">存档 ' + (SLOT_NO[i] || (i + 1)) + '</div>';
  if(!s){
    return '<div class="ts-card blank" style="--i:' + i + '">' + head +
      '<div class="ts-name">空着</div>' +
      '<div class="ts-ops"><button class="primary" data-act="newGame" data-slot="' + i + '">开始新的一局</button></div>' +
    '</div>';
  }
  const bandCls = { 迷失:'lost', 常态:'norm', 窗口:'win', 沉溺:'indulge' }[s.desireBand] || 'norm';
  const total = (S.meta && S.meta.totalDays) ? S.meta.totalDays : 28;
  const when = fmtWhen(s.updatedAt);
  return '<div class="ts-card' + (s.ended ? ' over' : ' filled') + '" style="--i:' + i + '">' + head +
    '<div class="ts-name">' + esc(s.title) + '</div>' +
    '<div class="ts-meta"><span>第 <b>' + s.day + '</b> / ' + total + ' 天</span>' +
      '<span>第 <b>' + s.chapter + '</b> 章 · ' + esc(s.phase) + '</span></div>' +
    '<div class="ts-meta"><span>金币 <b>' + s.gold + '</b></span>' +
      '<span class="chip band ' + bandCls + '" title="欲念区间与数值">欲念 · ' + esc(s.desireBand) + ' <b>' + s.desire + '</b></span>' +
      '<span>HP <b>' + s.hp + '</b></span></div>' +
    (s.ended ? '<div class="ts-meta"><span class="chip" style="border-color:var(--gold-line)">已结束 · ' + esc(s.endingName || '') + '</span></div>' : '') +
    (when ? '<div class="ts-meta"><span>最后动作 ' + esc(when) + '</span></div>' : '') +
    '<div class="ts-ops">' +
      '<button class="primary" data-act="loadGame" data-slot="' + i + '">' + (s.ended ? '看结局' : '继续这一局') + '</button>' +
      '<button class="ghost" data-act="askDelete" data-slot="' + i + '">删除</button>' +
    '</div>' +
  '</div>';
}

/**
 * 标题屏整体 —— **封面**（2026-10-05）。
 *
 * ⚠️ 与改前的三处差别，**全在结构与包裹，不在内容**：
 *   ① 标题与副标题之间插了一条 `.ts-rule`（金色细线）—— 建立层级；
 *   ② 标题写 `data-t`（`.ts-title::after` 的 `content:attr(data-t)` 靠它做鎏金扫光）；
 *   ③ 底部说明整体降级（CSS 里换成 `--faint` ＋ 更宽的行距）。
 *   **四个存档槽、`data-act`、种子输入框、那三句说明的文案 —— 一字未改。**
 */
function renderTitle(){
  const meta = S.meta || {};
  const saves = arr(S.saves);
  const n = meta.slots || 4;
  const cards = [];
  for (let i = 0; i < n; i++) cards.push(slotCardHtml(saves[i] || null, i));
  const any = saves.filter(Boolean).length;
  $('titlescreen').innerHTML =
    '<div class="ts-wrap">' +
      '<div class="ts-sigil">' + SIGIL + '</div>' +
      '<div class="ts-title" data-t="塞兰王国三王子">塞兰王国三王子</div>' +
      '<div class="ts-rule"></div>' +
      // ⚠️⚠️ 2026-10-06 用户裁定：**删掉那一整块说明文字**（原话「这些废话也删掉」）。
      //   删的是：副标题「塞兰王国 · 金庭城 —— 你在两位兄长之后长大」、
      //   「四个槽都还空着 —— 挑一个开始。」、
      //   「每一局都是模型现写的：同一天、同一个槽，两次进去读到的措辞也不会一样。」、
      //   以及「这一局接的是真模型」那一行。
      //   ⇒ 只留**标题 ＋ 存档格 ＋ 种子输入框**（后者是功能，不是废话）。
      //   ⚠️ 大标题按裁定改成「**塞兰王国三王子**」（原来只是「王国三王子」）。
      //   ⚠️ 那个 `<div class="ts-sub">` 整条**删掉**（不是清空文字）——留着空元素
      //   会在标题与存档格之间留一段空隙，那正是"分块过多"的一部分。
      '<div class="ts-grid">' + cards.join('') + '</div>' +
      // ⚠️ 2026-10-08 用户裁定：**live 版（玩家版）不显示种子入口** —— 随机种子是开发调试
      //    用的，玩家不需要填（离线模式仍保留，方便复现与回归）。
      '<div class="ts-foot">' +
        (meta.live ? '' :
          '<div class="ts-seed">指定种子 ' +
            '<input id="seedInput" type="number" placeholder="留空 = 随机" style="width:118px">' +
          '</div>') +
      '</div>' +
    '</div>';
}

