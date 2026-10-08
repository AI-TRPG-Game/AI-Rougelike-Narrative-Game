// ── 渲染 ────────────────────────────────────────────────────────
/**
 * **浮层的安全边界**（2026-10-07 用户第 1 条）：量出顶栏与「页脚＋手牌区」的真实高度，
 * 写进 `--ovtop` / `--ovbottom` 两个 CSS 变量 —— `#overlay.top` 用它们定自己的
 * 内边距与底边。事件台（及一切 `.top` 浮层）因此**永远**不遮声望系统（顶栏）与手牌区，
 * 换屏高 / 缩放窗口都不用再猜固定值。
 * ⚠️ 标题屏上 `#hand` 是 `display:none` ⇒ offsetHeight = 0，正好（那时也没有事件台）。
 */
function syncOverlayBounds(){
  const root = document.documentElement;
  const tb = document.querySelector('header');
  if (tb) root.style.setProperty('--ovtop', tb.offsetHeight + 'px');
  const ft = document.getElementById('footer');
  const hd = document.getElementById('hand');
  if (ft && hd) {
    root.style.setProperty('--ovbottom', (ft.offsetHeight + hd.offsetHeight + 10) + 'px');
  }
}

function render(){
  if(!S) return;
  // 渲染成功 ⇒ 撤掉启动兜底提示（慢后端的情况下它可能已经冒出来了）
  const bf = $('boot-fallback');
  if (bf && bf.parentNode) bf.parentNode.removeChild(bf);
  // ⚠️ 兜底脚本的判据是 `#topbar[data-ready=1]`，而标题屏上 `renderTop` **不会被调用**
  //    ⇒ 必须在这里统一设一次，否则标题屏会在 2.5 秒后冒出一句"页面没能渲染出来"。
  const tb = $('topbar');
  if (tb) tb.setAttribute('data-ready', '1');
  renderBanner();

  // ⚠️⚠️ 2026-10-06 修一个 **TDZ**：`const isTitle` 原来声明在**下面两处用它之后**
  //   （`document.body.classList.toggle('mode-title', isTitle)`）⇒ 抛
  //   `Cannot access 'isTitle' before initialization` ⇒ 整页白、只剩错误横幅。
  //   ⚠️ 成因：我给页面加调试入口时把这几行**连同 `if (isTitle)` 一起**挪了位置，
  //   声明却留在了原处 —— `const` 的暂时性死区。
  //   ⇒ 声明必须**在使用点之前**；这里放到 `renderBanner()` 之后立刻声明。
  const isTitle = S.screen === 'title';
  // ⚠️ 画哪一屏只看 `S.screen`（后端给的事实）—— **不拿"有没有 view"去猜**：
  //    "停在标题屏"与"后端没起来"这两种情况下 `view` 都是空的，猜不出来。
  if (document.body && document.body.classList) {
    document.body.classList.toggle('mode-title', isTitle);
    // ⚠️ `mode-game` 必须在**这里**跟着 `mode-title` 一起切，不能只在 `renderHand` 里 `add` ——
    //    那样回标题屏时它会**留在 body 上**，而 `#hand` 的内容还是上一局的人。
    //    两个 class 必须同一处成对切，"谁开谁关"才是同一件事。
    document.body.classList.toggle('mode-game', !isTitle);
  }
  if (isTitle) {
    renderTitle(); renderOverlay(null);
    // 顺手把手牌带**清空**（不靠 CSS 藏）：`innerHTML=''` 之后 DOM 里就没有那串 id 了
    //    ⇒ 下次进来若忘了重画，屏幕上也不会残留上一局的人。
    const h = $('hand'); if (h) h.innerHTML = '';
    syncOverlayBounds();
    return;
  }
  // ⚠️⚠️ 2026-10-07（用户第 1 条）：把「顶栏高」与「页脚＋手牌区高」**实量**进 CSS 变量
  //    （`--ovtop` / `--ovbottom`，`#overlay.top` 消费）—— 事件台浮层据此**永远**让开
  //    上面的声望系统（顶栏）与下面的手牌区，屏幕再矮也不会盖上去。
  syncOverlayBounds();
  const v = S.view;
  // ⚠️⚠️ 2026-10-08（用户第 3 条）：「原初欲望觉醒」结束 ⇒ 「你的欲望」**自动跳出来一次**。
  //    置位在 `pickCommit`（觉醒流程唯一收口，见那边的注释）；这里消费 ——
  //    **判据全过才弹**，与 `renderOverlay` 的优先级链对齐：
  //    · `!v.prologue` —— 已落在正文第 1 天（觉醒直通链中间那几次 render 不消费）
  //    · 结算卡队列空 / 不在场景 —— "必须先看完"的打断压着头时不抢屏
  //      （`renderOverlay` 里 scene 与 popupResults 两个分支都排在详情浮层之前；
  //        直通第 1 天常带一张「结果占卜」结算卡 ⇒ 玩家点掉它的**那一帧**才弹，
  //        这正是该有的次序：结果先看完，欲望面板后出来。）
  //    · ⚠️ **不判 `v.popups`**：那是铺在画布上的档 A 待办（点不点由玩家），
  //      「档 A 不拦详情查看」是既定裁定 —— 拿它当拦路判据会让欲望面板**永远**等不来
  //      （新一天的待办通常非空，2026-10-08 实测：第 1 天就有「一封没有署名的请柬」）。
  //    · 没开着别的详情 / 自拟 / 确认框 —— 自动弹不该顶掉玩家正开着的东西
  //    ⚠️ **先清标志再弹**：玩家点掉面板之后的那些 render 不会重弹（每局一次）。
  if (desireIntroPending && v && !v.prologue && !v.scene
      && popupResults.length === 0
      && !detailOpen && !composeOpen && !confirmAsk && !popupOpenId) {
    desireIntroPending = false;
    detailOpen = { kind: 'quest' };   // 自动打开欲望面板（与手点「你的欲望」卡同一层）
    desireIntroToastWanted = true;    // 配套引导 —— render 末尾（DOM 就绪后）放到面板左侧
  }
  renderTop(v); renderHand(v); renderLeft(v); renderMid(v); renderGod(v); renderFooter(v); renderOverlay(v);
  // ⚠️⚠️ 2026-10-06：**结局全屏演出**（用户裁定：「为结局做专门的全屏动画，而不是简单的弹窗」）。
  //    判据：`v.isOver && v.ending` ⇒ 这一局已经判定了。
  //    ⚠️ **两路都在这里触发**（成功与失败 alike）—— 失败结局的话术是系统预写的、
  //      判定那一刻就齐了 ⇒ 一次播完；成功结局的判词由 `ending` 侧链**异步**写，
  //      第一次进来可能还没有（`endingText` 会给一句占位），**后到再补一次**。
  //    ⇒ 这就是"两段式"：标题先出（`finalEndingOf` 当场写定了它），判词后到。
  //    ⚠️ `playEnding` 内部有 `endingPlayed` 守卫 ⇒ 反复 `render()` 不会重播。
  if (v.isOver && v.ending) {
    const e = v.ending;
    // 判词还空着 ⇒ 这是"刚判出成功、LLM 还没写"的那一段：先播标题，正文用占位
    const 正文齐了 = !!(e.text && e.text.length);
    if (!endingPlayed) {
      playEnding(e, 正文齐了 ? { pre: true } : { pre: false });
    } else if (endingBusy && 正文齐了) {
      // ⚠️ **第二段**：判词到了 ⇒ 把占位换成真正文（不重播标题，那一段已经演过了）
      endingSecondHalf(e);
    }
  }
  // ⚠️ 2026-10-05：给两栏的卡片**统一**写 `--i`（进场的错开序号）。
  //    刻意**不在 `renderLeft` / `renderMid` 里逐张写** —— 那是十几个字符串拼接点，
  //    改它们要动 `ui.test.ts` 有源码断言的那些函数体；在这里做只有一处口径。
  //    ⚠️ `render()` 在**每次动作之后**都会跑，而 `--i` 只决定 `animation-delay`：
  //    卡片会被重造（`innerHTML=`）⇒ 动画每次都从头播一次。
  //    这正是我们要的：翻日 / 结算之后"新的今天"重新浮现，符合"新的一天开始了"的读感。
  stampStagger();
  // ⚠️ 画布的平移/缩放视图（2026-10-05）：`.canvas-pan` 每次都被 `innerHTML=` **重建**，
  //    新元素上没有 `transform` ⇒ 玩家调好的视角会**被重画抹掉**。
  //    ⇒ 每次渲染后重贴一次。`cvView` 是页面上的状态，值一直都在。
  applyCanvasView();
  // ⚠️ 资源数字滚动（2026-10-05）：`render()` 是**所有**浮层的唯一画出口
  //    （包括不经过 `api()` 的那几条：点「知道了」收掉结算、点卡片外面收起详情…），
  //    所以滚动放在**这里**而不是只放在 `api()` 末尾 —— 放那儿会漏掉重开的那几层。
  //    `rollMeters` 幂等（`dataset.done`），重画不会滚第二次。
  if (S && S.view) rollMeters();
  // ⚠️ 2026-10-06：**演一遍本次的变化**（用户裁定「避免静默的状态变化」）。
  //    必须**在 `render()` 之后** —— 飞行要靠 `getBoundingClientRect` 找落点，
  //    那时新卡已经在 DOM 里了。
  //    ⚠️ 立刻清空：清单是**一次性的**（用户裁定「就淡出」），
  //    留在 `pendingChanges` 里会在下一次 `render()` 时**重演一遍**。
  if (pendingChanges && pendingChanges.length) {
    const list = pendingChanges;
    pendingChanges = [];
    playChanges(list);
  }
  // ⚠️⚠️ 2026-10-08（用户第 3 条）：欲望面板**首次自动弹出**的配套引导 toast ——
  //    必须放在 render 的**最末尾**：面板 DOM 画完了，才量得到 `#modal` 的真实左缘
  //    （"放在欲望弹窗左侧"）。一次性待办，取完即清。
  if (desireIntroToastWanted) {
    desireIntroToastWanted = false;
    desireIntroToast();
  }
}

/**
 * 把两栏里依次出现的 `.card` 标上 `--i`（0,1,2…），供 CSS 的 `animation-delay` 消费。
 * ⚠️ **幂等**：每次都是重写（不是累加），所以重复调用不会让序号漂。
 */
function stampStagger(){
  for (const id of ['colLeft', 'colMid']) {
    const col = $(id);
    if (!col) continue;
    const cards = col.querySelectorAll(':scope > .card');
    for (let i = 0; i < cards.length; i++) cards[i].style.setProperty('--i', String(i));
  }
}

// ⚠️ `banner` 此前是个**死变量**：`api()` 一直往里写（闸门拦下的原因 / 裁定拒绝 / 排布成功 …），
//    但**没有任何地方把它渲染出来** ⇒ 玩家一个字都看不到，页面上任何错误都像"什么都没发生"。
//    （连"连不上后端"那条也出不来 —— 于是白页连个解释都没有。）
// ⚠️⚠️ 2026-10-07 用户裁定：**红色提醒只停留 3 秒** —— 档 A 未清那条指引看完就该走，
//    一直挂在那里反而像"永远被卡住"。ok 那一类（离线快照等）不受影响、照旧常驻。
let bannerTimer = 0;
function renderBanner(){
  const el = $('banner');
  if(!el) return;
  el.innerHTML = arr(banner).map((m) =>
    '<div class="msg ' + (m.kind === 'err' ? 'err' : 'ok') + '">' + esc(m.text) + '</div>').join('');
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
  if (arr(banner).some((m) => m.kind === 'err')) {
    bannerTimer = setTimeout(function () {
      bannerTimer = 0;
      banner = arr(banner).filter((m) => m.kind !== 'err');
      renderBanner();
    }, 3000);
  }
}

/** 一张塔罗的牌面文字（与 `rules/tarot.ts·cardLabel` 同形 —— UI 侧不 import TS，只好照抄这一处格式） */
function cardFace(c){ return c.name + (c.reversed ? ' · 逆位' : ' · 正位'); }

/* ═══════════════════════════════════════════════════════════════════
   属性符号 · 事件纹章 · 档位印记（2026-10-05）
   ─────────────────────────────────────────────────────────────────
   用户的裁定：事件面板左侧要有一块"图像"（学《苏丹》那张插画），
   但我们**没有美术资源**；用户给的思路是「引入一些美术资产，比如不同属性
   有对应的象征符号，事件处理需要什么属性就显示什么符号」。

   为什么符号比插画更适合我们（不只是因为没钱）：
     · **它携带信息**。插画是氛围，符号是**"这件事要什么"**——
       玩家在决定派谁之前就该看到「智慧 ✔ 魅力 ✔」，
       而那正是《苏丹》把插画放在那里换来的副产品（看图就知道该派谁）。
     · 六个符号 = 六个**稳定的**图形语言，学会一次记一辈子；
       插画每一张都不同，玩家每次都要重新读一遍。

   ⚠️ **全部纯 SVG 内联**：不引外部图片（离线要能跑 · 换设备照样画得出）。
   ⚠️ **每条事件独一无二且稳定**：符号组合由 `hint_attr` 决定（规则层给的），
      纹章底纹由 `hashOf(id)` 决定 ⇒ 同一条事件每次进来长得一样，
      不同的事件彼此不同（**不是**每次重画都换花样 —— 那会让玩家以为是新事件）。
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 六枚属性符号 —— **纯 SVG 路径**，24×24 视框，`currentColor` 描边。
 *
 * ⚠️ 每枚都是**具象的**，不是抽象几何：具象的才认得出（"剑=争斗、书=智慧"），
 *   抽象三角/圆形的差别只有形状、没有语义 ⇒ 记不住。
 * ⚠️ 线条统一 `stroke-width:1.6`、`stroke-linecap:round` ——
 *   粗细不统一会让六枚看起来像六个不同的图标集。
 */
const ATTR_SIGIL = {
  '争斗': '<path d="M4 4l7 7M20 4l-7 7M12 11v3M9.5 16.5h5M10.5 19h3"/>',          // 交叉的剑
  '敏捷': '<path d="M13 3l-3 8h5l-4 10 2-8H8z"/>',                                  // 闪电
  '智慧': '<path d="M4 5.5c2.6-1 5-1 8 0 3-1 5.4-1 8 0v12c-2.6-1-5-1-8 0-3-1-5.4-1-8 0z"/><path d="M12 5.5v12"/>', // 合上的书
  '魅力': '<path d="M12 3.5l2.3 5.1 5.7.6-4.3 3.8 1.2 5.6L12 16l-4.9 2.6 1.2-5.6L4 9.2l5.7-.6z"/>', // 星
  '社交': '<path d="M8 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 2.2-5 5-5s5 2 5 5"/><path d="M16 11a3 3 0 100-6M17 15c2.5.4 4 2.2 4 5"/>', // 两人
  '感知': '<path d="M2.5 12s3.6-6.5 9.5-6.5S21.5 12 21.5 12s-3.6 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>', // 眼
};
/** 物品三类符号（`Item.kind`：装备 / 消耗品 / 特殊物品） */
const ITEM_SIGIL = {
  '装备': '<path d="M6 4h12v4a6 6 0 01-12 0z"/><path d="M6 6H4v2a4 4 0 004 4M18 6h2v2a4 4 0 01-4 4"/>', // 盔
  '消耗品': '<path d="M9.5 3h5M10 3v6L6 19a1.5 1.5 0 001.4 2h9.2A1.5 1.5 0 0018 19l-4-10V3"/><path d="M7.5 14h9"/>', // 瓶
  '特殊物品': '<path d="M12 2.5l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 8.9l6.1-.8z"/>', // 菱形宝石
};

/** 属性符号（24px 视框，可给 `size`） */
function attrSigil(k, size){
  const p = ATTR_SIGIL[k];
  if (!p) return '';
  return '<svg class="sigil" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18)
    + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}
function itemSigil(kind, size){
  const p = ITEM_SIGIL[kind];
  if (!p) return '';
  return '<svg class="sigil" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18)
    + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

/**
 * 加成数组 → **一排绿词条（带属性图标）**（2026-10-07 用户裁定：
 * 「之前有的那个好看的绿色词条和里面的『争斗』属性图标」要回来）。
 *
 * ⚠️ `bonus` 是 view 预格式化的串（`session.ts·itemOf`）：
 *    `"争斗+1"` ／ `"争斗+1（在场时）"`。属性名 ＝ **第一个 `+` 之前**的那段
 *    ⇒ 借它查 `ATTR_SIGIL` 拿图标；查不到就只出文字（不硬造一个空图标位）。
 * ⚠️ 词条样式走 `.itb`（绿底绿字，与 `@n` 同族）—— 人物卡、手牌物卡、
 *    详情页卡槽三处**共用这一个函数**，改一处三处跟着变。
 */
function bonusTags(bonusArr, size){
  return arr(bonusArr).map(function (b) {
    const attr = String(b).split('+')[0].trim();
    return '<span class="itb">' + attrSigil(attr, size || 10) + esc(b) + '</span>';
  }).join('');
}

/** 一枚属性小徽（卡面上用） */
function attrChip(k){
  return '<span class="attrchip" title="这件事要「' + esc(k) + '」">' + attrSigil(k, 13) + esc(k) + '</span>';
}

/**
 * **事件纹章** —— 左侧那块"图像"。
 *
 * 结构：外圈（档位配色）＋ 底纹（按 id 的 hash 从四种里选一）＋ 中间那几枚属性符号。
 * ⚠️ 底纹**只用几何**（十字/斜线/同心/点阵），**不画任何具象景物** ——
 *   具景就得有美术资源，而半吊子的具景（一个歪掉的人形）比没有更糟。
 *   几何底纹 ＋ 具象属性符号，这个组合既"有图"，又每一枚都有意义。
 * ⚠️ 底纹选择**由 id 决定**（`hashOf`）⇒ 同一条事件每次都长得一样。
 */
function eventSigil(ev){
  const tier = ev.tier || 'B';
  const h = hashOf('#' + (ev.id || ev.title || ''));
  // 四种底纹：0 十字 1 斜线 2 同心圆 3 点阵
  const pat = h % 4;
  const pats = [
    '<path d="M30 10v40M10 30h40" stroke="currentColor" stroke-width="1" opacity=".14"/>',
    '<path d="M10 42L42 10M18 50L50 18" stroke="currentColor" stroke-width="1" opacity=".14"/>',
    '<circle cx="30" cy="30" r="10" fill="none" stroke="currentColor" stroke-width="1" opacity=".16"/>'
      + '<circle cx="30" cy="30" r="17" fill="none" stroke="currentColor" stroke-width="1" opacity=".1"/>',
    '<g fill="currentColor" opacity=".15">'
      + [[18, 16], [42, 16], [18, 44], [42, 44], [30, 30], [30, 8], [30, 52], [8, 30], [52, 30]]
        .map((p) => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="1.6"/>').join('') + '</g>',
  ];
  const attrs = arr(ev.hint_attr);
  const sig = (attrs.length ? attrs : ['智慧']).slice(0, 3)
    .map((k, i) => '<span class="esig" style="--i:' + i + '">' + attrSigil(k, attrs.length > 1 ? 17 : 22) + '</span>')
    .join('');
  return '<div class="esigil t' + esc(tier) + ' p' + pat + '" aria-hidden="true">'
    + '<svg viewBox="0 0 60 60" class="epat">' + pats[pat] + '</svg>'
    + '<div class="esigs">' + sig + '</div>'
    + (attrs.length ? '' : '<span class="esigx" title="这件事没有指定属性">未指定</span>')
    + '</div>';
}

/**
 * 顶栏 —— **玩家视角**。
 *
 * ⚠️ 欲念这一颗的**三个版本**（别再把其中两个搞混）：
 *    ① 最早：`欲念 61` ＋ `危险区 正常` —— 后者只有 3 个值（迷失 / 正常 / 沉溺），
 *       把「常态」与「窗口」压成同一个词；而「窗口是唯一好结局」恰是玩家摸得着的那点手感。
 *    ② 2026-09-22（P5-B）：只印**区间名**（4 段，逐字取自《设定.md》的区间列），
 *       数值与危险区搬去「上帝视角」。
 *    ③ **2026-09-22 用户裁定（本条现行）：区间名 ＋ 数值一起印** ——
 *       原话「直接写出来区间名+欲念值就行了」。危险区（3 值）仍只在上帝视角。
 * ⚠️ 它与《规则.md》:640 末句「玩家只能从**区间语义**与「欲向」的手感里摸」**不一致** ——
 *    按用户 2026-09-22 的明确指令实现；分歧记在根目录 `开发待办.md`，**不回头改设计文档**。
 * ⚠️ 「藏 N 条隐藏事件」也撤了 —— 那是系统账，玩家不该知道有几条在等着他。
 */
function renderTop(v){
  // ⚠️⚠️ 2026-10-06 用户裁定：「为什么上面的声望值只有权势一个，其他的呢？
  //   **就算是 0 也要显示**」—— 改前是 `.filter(([,n]) => n !== 0)`
  //   ⇒ 四项为 0 时**整项消失**，玩家只看见「权势 5」，像是只有一种声望。
  //   ⚠️ 五项**恒定全列**（顺序照 `v.rep` 的自带次序，不排序）：
  //     声望是**一组刻度**，不是五个独立数字 —— 藏掉 0 的那几项，
  //     玩家就看不出"善名这一项我现在是 0"，而那正是他要判断的东西。
  //   ⚠️ 0 用**淡色**（仍占位、仍可读），非 0 用正常色 ⇒ 一眼看出"哪几项在动"。
  const repAll = Object.entries(v.rep);
  const rep = repAll.map(([k, n]) => {
    const z = (n === 0);
    return '<span class="rp' + (z ? ' zero' : '') + '">' + k + ' ' + n + '</span>';
  }).join('');
  const repFlat = repAll.map(([k, n]) => k + ' ' + n).join(' · ');
  const band = v.desire.band || '常态';
  const bandCls = { 迷失: 'lost', 常态: 'norm', 窗口: 'win', 沉溺: 'indulge' }[band] || 'norm';
  // ⚠️ 2026-10-05：外面套了 `.tb-l` / `.tb-c` / `.tb-r` **三个容器**（顶栏分三区）。
  //    **每一个 `<span>` 的内容、顺序、文案都逐字未动** —— 改的只是"挂在哪个容器里"：
  //      · `.tb-l`（左）  这一天走到哪儿了：第几天 · 第几章 · 今天还剩几点（时间轴）
  //      · `.tb-c`（中）  这一局的资源：金币 · 欲念 · 声望 · 待办待揭 · 本周氛围
  //      · `.tb-r`（右）  留给"计时器"的空位（现在也放待办计数，视觉上仍是右端优先）
  //    原来 8 项平铺在一个 flex 里，读者分不出"哪些是今天、哪些是这一局"。
  //    ⚠️ 底部那条注释提到的 `#topbar > span:last-child{margin-left:auto}`
  //       已随三区容器退休（`margin-left:auto` 现在由 grid 的第三列负责）。
  $('topbar').innerHTML =
    '<div class="tb-l">' +
    '<span class="day">第 ' + v.day + ' / ' + v.totalDays + ' 天</span>' +
    // ⚠️⚠️ 2026-10-06 清单第 25 条：把「第 N 章 · 序幕/正文」换成「**现在是：早上/下午/傍晚/深夜**」。
    //   用户原话：「把这里的『第一章-正文』改成『**现在是：早上/下午/傍晚/深夜**』，
    //   **每一段自然对应一个行动点**」。
    //   ⚠️ **章号保留在后面**（`第 N 章`）—— 它是"这一局走到哪了"，与"今天现在几点"是两回事。
    //   ⚠️ `daypart` 是**纯派生**的（`rules/clock.ts·daypartOf`），**不是新存储字段**。
    '<span class="kv">现在是：<b>' + esc(v.daypart || '早上') + '</b> · 第 <b>' + v.chapter + '</b> 章</span>' +
    // 时间做成**常驻读数**：字 ＋ 一排圆点（今天还剩几点，一眼看得出）。
    // ⚠️ 这是本作的**核心压力**，此前它和"第几章"并排成一行小字，谁都不显眼。
    '<span class="kv">今天还剩 <b>' + v.remaining + '</b> / ' + v.apTotal + ' 点' +
      '<span class="apdots" title="已用 ' + v.usedToday + ' 点 · 共 ' + v.apTotal + ' 点">' +
      Array.from({ length: v.apTotal }, (_, i) => '<i' + (i < v.usedToday ? ' class="on"' : '') + '></i>').join('') +
      '</span></span>' +
    '</div>' +
    '<div class="tb-c">' +
    // ⚠️ 2026-10-06：这三项各挂一个 class —— **变化演出要定位到具体那个元素**
    //    （`flashNum` 靠 `.tb-gold` / `.tb-desire` / `.tb-rep` 找落点）。
    //    逐字内容、顺序、结构**一字未动**，只多了三个定位用的 class。
    // ⚠️ 2026-10-07（用户裁定·串行金币）：顶栏与手牌读**同一个净额** —— 桌上垫多少，
    //    两处立马同步扣多少；只改手牌的话两个数字会打架，那不叫串行。
    '<span class="kv tb-gold">金币 <b>' + Math.max(0, (v.gold || 0) - placedGold()) + '</b></span>' +
    '<span class="chip band tb-desire ' + bandCls + '"' + (v.desire.bandNote ? ' title="' + esc(v.desire.bandNote) + '"' : '') + '>欲念 · ' + esc(band) + ' <b>' + v.desire.value + '</b></span>' +
    '<span class="kv tb-rep" title="' + esc(repFlat) + '">' + (repAll.length ? rep : '声望 全 0') + '</span>' +
    // ⚠️⚠️ 2026-10-07 用户第 24 条：`v.waiting` 就是「**点了 ✔、还在等时针**」那批
    //   ⇒ 顶栏这一格跟着改成玩家那一侧的词「处理中」（原来叫「待揭」，
    //     那是系统视角；同一状态在页面上只留一个名字）。
    '<span class="kv" title="待办 = 还没派人去办的；处理中 = 已经点了 ✔、拨时针到点才揭晓的">待办 <b>' + v.todo.length + '</b> · 处理中 <b>' + v.waiting.length + '</b></span>' +
    // ⚠️ 2026-10-08：签文**前**展示本章抽到的两张占卜牌（先见牌、后见签文）；
    //    旧档没有 cards ⇒ 数组为空、一条不渲染（优雅降级）。
    arr(v.divCards || []).map(function (c) {
      return '<span class="chip" title="本周占卜抽到的牌">' + esc(c.name + ' · ' + (c.reversed ? '逆位' : '正位')) + '</span>';
    }).join('') +
    (v.ambience ? '<span class="chip" title="本周氛围（章节占卜）">' + esc(v.ambience) + '</span>' : '') +
    '</div>' +
    '<div class="tb-r"></div>';
  // 供那段独立的兜底脚本判读：'1' = 主脚本确实跑到了这里
  $('topbar').setAttribute('data-ready', '1');
}

/**
 * 一个人的**卡**（向《苏丹的游戏》借的那个"张"形状）。
 *
 * ⚠️ 与 `personLine()` 的分工：`personLine` 是**一行** —— 玩家自己那张卡用它（要横着读
 *    好几栏：剩时 / 携带 / 认可）；`personCard` 是**一张** —— 左栏的人手网格用它，
 *    目的是"一眼扫过去看得见有谁"。**两者都不是"另一份数据"**：同一个 `p`，字段一个不减。
 */
function personCard(p, isMe){
  // ⚠️ 「尚未入队」的人**不报容量**（2026-09-20 用户裁定「注意人物详情字段的显示」）：
  //    `容量 N` 问的是"他今天还有多少空闲"，而玩家**根本调不动他** ——
  //    同一条口径在规则层是 `ledger/types.ts·isAvailable` 的第一行
  //    （`if (!p.affiliated) return false`），在提示词层是 `prompt/blocks.ts:84`（`空闲` / `尚未入队`）。
  //    ⚠️ 用词**逐字取**「尚未入队」（`PROMPT清单.md:2507` 用户原话），**不用「非在册」** ——
  //       同一个事实在玩家面上取第二个名字，只会让人以为那是两件事。
  const chips = [];
  if (isMe) chips.push('剩时 ' + p.ap);
  // ⚠️ 2026-09-22 用户裁定：「**已入队的才可以派遣**，同时也呈现更多的信息」。
  //    ⇒ 卡面第一眼就回答「我能不能使唤他」（与 `isAvailable` 第一行同一条口径），
  //      容量则只对**能派的人**报 —— 对一个调不动的人说「他还有 4 点空闲」是没有意义的。
  else if (p.affiliated) chips.push('可派遣 · 容量 ' + p.ap);
  // ⚠️⚠️ 2026-10-07 用户第 3 条：「现在每个未入队人物卡上的『尚未入队，调不动』
  //   这样的**废话删掉**」。⇒ 只留「尚未入队」这个**事实**（全项目统一的那一个词），
  //   后半句"调不动"是同义反复 —— 未入队本来就调不动（isAvailable 第一行）。
  else chips.push('尚未入队');
  if (p.status !== '正常') chips.push(p.status);
  if (!isMe && p.away) chips.push('在途');
  // 「认可」是他给过你的东西（＝最终任务「共鸣」格的候选）—— 卡面给个计数就看得见进展
  const recN = arr(p.recognized).length;
  if (!isMe && recN) chips.push('认可 ' + recN);
  // ⚠️ 2026-10-07 用户裁定：「医 / 祈」小按钮**撤掉** —— 恢复的唯一入口是
  //    处理台里那两张固定功能卡（医馆疗伤 / 神殿净化，拖人上去点确定）。
  //    两处入口做同一件事 = 两套口径（成本提示各写一份）必然漂。
  // ⚠️ B 轮：整张小卡可点 ⇒ 点开看**具体内容**（身份 / 六维 / 认可 / 携带）。
  //    卡面只留「他是谁 ＋ 他现在的状态」；「认可」那一条最细，收进点开。
  //    卡里的「医」「祈」两颗按钮**不受影响**：`closest('[data-act]')` 命中的是按钮自己。
  return '<div class="pcard tap' + (p.available || isMe ? '' : ' off') + '"' +
    ' data-act="detail" data-kind="person" data-id="' + p.id + '" title="点开看这个人的细节">' +
    '<div class="pc1"><span class="nm">' + esc(p.name) + '</span>' +
      '<span class="sub" style="font-size:11px;color:var(--muted)">' + esc(p.identity) +
      ' · HP ' + p.hp + ' · SAN ' + p.san + '</span></div>' +
    '<div class="pc2">' + esc(p.basic) + '</div>' +
    '<div class="pc2">' + esc(chips.join(' · ')) + '</div>' +
  '</div>';
}

/* ═══════════════════════════════════════════════════════════════════
   底部手牌区（2026-10-05 · 布局重构）
   ─────────────────────────────────────────────────────────────────
   用户的裁定：**「主角也应当可以拖拽，待遇其实和其余下属差不多」**。
   ⇒ 这条在代码里落成一件很具体的事：**主角与下属走同一个函数、同一套 class、
      同样带 `data-kind` / `data-id`（拖拽源）、同样能被 `canDropOn` 判为可落**。
      差别只有两处，且**都不是待遇上的**：
        · 一圈金边 ＋ 一个「我」角标（告诉玩家"这是你"，防止误把自己派出去）
        · 卡面上写「剩时 N」而不是「容量 N」（同一条口径的措辞差别，见 `personCard`）
      ⚠️ 刻意**没有**把它做成另一种形状/更大/固定不可动 —— 那是"主角特殊"，
         而用户要的是"他就是个普通人，只是恰好是你"。

   ⚠️ 卡面上**每个字段都取自 `v.people[i]` / `v.me` 里已经存在的值**，
      **不新增任何读数**。点开（`data-act="detail"`）仍走原来那套详情浮层。
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 一张**手牌**（人或物）—— 主角与下属共用。
 *
 * @param p    `v.people[i]` 或 `v.me`（主角时传 `v.me` 并置 `isMe`）
 * @param isMe 是不是主角
 * @param i    卡带里的序号（只用于进场错开，不参与任何判定）
 */
/**
 * **金币卡**（2026-10-05 用户裁定：金币也统一为卡牌）。
 *
 * ⚠️ 它**没有 id**（`data-id` 留空）：金币不是账本里的实体，`view.gold` 只是一个数。
 *    ⇒ 拖拽时 `canDropOn` 只看 `kind === 'gold'`，不去查实体表（下面是它的分支）。
 * ⚠️ 卡面**必须写数量**（用户裁定「在它卡面的下部设有数字表示堆叠数量」）：
 *    这是它与别的卡唯一的区别，也是玩家拖之前唯一要读的信息。
 *    数字**大号**放在下部 —— 卡的上部留给"这是什么"，下部留给"有多少"。
 * ⚠️ 0 金时**照旧画这张卡、但画成空壳**（`0` ＋ 变灰）：把它藏起来的话，
 *    玩家会以为"我没有钱这件事不存在"，而它恰恰是那件事的核心约束。
 * ⚠️ 不可点开（不给 `data-act="detail"`）：点金币卡没有任何可看的东西。
 */
function goldCard(gold, i){
  const n = Math.max(0, Math.trunc(Number(gold) || 0));
  return '<div class="hcard gold' + (n > 0 ? '' : ' zero') + '" style="--i:' + i + '"' +
    ' data-kind="gold" data-name="金币"' +
    ' title="' + (n > 0 ? '拖到某件事的钱格里垫钱' : '一枚也没有了') + '">' +
    '<div class="hb"></div>' +
    '<div class="hn">金币</div>' +
    '<div class="hg">' + n + '</div>' +
  '</div>';
}

/**
 * 一张人卡。
 * @param opts `{noDrag}` —— **不给 `data-kind`**（拖不动，只能点开看）。
 *   ⚠️ 2026-10-06 用户裁定：未入队的人**不可拖拽**，只能点开看详情。
 */
function handCard(p, isMe, i, opts){
  // 能力点：四颗小点，实心的＝还剩几点。**只画** `p.ap` 颗（不补满 4）——
  //   画满 4 颗再挖空是"永远显示 4 格"，会让"他今天还剩几点"这条读数变得不明显。
  const ap = Math.max(0, Math.min(4, p.ap || 0));
  const hap = '<span class="hap" title="' + (isMe ? '剩时 ' : '容量 ') + ap + ' / 4">' +
    Array.from({ length: 4 }, (_, k) => '<i' + (k < ap ? ' class="on"' : '') + '></i>').join('') +
    '</span>';
  // ⚠️ **死亡与疯狂是"没了"，不是"重伤"**（2026-10-05 用户裁定）。
  //    判据是 `status`（`ledger/types.ts·derivePersonStatus` 派生的：HP=0 死亡 · SAN=0 疯狂）——
  //    规则侧早就认这两条，缺的只是**玩家面看不见**：他们此前在手牌带里
  //    仍是一张正常卡，还能被拖走、还能点开。
  //    ⚠️ **留在卡带上**（用户裁定）：清出去等于把后果藏起来 —— 玩家必须看见"少了一个人"。
  const gone = !isMe && (p.status === '死亡' || p.status === '疯狂');
  // 状态点：**只在有状态时出现**，平时不留空位（一张空标签比无更占眼）。
  const st = [];
  if (p.status !== '正常') st.push(esc(p.status));
  if (!isMe && p.away && !gone) st.push('在途');
  if (!isMe && !p.affiliated && !gone) st.push('尚未入队');
  // HP 条：数字在点开里，卡面只给"他还好不好"这一条连续读数。
  // ⚠️ 没了的人**不画条** —— 一条 0% 的红条与"他不在了"是两件事，
  //    混起来会读成"他快不行了"（而他不是快不行了，他没了）。
  const hpPct = Math.max(0, Math.min(1, (p.hp || 0) / 3));
  const hp = gone ? '' : '<div class="hphp" title="HP ' + p.hp + ' / 3"><i style="width:' + (hpPct * 100).toFixed(0) + '%"></i></div>';

  const cls = ['hcard'];
  if (isMe) cls.push('me');
  if (p.status !== '正常') cls.push('hurt');
  if (p.away) cls.push('away');
  if (!isMe && !p.affiliated) cls.push('off');
  if (gone) cls.push('gone');
  // ⚠️ **没了的人不给 `data-act` / `data-id`** —— 那两个是拖拽源与点开详情的入口。
  //    留着它就意味着"死人还能被派出去"。不给入口，拖拽与点开自然都按不住，
  //    而 `canDropOn` 那边**一个字都不用改**（它本来就把 HP≤1 判成不可派）。
  // ⚠️⚠️ 2026-10-06：**这张卡也是「物卡」的落点**（用户裁定：物品直接拖到人物卡上）。
  //    所以它要带 `data-to-whom`（收件人 id）—— 与 `data-id` 分开：
  //    `data-id` 是"点开谁"，`data-to-whom` 是"东西交给谁"。**两件事两个字段**。
  //    ⚠️ 死了的人不接（`gone` 那一支不给 `data-to-whom`）—— 死人不会带东西。
  // ⚠️ `opts.noDrag` ⇒ **不给 `data-kind`**（拖拽源选择器靠它），
  //    但 `data-act="detail"` 照给 —— 「只能点开看详情，不能拖」。
  const noDrag = !!(opts && opts.noDrag);
  const acts = gone ? '' : ' data-act="detail"'
    + (noDrag ? '' : ' data-kind="person"')
    + ' data-id="' + p.id + '"'
    + ' data-name="' + esc(p.name) + '"'
    + (noDrag ? '' : ' data-to-whom="' + p.id + '"');
  const tip = gone
    ? esc(p.name) + ' —— ' + esc(p.status) + '了'
    : '点开看' + esc(p.name) + '的细节；按住可以拖到某件事上';
  // ⚠️⚠️ 2026-10-07（用户裁定四条）：**携带物品的可见化 ＋ 属性加成写进卡面**。
  // ① `@n` 标记（他带了几件东西）—— 物品改成"拖到人身上"之后，
  //    **卡面上没有任何东西说"他带了刀"** ⇒ 玩家不知道该往谁身上拖。
  //    ⚠️⚠️ 2026-10-07（用户报告"折叠与展开看到的物品不一样"）：
  //      悬停 `@n` 现在**逐件报名字** —— 折叠态把"他带了什么"一句话说全，
  //      与详情页四槽是同一份清单（`p.items` 进 view 时已滤 consumed，见 session.ts）。
  const carriedList = arr(p.items);
  const carried = carriedList.length;
  const atMark = carried
    ? '<span class="hat" title="他带着 ' + carried + ' 件：' + esc(carriedList.map(function (x) { return x.name; }).join('、')) + '">@' + carried + '</span>'
    : '';
  // ⚠️⚠️ 2026-10-06 用户裁定（**改**）：**携带物在人物卡「未展开」时不要出现**，
  //    「人物卡展开后再显示携带的物品就行」。
  //    ⚠️ 这不是"不好看"——是**它把卡点不开**：`pointerdown` 落在小卡上
  //    ⇒ `closest('[data-act]')` 先命中**小卡**（它也带 `data-act="detail" data-kind="item"`）
  //    ⇒ 打开的是**物品详情**，人卡那张永远走不到（截图里"点不开"就是这个）。
  //    ⇒ 代价：卡面看不出"他带了什么"（`@n` 角标**留着**，够回答"有没有带东西"），
  //      具体是什么点开看 —— 这是该裁定的直接取舍。
  //
  //    ↓↓↓ 以下是**原实现**的说明，留着当设计记录（已被上面那条取代）↓↓↓
  //    **他带的东西就贴在这张卡下面**（用户裁定：「物品卡缩小插入到了
  //    对应人物卡上」）。这一条同时补掉三个洞：
  //      ① 借出去的东西**从卡带上消失**，只剩一个 `@n` ⇒ 玩家**看不见他带的是什么**，
  //         更**没法拖回来**（"能拖过去就能拖回来"那半边落不了地）；
  //      ② 别人带的东西在 UI 上**没有任何入口**（藏在"还有 N 件"折叠里，而那折叠
  //         只放**玩家自己**的 `me.items`）；
  //      ③ 玩家无法判断"哪两件算数"（`BONUS_CAP`）—— 只给一个 `+1` 不知道是谁给的。
  //    ⇒ 画成一排**缩小的物卡**，每张都是**可拖的源**（`data-kind="item"`）：
  //      拖到别人的卡上＝转移；拖到玩家卡上＝收回。
  //    ⚠️ **哪两件算数要标出来**（`capNote` 那条提示）—— 生效的那两件给亮边。
  // ⚠️⚠️ 2026-10-06 用户裁定：**卡面上不画携带物小卡**（理由见上面那段说明）
  //    ⇒ 这一支恒为 `''`。「他带了什么」看卡面上的**词条**（上面 ②）与详情页的卡槽。
  const miniItems = '';

  // ② 逐件物品词条（2026-10-07 用户裁定「统一改成」）：
  //    · 有数值加成的 ⇒ 加成词条（如「争斗+1」）；
  //    · 特殊物品 ⇒ 蓝色「特殊物品」词条；
  //    · 其余 ⇒ 不占卡面（详情页四个卡槽里有）。
  //    ⚠️ `@n` 总数**保留** —— 它回答"他带了几件"。
  //    ⚠️⚠️ 2026-10-08（用户裁定「在身上时会有对应的词条效果」）：**我自己的卡也画词条**。
  //      旧口径（2026-10-07"我带的东西以物卡身份排在卡带上"）已随「物品默认无人携带」
  //      改动**失效**：手牌区只画 `holder` 为空的物品 ⇒ 我带着的不再出现在卡带上，
  //      词条成了卡面上唯一可见的携带痕迹。NPC 与我一视同仁 ——
  //      词条跟着**物品的实际位置**走，不跟着物卡走。
  //    ⚠️ 数据来自 view 的 `p.items`（进 view 时已滤 consumed，UI 不自己算）。
  const itemTags = (!gone ? arr(p.items).map(function (it) {
    const bs = arr(it.bonus);
    // ⚠️ 2026-10-07：加成词条带**属性图标**（`bonusTags` —— 三处共用同一个函数）
    if (bs.length) return bonusTags(bs, 9);
    if ((it.kind || '') === '特殊物品') return '<span class="itsp">特殊物品</span>';
    return '';
  }).join('') : '');
  const bonusLine = itemTags;
  // ⚠️ 2026-10-06 用户裁定（清单第 1 条）：**这句「只有 N 件算数」保留** ——
  //   它是**规则**（`BONUS_CAP = 2`），玩家据此判断"要不要换装"。
  //   ⚠️ 只在"带了比生效名额更多带加成的"时提示 —— 两件都生效时没有这回事。
  const effIds = arr(p.effectiveItemIds);
  const withBonus = arr(p.items).filter((it) => arr(it.bonus).length > 0);
  const capNote = (!gone && withBonus.length > effIds.length)
    ? '<div class="hr cap">只有 ' + effIds.length + ' 件算数</div>' : '';
  return '<div class="' + cls.join(' ') + '" style="--i:' + i + '"' + acts +
    ' title="' + tip + '">' +
    '<div class="hb"></div>' +
    '<div class="hn">' + esc(p.name)
      + (gone ? '<span class="hdead"> · ' + esc(p.status) + '</span>' : atMark) + '</div>' +
    '<div class="hi">' + esc(p.identity || p.basic || '') + '</div>' +
    (gone ? '' : '<div class="hr">' + hap + (st.length ? '<span class="hs">' + st.join(' · ') + '</span>' : '') + '</div>') +
    bonusLine + capNote +
    hp + miniItems +
  '</div>';
}


/**
 * 手牌区整体 —— **一条横向的卡带** ＋ 左端一块固定的「这一局」入口。
 *
 * ⚠️ 排序：**主角永远第一张**，然后是「已入队」（按名册序），再是物。
 *   「尚未入队」那组**默认收起**，只在卡带右端留一颗折叠钮 ——
 *   开局真正能派的只有皮普一个人，剩下 9 个是背景，不该占着最好的位置。
 * ⚠️ `folded('peopleOut', …)` 复用**原来那一个**折叠函数与那一个键
 *    （`histMore.peopleOut`）—— 折叠契约（"调用方必须先把最近的排最前"）不因搬家而变。
 */
/**
 * 这个人「没了」吗（2026-10-05）—— 死亡或疯狂。
 *
 * ⚠️ 判据是 `status`（**派生**的，`ledger/types.ts·derivePersonStatus`：
 *    HP≤0 ⇒ 死亡 · SAN≤0 ⇒ 疯狂），**不重新算一遍 HP/SAN** ——
 *    那个函数是账本侧的唯一口径，UI 再写一份就会与它漂。
 * ⚠️ 主角不算：他不能"没了"（`hp≤0` 走的是结局那条路，不是这里）。
 */
function isGone(p){ return !!p && p.id !== 'npc000' && (p.status === '死亡' || p.status === '疯狂'); }

/**
 * 卡带那一条 rail 的**内容**（2026-10-06 抽出来）。
 *
 * 为什么抽出来：事件详情改成**浮层**（用户裁定「画面中间一个额外的弹窗区，
 *   在地图层上方」），而 2026-10-05 关掉浮层的理由是「手牌带要保持可见可拖」
 *   ⇒ 浮层里**自带一块迷你卡带**，内容就是这一条。
 *   刻意**不新写一套**：拖拽源与落点判据（`canDropOn` / `canGiveTo`）**共用同一套**
 *   —— 一旦浮层里另画一遍卡、另判一遍能不能放，两处迟早打架。
 *
 * @returns {string} rail 内部那一串 HTML（**不含**外层 `.hand-rail`）
 */
/**
 * **这次处理台里已经放上去的人**（没开着处理台就返回 null）—— 手牌区据此把他们
 * **从卡带上收起**，而不是"放进去之后原地还在"。
 *
 * ⚠️ 用户原话（2026-10-07 复验第 5 条）：「人物卡**使用后，并没有在手牌区消失**」。
 *   拖进菱形之后卡还在卡带上，等于同一张卡在屏幕上出现两次 ——
 *   而《苏丹的游戏》那一套的语义是"卡被**放进了**那个位"，手上就没有了。
 * ⚠️ **只在处理台开着时**才收起：关掉处理台，选择仍记在 picks 里（再打开还在），
 *   但卡要回到卡带上 —— 否则玩家会以为"这个人没了"。
 * ⚠️ 取回的那条路是**卡槽里的 x**（不是"从手牌区再拖一次"）。
 * ⚠️ 判据是**页面态**（picks），不进账本：点对勾那一刻才是事实。
 */
function deskUsedIds(){
  // ⚠️⚠️ 2026-10-07（用户报告"人还没结算就回来了 / 换开别的事手牌跟着变"）：
  //   收起名单必须是**全局**的，与"现在开着哪张卡"无关 —— 此前它只看 `detailOpen`
  //   那一张 ⇒ 换开别的事件，A 事里放的人就从卡带上冒回来（页面态明明还占着）。
  //   名单两半：
  //   ① **页面态**：任何事件台 `picks` / 功能单 `fixPicks` 里放着、还没点 ✔ 的人
  //     （取回的路不变：拖回手牌带 / 点槽取回）；
  //   ② **账面态**：任何「处理中」（揭晓待办）事件的 `handler` ＋ `participants` ——
  //     点 ✔ 成功后 `picks[evId]` 已被清掉（防金币双扣那一条）⇒ 卡带靠这一半
  //     知道"他还在外面办着"。事件**揭晓**（离开 waiting）那天人自然回来；
  //     医馆/神殿的休养单也在这一半里（handler = 休养者本人，养好才回来）。
  // ⚠️⚠️ 2026-10-08（用户报告"事件结算完要**刷新**才看到被派遣的人物回来"）：
  //   ①页面态的假设破了 —— `commit` 成功后 `picks[evId]` **刻意保留**（回看摆的样子），
  //   事件揭晓结算后它**永远留在页面上** ⇒ 名单一直把"已经回来的人"收着，
  //   卡带不画他，直到刷新（页面态清零）。
  //   ⇒ 修法：①页面态只收**事件还活着**的那几条 —— 待处理（todo）／处理中（waiting）／
  //     档 A 还没点（popups）。已结算（settled）或已离开三池的，页面态不许再收；
  //     ②账面态本来就只看 `waiting`，事件揭晓即离开 ⇒ 自然释放，不用动。
  const s = new Set();
  const v = S && S.view;
  const alive = new Set();
  if (v) {
    for (const e of arr(v.todo)) alive.add(e.id);
    for (const e of arr(v.waiting)) alive.add(e.id);
    for (const e of arr(v.popups)) alive.add(e.id);
  }
  for (const id in picks) {
    const op = picks[id];
    if (op && alive.has(id)) for (const pid of arr(op.participants)) s.add(pid);
  }
  for (const fp in fixPicks) if (fixPicks[fp]) s.add(fixPicks[fp]);
  if (v) for (const e of arr(v.waiting)) {
    if (e.handler) s.add(e.handler);
    for (const pid of arr(e.participants)) s.add(pid);
  }
  return s;
}

function handRailInner(v){
  const me = v.me;
  const all = arr(v.people);
  // ⚠️⚠️ 2026-10-07 用户裁定（第三批）：**同类之内按获得顺序「由新到旧」排** ——
  //   `v.people` 的数组序就是名册序（后来的人排在后面）⇒ 倒过来 = 新来的在前。
  const joined = all.filter((p) => p.affiliated).slice().reverse();
  const outsiders = all.filter((p) => !p.affiliated);
  // ⚠️ 2026-10-05：**已消耗 / 丢失的物品直接从卡带走**（用户裁定「直接消失」）。
  //    数据源是 `Item.consumed` —— 它**早就在 view 里**（`session.ts·itemOf`），
  //    但 UI 此前一处都没渲染 ⇒ 消耗掉的东西在卡带上与新的长得一模一样。
  //    ⚠️ 判据用 `consumed`（`ledger/apply.ts:395` 落账时置位）而不是"不在 items 里"：
  //    后者分不清"用掉了"与"本来就没有"。

  // 卡带：主角 → 已入队 →（折叠钮：物 / 尚未入队的人）
  // ⚠️ 2026-10-05：**物品从"常驻"改成"收在折叠里"**（用户裁定「物品的卡牌这里要做一下」，
  //    选的是"收进可折叠组"）。理由与「尚未入队」那组完全一样：
  //    开局手上只有 1~2 件，它们不该与"我的人"抢卡带最好的位置；
  //    而卡带一放开就是十几张，**眼睛要能一眼扫完**才有用。
  //    ⚠️ **0 件时不画那个折叠钮** —— 一个「身外之物（0）」的空壳
  //      等于每局都在提醒玩家"你什么都没有"。
  // ⚠️ 2026-10-05：**离队 ＝ 回到「尚未入队」**（用户裁定）。
  //    这在数据上**本来就成立** —— `ledger/apply.ts` 落 `affiliated=false`，
  //    于是他自动落进 `outsiders` 那组（那组的判据就是 `!affiliated`）。
  //    ⚠️⚠️ **但账本分不出"离队"与"从未入队"** —— `Person.affiliated` 只有一个 boolean，
  //    全项目**没有任何地方**记"他曾经是你的"。这意味着：
  //      数据侧：离队 = 未入队（已如用户所愿）；
  //      演出侧：**"他曾经是你的人，现在不是了"这句话我们说不出来**。
  //    ⇒ 要让离队刺到玩家，得在账本上加一个"曾经入队过"的痕迹（`everAffiliated`）。
  //      那要动账本形状 ＋ 快照 ＋ 档案，**本轮不动** —— 先把能做的做完。
  let i = 0;
  const rail = [];
  // ⚠️⚠️ 2026-10-08（用户裁定·**无人携带**）：卡带上的物卡 ＝ **没人拿着的东西**
  //    （`holder=null`）—— 它们就是"手牌区"本身。装备中的东西（谁身上的，**含
  //    玩家自己那张卡**）只在人物卡 `@n` 与详情页卡槽里看 —— "手牌区"与"艾德里安
  //    身上"从此是两个地方（此前两件开局物品挂在玩家名下、又以卡带物卡渲染，
  //    玩家把它们从自己卡上拖回手牌区会被"已经在你手上了"顶回来 —— 实测翻车）。
  //    滤掉 `consumed`：被消耗掉的不该还躺在卡带上。
  //    ⚠️ **必须在上面那些 `rail.push` 之前**（见下面那处注释的 TDZ 警告）。
  // ⚠️ 2026-10-07：**已经放进处理台的人**从卡带上收起（见 deskUsedIds 顶栏）。
  const usedIds = deskUsedIds();
  const isUsed = (id) => !!(usedIds && usedIds.has(id));
  // ⚠️⚠️ 2026-10-07 用户裁定（第三批）：**手牌排序＝ 金币 → 人物 → 凭证 → 特殊物品 → 装备**
  //   （消耗品跟在装备后）。同类之内**由新到旧**；「我」恒为人物类第一张。
  //   ⇒ 物品**不再**紧跟在"我"后面 —— 它们整段挪到凭证之后（`itemCards` 在下面 push）。
  const handItems = arr(v.items).filter((it) => !it.consumed && !it.holder).slice().reverse();
  const kindRank = (k) => (k === '特殊物品' ? 0 : k === '装备' ? 1 : 2);   // 消耗品殿后
  const itemCards = handItems.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
    .map((it) => handItemCard(it, i++));
  // ⚠️ 2026-10-05：**金币也是一张卡**（用户裁定：与人物卡一样统一为卡牌）。
  //    它排在**最前**：它是每一件事都可能要垫的那个数，先看到它省一次扫视。
  //    ⚠️ 2026-10-07（用户裁定·串行金币）：显示的是**净额** —— 桌上垫了多少，
  //    这张卡立马扣多少（`haveGold()`）；点 × / 拖回，原额立刻回来。
  //    ⚠️ `data-kind="gold"` 让它落进现成的拖拽源选择器（`.hcard[data-kind]`）——
  //    不必给拖拽系统另开一条路（另开一处就多一处会漂的地方）。
  rail.push(goldCard(haveGold(), i++));
  // ⚠️ 金币卡**不收起**：它是一个**池**（不是"这一件事用掉的那张"），
  //    收起它等于把"我手上还剩多少钱"这个读数抹掉 —— 而垫钱正是靠看它。
  if (!isUsed(me.id)) rail.push(handCard(me, true, i++));
  // ⚠️⚠️ **必须在上面那些 `rail.push` 之后**读 `itemCards`（TDZ 前车之鉴，
  //   见下面那段 2026-10-06 的注释）—— 物品整段挪到凭证之后 ⇒ 推后到这里。
  // ⚠️⚠️ 2026-10-07 用户裁定（第三批）：**手牌排序＝ 金币 → 人物 → 凭证 → 特殊物品 → 装备**
  for (const p of joined) if (!isGone(p) && !isUsed(p.id)) rail.push(handCard(p, false, i++));
  // ⚠️⚠️ 2026-10-06 清单第 4B.4 条（用户裁定第 22 条）：**凭证是新的一种卡牌，放在手牌区**。
  //   ⚠️ **默认不给 `data-kind`** —— 用户原话：「但**只能在『你的欲望』事件中使用**」。
  //     拖拽源的选择器是 `.hcard[data-kind]` ⇒ 不给这个属性就天然拖不动；
  //     那一屏打开时由 `renderOverlay` 末尾的 `enableVoucherDrag()` 补上。
  //     ⇒ 这条纪律**由机制保证**（不给属性），不是靠"在别的事件里判一下然后悄悄收手"。
  //   ⚠️ **排在人卡之后、"没了的人"之前** —— 凭证是"这一局的成绩"，
  //     不该与"我的人"抢最前面那些位置（那几张留给随时要派的人）。
  const placedIds = {};
  {
    const st = vPick();
    for (const dim in st) st[dim].forEach((vid) => { if (vid) placedIds[vid] = 1; });
  }
  // ⚠️ 2026-10-07 用户裁定（第三批）：凭证同类之内**由新到旧**（`l.vouchers` 的数组序
  //   就是获得序 ⇒ 倒过来），且卡面要显示**基本性质**（成果类/事件类/人物情感类凭证）。
  // ⚠️ 成果那一类已由旧名「物品类…」统一更名「**成果类凭证**」（用户裁定第三批第 6 条）。
  const VOUCHER_KIND = { the_great_achievement: '成果类凭证', the_proper_way: '事件类凭证',
    the_resonance_of_the_other: '人物情感类凭证' };
  for (const vc of arr(v.vouchers).slice().reverse()) {
    const used = !!placedIds[vc.id];
    // ⚠️⚠️ 2026-10-07（用户裁定）：**已放进槽里的凭证，手牌区不再显示** ——
    //   卡只有一份：要么在槽上，要么在手上。取回走槽上的「×」（`unplaceVoucher`）。
    if (used) continue;
    rail.push(
      '<div class="hcard voucher' + (used ? ' placed' : '') + '" data-vid="' + esc(vc.id) + '"' +
      ' data-act="detail" data-vdim="' + esc(vc.dim) + '"' +
      // ⚠️ **卡面只有「类型 ＋ 标题」两行**（2026-10-07 用户裁定第 22 条）。
      //   描述在 `sheetVoucher` 里 —— 玩家点开才读。
      //   ⚠️ 原生 `title` 只留一句"点击看详情"，**不塞完整描述**：
      //   完整散文塞进 tooltip 会变成一大坨黄字，而且**换行全被压成一行**。
      ' title="' + esc(vc.dimLabel) + '·' + esc(vc.title) + '　点击看详情">' +
        '<span class="vh">' + esc(vc.dimLabel) + '</span>' +
        '<span class="vt">' + esc(vc.title) + '</span>' +
        // ⚠️ 2026-10-07 用户裁定（第三批）：基本性质一行（像人卡显示 identity 那样）
        '<span class="vi">' + esc(VOUCHER_KIND[vc.dim] || '凭证') + '</span>' +
        // ⚠️ 2026-10-08 用户裁定（第 6 条）：稀有度一行（普通/罕见/珍稀/传说，按档配色见 CSS）
        '<span class="vr" data-r="' + esc(vc.rarity || '普通') + '">' + esc(vc.rarity || '普通') + '</span>' +
      '</div>');
  }
  // ⚠️⚠️ 2026-10-07 用户裁定（第三批）：**物品段在凭证之后**（金币→人物→凭证→特殊物品→装备）。
  for (const it of itemCards) rail.push(it);
  // 死亡 / 疯狂的**排最后**（在"还有 N 件"那颗钮之后）——
  //   他们不是资源了，不该与"我的人"混在同一段里被扫过。
  // 「尚未入队」与「身外之物」共用**同一个折叠钮**（一条"不是我的"的分界）——
  //    两个钮并排会让人以为要分别点，而它们是同一个动作。
  // ⚠️ 2026-10-06（用户裁定）：**未入队的人不能拖** ⇒ 他那张卡**不给 `data-kind`**。
  //    拖拽源的选择器是 `.hcard[data-kind]`（拖拽系统那一条）⇒ 不给这个属性
  //    就天然拖不动，而**点开详情照旧**（`data-act="detail"` 不受影响）。
  //    ⚠️ **不给 `data-kind` 就一并拖不了物给他** —— 那是同一件事：
  //      还没站到你这边的人，你的东西也到不了他手上（见 `canGiveTo`）。
  // ⚠️⚠️⚠️ 2026-10-06 **三处连环改动**后的最终形态（这三件互相咬合，一次说清）：
  //
  //   ① 早先：物品**贴在各人卡下面**（`.carryrow`）——
  //      ⚠️ 后果 A：它**盖住人卡下半部分**，`closest('[data-act]')` 先命中小卡
  //        ⇒ **人卡点不开**（用户报「人物卡怎么点不开」）。
  //      ⚠️ 后果 B：给了「未入队的人不可拖」之后，属下们的卡都不带 `data-kind`，
  //        **他们身上的东西就成了只能看不能拖的** —— 而「物品拖到别人身上」
  //        （`/api/give`）正是**物品唯一的移动方式** ⇒ 交给他人这条路断了。
  //   ② 中间：把携带物从卡面撤掉（用户裁定「人物卡展开后再显示」）⇒ 修好了 A，
  //      但**物品卡本体也一起没了**（它就是画在 `.carryrow` 里的那些）。
  //   ③ **现在**：物品回到**卡带上做独立卡**（不再是附属小片）：
  //      · 人卡干净 ⇒ 点得开（1 修好）；
  //      · 每件东西**都是可拖的源** ⇒ 交给他人这条路通了（2 修好）；
  //      · 「他带了什么」在**点开的详情浮层**里看（`sheetPerson`，已列全
  //        名字/加成/是否生效）—— 那是该裁定的原话。
  //   ⚠️ 物品**不进任何折叠组**（它的家在卡带上）。
  //
  // ⚠️⚠️ 2026-10-06 用户裁定：「**手牌区也不需要尚未入队区**」
  //   ⇒ 下面那三行（折叠钮 ＋ `hiddenN` ＋ `rail.push(...outCards)`）**整段删掉**：
  //     · 折叠钮「尚未入队 N」是手牌区里唯一的"人"入口，删掉它这一区就只剩牌了；
  //     · `outCards`（未入队者的卡）也随之不必进卡带。
  //   ⇒ 名单改在**地图区左上角**那块里看（`leftHtml` 的第二块，含真实人名卡）。
  //   ⚠️ `histMore.peopleOut` 这个折叠状态**仍要保留**：地图区那块
  //   读它来决定"展开还是收着"，否则点开一次之后就再也收不回去了。
  //   ⚠️ `hiddenN` / `outCards` 随之成了死变量 ⇒ 一并删（留着会让读者以为它们还有用）。

  // ── 「没了的人」：**留在卡带上，但排在最后**（2026-10-05 用户裁定）────────
  // ⚠️ 为什么留：清出去等于把后果藏起来 —— 玩家必须看见"少了一个人"。
  //   那些灰卡不能拖、不能点开（`handCard` 里不给 `data-act`），
  //   所以它们不占"可操作"那一段，只是**一个看得见的缺口**。
  const goneList = all.filter((p) => isGone(p));
  if (goneList.length) {
    rail.push('<div class="hand-gonehead" title="他们不再是你的人了">没了的 ' + goneList.length + '</div>');
    for (const p of goneList) rail.push(handCard(p, false, i++));
  }
  // ⚠️⚠️ 2026-06 用户裁定（**改**）：**那个拉手是多余的，撤掉**。
  //   用户的原话：「现在地图下面有个拉手的文本+图标，这个是多余的，
  //   我的意思是把手牌区给拉起来」⇒ 玩家要的是**手牌区向上展开**这件事本身，
  //   不是"一个写着'展开手牌'的按钮"。而那个按钮长在**卡带下面**，
  //   看起来就像地图底边上一行多余的字（实测截图里正是这样）。
  //   ⇒ 撤掉按钮。手牌区**常驻可见**（它本来就只占半屏高），
  //     地图区要更多空间时由**地图自己**去吃剩余高度（`.canvas{flex:1}`）。
  //   ⚠️ 若哪天真要"收起手牌区"，入口应该是**地图区自己的折叠**，
  //     不是在手牌区里放一个说明自己可以收起的按钮。

  return rail.join("");
}

/**
 * 底部手牌区 —— 2026-10-06 起 rail 的组装全在 `handRailInner` 里，
 * 这里只负责把它画进 `#hand`（**一处组装、两处呈现**）。
 */
function renderHand(v){
  const el = $('hand');
  if (!el) return;
  // ⚠️⚠️ 2026-10-07 用户裁定（第三批）：手牌区三段式——
  //   **左端「我想做点什么」方格**（自主创造事件的入口从页脚搬来，要"明显"）＋
  //   **中间卡带**（整体被方格推向右）＋ **右端翻页双箭头**（2026-10-08 用户裁定：
  //   一枚改两枚 —— ‹ 往前翻一页 · › 往后翻一页，手牌溢出时可来回翻看）。
  const compose = (v && v.isOver) ? '' :
    '<button class="hand-compose" data-act="openCompose"' +
    ' title="自己创造一件事 —— 写下你的意图，世界会回应">' +
    '<span class="hcplus">＋</span>我想做点什么</button>';
  el.innerHTML = compose +
    '<div class="hand-rail" data-drop="hand" title="你的手牌 —— 把别处的物品拖到这里＝收回">' + handRailInner(v) + '</div>' +
    '<button class="hand-more" data-act="handPrev" title="手牌往前翻一页">‹</button>' +
    '<button class="hand-more" data-act="handNext" title="手牌往后翻一页">›</button>';
}

function personLine(p, isMe){
  const st = p.status !== '正常' ? ' <span class="hp">' + esc(p.status) + '</span>' : '';
  const tags = [];
  if(isMe) tags.push('剩时 ' + p.ap);
  else tags.push('容量 ' + p.ap);
  if(isMe) tags.push('携带 ' + arr(p.items).length + '/4');
  if(!isMe && p.away) tags.push('在途');
  // ⚠️ 这一支目前**恒不成立**（`personLine` 只被玩家自己那张卡调用，`isMe` 恒 true）——
  //    留着是防它哪天被复用到别人身上；措辞与前两处统一成「尚未入队」。
  if(!isMe && !p.affiliated) tags.push('尚未入队');
  // ⚠️ 2026-10-07 用户裁定：「医 / 祈」小按钮撤掉 —— 恢复的唯一入口在处理台的固定功能卡。
  const rec = arr(p.recognized);
  const recLine = rec.length ? '<span class="sub" style="display:block;font-size:11.5px;color:var(--muted)">他给过的认可：' + rec.map(esc).join('、') + '</span>' : '';
  return '<div class="prow person' + (p.available || isMe ? '' : ' dim') + '">' +
    '<span><span class="nm">' + esc(p.name) + '</span> <span class="sub">' + esc(p.basic) + '</span>' + st + recLine + '</span>' +
    '<span class="sub">HP <b>' + p.hp + '</b> SAN <b>' + p.san + '</b> · ' + tags.join(' · ') + '</span>' +
  '</div>';
}

