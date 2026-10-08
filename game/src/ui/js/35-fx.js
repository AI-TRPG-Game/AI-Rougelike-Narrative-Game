// ═══════════════════════════════════════════════════════════════════
// 九个具体演出（2026-10-06 · 用户逐条点名要的那几个）
// ─────────────────────────────────────────────────────────────────
// ⚠️ 共同约定：
//   · **卡在原地不动，动的永远是替身** —— 真的重排会让人以为界面跳了；
//   · 落点找不到就**静默跳过**（他在折叠里 / 物已被移出）；
//   · 动画**可跳过**（`prefers-reduced-motion`）—— 那时只给终态（亮一下）。
// ═══════════════════════════════════════════════════════════════════

/** ① 新人出现（LLM 造的）—— 按「入队 / 未入队」分流（2026-10-08 用户裁定）：
 *    · 入队 ⇒ 从**结算卡**飞进卡带 ＋「xx 加入了你的队伍」；
 *    · 未入队 ⇒ 从**结算卡**飞进地图左上角的「尚未入队」入口卡
 *      ＋ 3 秒提醒「xx 出现了，你可以在「尚未入队」区域查看」（用户点名 3 秒）。
 *    ⚠️ 起点＝结算卡（`settleRect()`）：结算界面没开着时回退屏幕边缘飞入（老行为）。 */
function flyInPerson(c){
  const from = settleRect();
  if (c.affiliated) {
    const card = cardOfPerson(c.id);
    if (!card) { toast(c.name + ' 加入了你的队伍'); return; }
    spawnFly(from, rectOf(card), 'fly-person joinfly', esc(c.name), 860);
    card.classList.add('arrive');
    setTimeout(function () { card.classList.remove('arrive'); }, 1400);
    toast(c.name + ' 加入了你的队伍');
    return;
  }
  // ⚠️ 未入队的人**不在卡带里**（他落在地图左上角那块）⇒ 落点是「尚未入队」入口卡
  //    （`leftHtml` 给它写了 `id="outsiderszone"`）。入口卡也找不到 ⇒ 只剩那句话。
  const zone = rectOf(document.getElementById('outsiderszone'));
  if (zone) {
    spawnFly(from, zone, 'fly-person leavefly', esc(c.name), 900);
  }
  toast(c.name + ' 出现了，你可以在「尚未入队」区域查看', 3000);
}

/** ② 离册（`lost.people` 那种，他整条从名册消失）：灰掉 ＋ 向上飞走。 */
function flyAwayGone(c){
  const card = cardOfPerson(c.id);
  if (!card) return;
  const to = { left: window.innerWidth + 60, top: -40, width: 40, height: 56 };
  spawnFly(rectOf(card), to, 'fly-person gonefly', esc(c.name), 760);
}

/** ③ 离队（用户特别点名：**必须区别于死亡**）：飞到**未入队区**，卡面**不变灰**。 */
function flyLeave(c){
  const card = cardOfPerson(c.id);
  if (!card) { toast(c.name + ' 离开了'); return; }
  // 落点 ＝ 未入队区（他会被收进折叠）⇒ 那个区的标题
  const zone = document.getElementById('outsiderszone');
  const to = rectOf(zone) || rectOf(card);
  spawnFly(rectOf(card), to, 'fly-person leavefly', esc(c.name), 860);
  card.classList.add('leaving');
  setTimeout(function () { card.classList.remove('leaving'); }, 1400);
}

/** ④ 入队：从未入队区飞回卡带 ＋「xx 加入了你的队伍」（2026-10-08 用户裁定：入队也要提醒）。 */
function flyJoin(c){
  const card = cardOfPerson(c.id);
  if (!card) { toast(c.name + ' 加入了你的队伍'); return; }
  const zone = document.getElementById('outsiderszone');
  const from = rectOf(zone);
  if (from) spawnFly(from, rectOf(card), 'fly-person joinfly', esc(c.name), 860);
  card.classList.add('arrive');
  setTimeout(function () { card.classList.remove('arrive'); }, 1400);
  toast(c.name + ' 加入了你的队伍');
}

/** ⑤ 状态变了（重伤 / 濒死 / 死亡 / 疯狂）：就地亮一下 ＋ 卡面闪。 */
function flashPerson(c){
  const card = cardOfPerson(c.id);
  if (!card) { toast(c.name + ' ' + c.from + ' → ' + c.to); return; }
  const bad = (c.to === '死亡' || c.to === '疯狂');
  card.classList.add(bad ? 'flash-bad' : 'flash-warn');
  setTimeout(function () { card.classList.remove('flash-bad', 'flash-warn'); }, 1500);
}

/** ⑥ 物品**获得**：从**结算卡**飞进手牌区（2026-10-08 用户点名「卡牌从结算卡飞到手牌区」；
 *    结算界面没开着时回退屏幕边缘飞入）。落点可能是**人卡**（东西长在主人卡下的
 *    `.carryrow`）⇒ 两者都试。 */
function flyInItem(c){
  const card = cardOfItem(c.id);
  const to = rectOf(card) || rectOf(c.holder ? cardOfPerson(c.holder) : null);
  if (!to) { toast('得到了 ' + c.name); return; }
  spawnFly(settleRect(), to, 'fly-item', esc(c.name), 820);
  if (card) {
    card.classList.add('arrive');
    setTimeout(function () { card.classList.remove('arrive'); }, 1400);
  }
}

/** ⑦ 物品**消耗**（用户点名：撕毁动画）：撕开 ＋ 碎屑落下 ＋ 消失。 */
function tearItem(c){
  const card = cardOfItem(c.id);
  const box = card || document.querySelector('.fly-item');
  if (!box) { toast(c.name + ' 用掉了'); return; }
  if (box) {
    box.classList.add('torn');
    setTimeout(function () { box.classList.remove('torn'); }, 1000);
  }
  // ⚠️ 替身也要撕 —— 主人卡上的小卡可能正好在折叠区里看不到
  const holderCard = card ? card.closest('.hcard') : null;
  const r = rectOf(card) || rectOf(holderCard);
  if (r) {
    const f = spawnFly(r, { left: r.left, top: r.top + 30, width: r.width, height: r.height },
      'fly-item tornfly', esc(c.name), 900);
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1000);
  }
}

/** ⑧ 物品**失去**（被毁 / 被抢 / 落水）：灰掉 ＋ 飞走（⚠️ **与撕毁不同**）。 */
function flyAwayItem(c){
  const card = cardOfItem(c.id);
  const r = rectOf(card);
  if (!r) { toast('失去了 ' + c.name); return; }
  const to = { left: window.innerWidth + 60, top: window.innerHeight - 40, width: r.width, height: r.height };
  spawnFly(r, to, 'fly-item lostfly', esc(c.name), 820);
}

/** ⑨ 转移（借出 / 收回）：小方块从旧主人飞到新主人。 */
function flyMoveItem(c){
  const from = c.from === S.view.me.id ? null : cardOfPerson(c.from);
  const to = c.to === S.view.me.id ? null : cardOfPerson(c.to);
  const fromR = rectOf(from);
  const toR = rectOf(to);
  // ⚠️ 两头都得在屏幕上才演得出来；有一头收着 ⇒ **给一句提示**（静默最坏）
  if (!fromR || !toR) { toast(c.name + ' 转手了'); return; }
  spawnFly(fromR, toR, 'fly-item', esc(c.name), 860);
  const target = to || cardOfPerson(c.to);
  if (target) {
    target.classList.add('arrive');
    setTimeout(function () { target.classList.remove('arrive'); }, 1400);
  }
}

/** ⑩ 数值变化：那处**亮一下** ＋ 数字滚过去（复用 `rollNumber`，不重写）。 */
function flashNum(c){
  // 落点：顶栏（金币/欲念/声望）或者那张人的卡（他的 HP/SAN）
  const sel = c.path === 'gold' ? '.tb-gold'
    : c.path === 'desire' ? '.tb-desire'
    : c.path.indexOf('rep.') === 0 ? '.tb-rep'
    : cardOfPerson(c.who);
  const el = sel && sel.querySelector ? sel : (typeof sel === 'string' ? document.querySelector(sel) : sel);
  if (!el) { toast(c.label + ' ' + (c.delta > 0 ? '+' : '') + c.delta); return; }
  el.classList.add(c.delta > 0 ? 'flash-up' : 'flash-down');
  setTimeout(function () { el.classList.remove('flash-up', 'flash-down'); }, 1500);
  // ⚠️ 数字滚动只在**有 `.mdb` 那种可滚的元素**上做（结算屏那种）；
  //    卡面上的 HP 条是连续读数，改宽度更合适 —— 这里只亮不滚。
}


/**
 * 这是不是**一次性**的（消耗品）—— UI 侧的小标记与 `buildChanges` 的演出一档共用它。
 *
 * ⚠️ **判据只有这一条**（`kind === '消耗品'`），与 `rules/ability.ts·isOneShot` 字面一致。
 *    ⚠️ 这里**没有** import 规则层那个函数：整个 `index.html` 是**零依赖**的单文件
 *    （浏览器直接开，没有构建步骤）⇒ 两处各写一个字面量，**由这条注释担保它们一致**。
 */
function isOneShotKind(kind){ return kind === '消耗品'; }

/** 判一个人"没了"（死亡/疯狂）—— 只认 `status`（**派生**的，账本侧唯一口径） */
function isGoneStatus(st){ return st === '死亡' || st === '疯狂'; }

/**
 * 一张**物卡**（卡带上"无人携带"的东西，2026-10-06 恢复为卡带上的**独立卡**）。
 *
 * ⚠️⚠️ **它为什么必须是独立卡，而不是贴在人卡下的小片**（这一条是踩出来的）：
 *   早先它画在人卡下面的 `.carryrow` 里，连锁出两个问题——
 *     · 它**盖住人卡下半部分**，`closest('[data-act]')` 先命中小卡
 *       ⇒ 「人物卡点不开」；
 *     · 属下的卡不带 `data-kind`（未入队者不可拖）⇒ **他身上的东西拖不动**，
 *       而「交给别人」**只能靠拖**（`/api/give`）⇒ 这条路整个断掉。
 *   ⇒ 独立成卡：人卡干净（点得开）、每件东西都是可拖的源（交得出去）。
 *   「他带了什么」在**点开的详情浮层**里看（`sheetPerson` 的「携带」一节）。
 *
 * ⚠️⚠️ 2026-10-08（用户裁定·**无人携带**）：卡带上的物卡 ＝ **没人拿着**的东西
 *   （`holder=null`）。它们没有 `data-to-whom`（不是"在谁名下"—— 没有谁）；
 *   拖到人物卡 ＝ 装备给他；已经装备着的（含玩家自己卡上的）**不在这里**，
 *   要摘下得点开那个人、从他的卡槽里拖回手牌区。
 *
 * @param it view 里的物品（`{id, name, kind, bonus[], …}`）
 * @param i 卡带序号（`style="--i"`，CSS 变量，控制进场次序）
 */
function handItemCard(it, i){
  const one = isOneShotKind(it.kind);
  return '<div class="hcard item k' + esc(it.kind || '特殊物品') + '" style="--i:' + i + '"' +
    ' data-act="detail" data-kind="item" data-id="' + it.id + '"' +
    ' data-name="' + esc(it.name) + '"' +
    // ⚠️ 2026-10-08（无人携带）：`data-holder=""` —— 拖拽源记它"没在任何人身上"
    //    （`dragSrc.holder` 的缺省也改成了 ''，见 pointerdown 那段）。
    ' data-holder=""' +
    ' title="' + esc(it.name) + ' —— 点开看；按住拖到某人身上＝装备给他">' +
    '<div class="hn">' + esc(it.name)
      + (one ? '<span class="hone" title="他办完一件事就用掉了">尽</span>' : '') +
    '</div>' +
    // ⚠️ 2026-10-07 用户裁定（第三批）：物卡也要显示**基本性质**（像人卡显示 identity 那样）
    '<div class="hi">' + esc(it.kind || '特殊物品') + '</div>' +
    // ⚠️ 2026-10-07：加成改成**绿词条＋属性图标**（`bonusTags`）——
    //   原先那行是「物品小图标 ＋ 素文本」，小图标在 9px 下糊成一个"o"，
    //   用户原话：「之前有的那个好看的绿色词条和里面的『争斗』属性图标怎么没了」。
    (arr(it.bonus).length ? '<div class="hb2">' + bonusTags(it.bonus, 9) + '</div>' : '') +
  '</div>';
}

/** 人按 id 建索引（`view.people` ＋ 主角） */
function indexPeople(v){
  const m = {};
  const push = (p) => { if (p) m[p.id] = p; };
  push(v.me);
  arr(v.people).forEach(push);
  return m;
}

/** 物按 id 建索引：id → `{name, kind, holder}`（**跨所有人**） */
function indexItems(v){
  const m = {};
  const push = (p) => arr(p && p.items).forEach((it) => {
    if (it) m[it.id] = { name: it.name, kind: it.kind, holder: p.id };
  });
  push(v.me);
  arr(v.people).forEach(push);
  return m;
}


/**
 * 数值差：**每个**读数都报，绝不漏掉任何一处。
 * @returns `[{kind:'num', path, label, from, to, delta, who}]`
 */
function numDiffs(before, after){
  const out = [];
  const push = (path, label, a, b, who) => {
    if (typeof a === 'number' && typeof b === 'number' && a !== b) {
      out.push({ kind: 'num', path: path, label: label, from: a, to: b, delta: b - a, who: who || '' });
    }
  };
  // 主角与全局
  push('gold', '金币', before.gold, after.gold);
  push('desire', '欲念',
    before.desire ? before.desire.value : 0, after.desire ? after.desire.value : 0);
  const repA = before.rep || {}, repB = after.rep || {};
  for (const k of Object.keys(repB)) push('rep.' + k, k, repA[k] || 0, repB[k]);
  // ⚠️ 每人 HP/SAN —— 旧的那份 `readMeters` 只抄主角的，这里**全都报**
  // ⚠️ 六维属性**不在这里报**（2026-10-07 用户裁定）：属性的动画不好做，
  //    改为在**结算卡**上写一行「谁谁谁 某属性 +x」的小字（见 `attrChangeLines`）。
  const bp = indexPeople(before), ap = indexPeople(after);
  for (const id of Object.keys(ap)) {
    const p = bp[id], q = ap[id];
    if (!p) continue;
    push(id + '.hp', 'HP', p.hp, q.hp, id);
    push(id + '.san', 'SAN', p.san, q.san, id);
  }
  return out;
}

/**
 * 六维属性的**文字版变化清单**（2026-10-07 用户裁定）——
 * 属性变化的动画不好做，就在结算卡上写一行小字：「某某 争斗 +1」。
 * @returns `[{name, attr, delta}]`（只含真变了的那几条）
 */
function attrChangeLines(before, after){
  const out = [];
  if (!before || !after) return out;
  const ADV = ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'];
  const bp = indexPeople(before), ap = indexPeople(after);
  for (const id of Object.keys(ap)) {
    const p = bp[id], q = ap[id];
    if (!p) continue;
    for (const k of ADV) {
      const a = (p.attrs || {})[k] || 0, b = (q.attrs || {})[k] || 0;
      if (a !== b) out.push({ name: q.name || p.name || id, attr: k, delta: b - a });
    }
  }
  return out;
}

function readMeters(v){
  if (!v) return null;
  return {
    gold: v.gold,
    desire: v.desire ? v.desire.value : 0,
    rep: Object.assign({}, v.rep || {}),
    hp: v.me ? v.me.hp : 0,
    san: v.me ? v.me.san : 0,
  };
}

/**
 * 比出两份 view 的差 —— **只报非零的那些**。
 * @returns `[{key, label, from, to, delta}]`
 */
function meterDiffs(before, after){
  if (!before || !after) return [];
  const out = [];
  const push = (key, label, a, b) => {
    if (typeof a === 'number' && typeof b === 'number' && a !== b) {
      out.push({ key: key, label: label, from: a, to: b, delta: b - a });
    }
  };
  push('gold', '金币', before.gold, after.gold);
  push('desire', '欲念', before.desire, after.desire);
  push('hp', 'HP', before.hp, after.hp);
  push('san', 'SAN', before.san, after.san);
  // 声望：逐项比（侠名/怪名/…），只报变动的那几项
  for (const k of Object.keys(after.rep || {})) {
    push('rep:' + k, k, (before.rep || {})[k] || 0, after.rep[k]);
  }
  return out;
}

/**
 * 一行「资源怎么动了」—— 出现在结算浮层里，**在正文之下、确认之上**。
 * ⚠️ 数字用 `rollTo` 从旧值**滚到**新值（不是直接写终值）—— 直接写的话
 *    玩家看到的仍是"一个数字变了"，只有"看见它滚过去"才构成一次事件。
 * ⚠️ 涨跌各有颜色与方向箭头，且**箭头是形状**不是"+" "-"（色觉障碍也读得出）。
 */
function meterDeltaHtml(diffs){
  if (!diffs.length) return '';
  const items = diffs.map(function (d, i) {
    const up = d.delta > 0;
    return '<span class="mdl ' + (up ? 'up' : 'dn') + '" style="--i:' + i + '">'
      + '<span class="mdk">' + esc(d.label) + '</span>'
      + '<span class="mddir" aria-hidden="true">' + (up ? '▲' : '▼') + '</span>'
      + '<span class="mdb" data-from="' + d.from + '" data-to="' + d.to + '">'
        + (up ? '+' : '') + d.delta + '</span>'
      + '<span class="mdabs">' + d.from + ' → ' + d.to + '</span>'
      + '</span>';
  }).join('');
  return '<div class="meters">' + items + '</div>';
}

/**
 * 属性变化的那几行**小字**（2026-10-07 用户裁定）—— 出现在结算卡里、
 * 资源增减词条之下：「某某 争斗 +1」。没有变化就不画这一块。
 * ⚠️ 与 `.meters` 同族的小字排版；涨跌用符号带出（+ / −），不再另做动画。
 */
function attrChangeHtml(lines){
  if (!lines || !lines.length) return '';
  const items = lines.map(function (c) {
    return '<span class="acline">' + esc(c.name) + ' <b>' + esc(c.attr) + '</b> '
      + (c.delta > 0 ? '+' : '') + c.delta + '</span>';
  }).join('');
  return '<div class="attrlines">' + items + '</div>';
}

/**
 * 把 `[data-from][data-to]` 的数字从旧值滚到新值。
 * ⚠️ **在 `render()` 之后调**（DOM 已经是新的），且**幂等**（`dataset.done` 防重滚）——
 *    `render()` 一个动作会跑一次，而结算浮层的 `innerHTML` 也可能被重画。
 */
function rollMeters(){
  var nodes = document.querySelectorAll('.mdb[data-from][data-to]');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (el.dataset.done === '1') continue;
    el.dataset.done = '1';
    var from = Number(el.dataset.from), to = Number(el.dataset.to);
    if (!isFinite(from) || !isFinite(to) || from === to) { el.textContent = String(to); continue; }
    rollNumber(el, from, to, 620);
  }
}

/** 把一个元素的数字从 `a` 滚到 `b`（rAF 驱动，只改 textContent ⇒ 不引发布局抖动） */
function rollNumber(el, a, b, ms){
  if (!el || !window.requestAnimationFrame) { el.textContent = String(b); return; }
  var t0 = performance.now();
  // 缓动：减速收尾（与 `--ease` 同一套读感）
  function step(now){
    var k = Math.max(0, Math.min(1, (now - t0) / ms));
    var e = 1 - Math.pow(1 - k, 3);
    var val = a + (b - a) * e;
    el.textContent = (Math.abs(val - Math.round(val)) < 0.02 ? String(Math.round(val))
      : val.toFixed(1));
    if (k < 1) window.requestAnimationFrame(step);
    else el.textContent = String(b);
  }
  window.requestAnimationFrame(step);
}

/**
 * 把一段结算文字拆成**句**，逐段浮现。
 *
 * ⚠️ 为什么拆句不拆字：逐字浮现会打断阅读（玩家读到"他犹豫了一"就被迫看下一个字）。
 *   句子是中文的天然停顿 —— 按 `。！？；` 断，读起来才是一句一句落定。
 * ⚠️ 断点**保留**（句号跟着前一段走），否则拼回去会少标点。
 * ⚠️ 超过 12 段就**不再拆**（退化成一整块）—— 一段 20 句的结算逐句播要 2.4s，
 *   那是在拖时间，不是在演出。
 */
/**
 * **判定盘** —— 结算浮层左侧那块"这次成没成"（学《苏丹》左盘右纸的对位）。
 *
 * ⚠️ 它**只回答判定**，不回答"发生了什么" —— 后者是右边那叠纸的事。
 *   两者混在一屏里，玩家要同时读数字和叙事，眼睛无处落。
 * ⚠️ **没有 `view.roll` 就不画**（档 A 点选 / 场景轮次 / 直接成功失败都不掷骰）。
 *   刻意**不画一个空的盘** —— 一个"今天没掷骰"的占位框只会让人以为坏了。
 *
 * 盘面四行，自上而下是**判定的因果链**：
 *   ① 参与属性符号（用掉了哪几枚）② 主事者 ③ d20 → 修正 → R ④ A 与档位
 * ⚠️ **端点恒定那条例外要显式说**（1 / 20）：`rules/check.ts` 里它是**先于一切修正**判的，
 *   玩家看到"d20=20 却按大失败算"会以为算错了 —— 得告诉他这是规矩。
 */
function rollPanelHtml(v){
  const r = v && v.roll;
  if (!r) return '';
  const ep = r.endpoint
    ? '<div class="rlep">端点 ' + r.raw + ' · <b>' + esc(r.endpoint) + '</b>（先于一切修正）</div>'
    : '';
  const mod = r.diceRolls.length
    ? '<span class="rlmod">修正 ' + (r.modifierTotal >= 0 ? '+' : '') + r.modifierTotal
      + '（' + r.diceRolls.map((d) => (d >= 0 ? '+' : '') + d).join(' ') + '）</span>'
    : '<span class="rlmod">无修正</span>';
  const attrs = arr(r.attrs).map(function (k) {
    return '<span class="esig mini" title="' + esc(k) + '">' + attrSigil(k, 16) + '</span>';
  }).join('');
  return '<div class="rollpanel t' + (esc(r.tier) === '大成功' || esc(r.tier) === '困难成功' || esc(r.tier) === '成功' ? 'ok' : 'no') + '">'
    + '<div class="rlrow rlwho"><span class="rlk">主事</span>'
      + '<span class="rlv">' + esc(r.leaderName) + '</span></div>'
    + '<div class="rlrow rlattrs"><span class="rlk">用到的</span>' + (attrs || '<span class="rlv">—</span>') + '</div>'
    + '<div class="rldie" title="d20 原始 ' + r.raw + ' → 修正后 ' + r.adjusted + '">'
      + '<span class="rldnum" data-raw="' + r.raw + '">' + r.raw + '</span>'
      + '<span class="rld20">d20</span></div>'
    + '<div class="rlrow rlarith"><span class="rldnum small" data-adj="' + r.adjusted + '">' + r.adjusted + '</span>'
      + '<span class="rleq">=' + r.raw + ' ' + (r.modifierTotal >= 0 ? '+' : '−') + ' ' + Math.abs(r.modifierTotal)
      + '</span>' + mod + '</div>'
    + '<div class="rlvs">要 <b>' + r.a + '</b> · ' + esc(r.tier) + '</div>'
    + ep
    + '</div>';
}

function segmentHtml(text, cls){
  // ⚠️ 2026-10-07：先净化再切段 —— 结算正文是 LLM 散文的重灾区（标点旁夹空格）。
  const t = tidyProse(text);
  if (!t) return '';
  const parts = t.split(/(?<=[。！？；])/);
  if (parts.length > 12) return '<span class="' + cls + '">' + esc(t) + '</span>';
  return parts.filter(Boolean).map(function (s, i) {
    return '<span class="' + cls + '" style="--seg:' + i + '">' + esc(s) + '</span>';
  }).join('');
}

function handledHtml(){
  const opts = arr(handled.options).map((t, i) =>
    '<button class="opt' + (i === handled.chosen ? ' picked' : ' dim') + '">' + esc(t) + '</button>').join('');
  const res = handled.result
    ? '<div class="res"><div class="sub" style="color:var(--muted)">结果</div><div>'
        + segmentHtml(handled.result, 'segline') + '</div></div>'
    : '<div class="res"><div class="sub" style="color:var(--muted)">这一步没有带来什么下文。</div></div>';
  // ⚠️ 2026-10-05：资源增减**演出来**（`meterDiffs` 是纯 UI 侧算的，零请求）。
  //    它排在「结果」之后、确认之前 —— 玩家的视线是「读结果 → 看变了什么 → 确认」。
  // ⚠️ `rollPanelHtml` 返回 `''` 时（这一次没掷骰）整个 `rlwrap` 也塌成空 ——
  //    刻意不给它留位置：空盘会被读成"坏了"。
  // ⚠️ 盘与纸**并排**（`.rlpair`）：左盘右纸是这一屏的骨架，
  //    盘只占 210px，其余全给正文 —— 数字不该占掉叙事的宽度。
  return eventCardHtml(handled) + opts
    + '<div class="rlpair">'
      + '<div class="rlleft">' + rollPanelHtml(S && S.view) + '</div>'
      + '<div class="rlright">' + res + meterDeltaHtml(meterDiffs(beforeMeters, readMeters(S && S.view))) + '</div>'
    + '</div>'
    + '<div class="ops" style="margin-top:12px"><button class="primary" data-act="ackHandled">确认</button></div>';
}

// ═══ 骰子动画弹窗（2026-10-07 用户裁定）══════════════════════════
//
// 规则回顾（`rules/check.ts` · `rules/dice.ts` · `rules/ability.ts`，动画必须照它演）：
//   · **A = 主事者参与属性的均值**（向下取整、≤3 项、含物品加成，钳 [1,20]）
//     —— 多个属性时就是**取平均**，不是取最高；
//   · 原始 d20：自然 20 ⇒ 大失败、自然 1 ⇒ 大成功，**先于一切修正**（端点局不掷修正骰）；
//   · 其余：R = d20 + 修正 —— **惩罚骰是 +d4、奖励骰是 −d4**（三源合计钳 ±2 个）；
//   · 档位：R≤⌊A/5⌋ 大成功 · R≤⌊A/2⌋ 困难成功 · R≤A 成功 · 否则失败。
// ⇒ 回答"惩罚骰/奖励骰是 4 面还是 6 面"：**都是 d4（四面骰）**。
//
// ⚠️ 动画是**纯展示**：骰在排布那一刻就掷完了（服务端 `handleEvent`），
//    这里播的正是那份既定结果 —— 不掷第二次、不重算。
// ⚠️ 动画实现：**纯 CSS/JS**（抖动 + 数字闪烁 + 落定缩放），不引外部骰子库 ——
//    项目是零依赖单文件，而 three.js 那族 3D 骰子（几百 KB）只为一次演出不值；
//    CSS 那族的好处是**落点可以钉死在既定值上**（3D 物理骰反而难保证落点）。

/** 惩罚/奖励骰各几个（端点局一个修正骰都没有 —— `diceRolls` 是空的） */
function diceSplit(d){
  if (d.modifierTotal > 0) return { pen: d.diceRolls.length, bon: 0 };
  if (d.modifierTotal < 0) return { pen: 0, bon: d.diceRolls.length };
  return { pen: 0, bon: 0 };
}

/** 结果算式那一行（掷完才出现）：20面骰 +（奖励骰和）−（惩罚骰和）= R，档位 */
function diceResultLine(d){
  if (d.endpoint) {
    return '<div class="diceres">投掷结果：20面骰 <b>' + d.raw + '</b>'
      + '（端点 ' + d.raw + ' · 先于一切修正）—— <b>' + esc(d.tier) + '</b></div>';
  }
  const sp = diceSplit(d);
  const bonRolls = sp.bon ? d.diceRolls.slice(0, sp.bon) : [];
  const penRolls = sp.pen ? d.diceRolls.slice(sp.bon) : [];
  const bonSum = bonRolls.reduce((a, b) => a + b, 0);
  const penSum = penRolls.reduce((a, b) => a + b, 0);
  let s = '投掷结果：20面骰 <b>' + d.raw + '</b>';
  if (sp.bon) s += ' +（奖励骰 ' + bonRolls.join('+') + ' = ' + bonSum + '）';
  if (sp.pen) s += ' −（惩罚骰 ' + penRolls.join('+') + ' = ' + penSum + '）';
  return '<div class="diceres">' + s + ' = <b>' + d.adjusted + '</b>，<b>' + esc(d.tier) + '</b></div>';
}

/**
 * 骰子动画弹窗本体 —— 左 1/2 骰区（点击投掷）、右 1/2 处理信息 ＋「查看结算结果」。
 * ⚠️ `diceState.rolled` 为真时骰面**直接渲染既定值** —— 重渲染（比如窗口变化）不重播。
 */
function dicePopupHtml(r){
  const d = r.roll;
  const sp = diceSplit(d);
  // ── 左 1/2：骰区 ──
  const num = (side, i) => {
    if (!diceState.rolled) return '?';
    if (side === 'd20') return d.raw;
    if (side === 'p') return d.diceRolls[i];
    return d.diceRolls[sp.pen + i];   // 奖励骰排在惩罚骰后面（服务端就是一份连续数组）
  };
  const dice = ['<div class="die d20"><div class="dshape"><span class="dnum">' + num('d20') + '</span></div><span class="dtag">d20</span></div>'];
  for (let i = 0; i < sp.pen; i++) {
    dice.push('<div class="die d4 pen" data-i="' + i + '"><div class="dshape"><span class="dnum">' + num('p', i) + '</span></div><span class="dtag">惩罚</span></div>');
  }
  for (let i = 0; i < sp.bon; i++) {
    dice.push('<div class="die d4 bon" data-i="' + i + '"><div class="dshape"><span class="dnum">' + num('b', i) + '</span></div><span class="dtag">奖励</span></div>');
  }
  const left =
    '<div class="diceleft' + (diceState.rolled ? ' done' : '') + '" data-act="diceRoll" title="点击投掷">'
    + '<div class="dicepit">' + dice.join('') + '</div>'
    + (diceState.rolled ? diceResultLine(d) : '<div class="dicehint">点击画面进行投掷</div>')
    + '</div>';
  // ── 右 1/2：处理信息（事件标题 ＋ 处理者卡槽 ＋ 判定属性 ＋ 骰况）──
  const meId = S && S.view && S.view.me ? S.view.me.id : '';
  const ps = arr(d.participants);
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const p = ps[i];
    if (!p) { slots.push('<div class="dslotcard empty"></div>'); continue; }
    const lead = p.name === d.leaderName;
    slots.push('<div class="dslotcard' + (lead ? ' lead' : '') + '" data-pid="' + esc(p.id) + '">'
      + '<span class="nm">' + esc(p.name) + '</span>'
      + '<span class="sub">' + (lead ? '主事者' : (p.id === meId ? '我' : '随行')) + '</span>'
      + '</div>');
  }
  const attrLine = arr(d.attrs).length
    ? '判定属性为 ' + d.attrs.map((a) => esc(a.attr) + '（<b>' + a.value + '</b>）').join(' 和 ')
      + '，实际生效数值为均值 <b>' + d.mean + '</b>'
      + (d.a !== d.mean ? '（属性顶破天花板，钳为 ' + d.a + '）' : '')
    : '这次没有声明判定属性';
  const diceLine = (sp.pen || sp.bon)
    ? '根据场景情况，本次投掷有 <b>' + sp.pen + '</b> 个惩罚骰、<b>' + sp.bon + '</b> 个奖励骰'
    : '根据场景情况，本次投掷没有惩罚骰与奖励骰';
  const right =
    '<div class="diceright">'
    + '<div class="dtitle">' + esc(r.title || '投掷判定') + '</div>'
    + '<div class="drow"><span class="dk">处理者</span><div class="dslots">' + slots.join('') + '</div></div>'
    + '<div class="drow">' + attrLine + '</div>'
    + '<div class="drow">' + diceLine + '</div>'
    + '<div class="ops" style="margin-top:auto"><button class="primary" data-act="diceGo"'
      + (diceState.rolled ? '' : ' disabled')
      + ' title="' + (diceState.rolled ? '' : '先投掷，才看得到结算结果') + '">查看结算结果</button></div>'
    + '</div>';
  return '<div class="dicegrid">' + left + right + '</div>';
}

// ═══════════════════════════════════════════════════════════════════
// 画布的平移与缩放（2026-10-05 · 学《苏丹的游戏》的可拖地图）
// ─────────────────────────────────────────────────────────────────
// 用户裁定这一步做到「**只加拖动与缩放**」——不把事件按地点摆成真地图
//（那会与《设定.md》「不搭地图系统、不设区域层级」冲突，也会造出一个
//  玩家能看见却走不动的假世界）。
//
// 四条纪律：
//   ① **纯 Pointer Events**：HTML5 的 `dragstart/drop` 在触屏上是坏的。
//      不用 `wheel` 事件而用 `wheel` 的 `preventDefault` —— 页面滚动会
//      抢走它，必须在 `passive:false` 的监听里拦。
//   ② **缩放锚在指针上**：以指针所指的那一点为不动点缩放，
//      否则"滚轮缩放"会让目标漂走（缩到一半发现看不清自己要看的东西了）。
//   ③ **范围钳制**：0.6×~2.2×。再小事件块会小到点不准，再大画布会空到没有信息。
//   ④ **平移也钳制**：不许把整个台面拖出窗口 —— 否则玩家会"找不到自己的地图"，
//      而那是一种很具体的迷路感。可视范围随缩放放宽（放大后允许拖更远）。
//
// ⚠️ 状态活在页面上（不落账本）⇒ `resetLocalViewState()` 里一起清：
//    读档 / 换局之后地图回到原位。
// ⚠️ **拖动平移与拖拽派人是两套手势**，靠"起手点"分开：
//    手指/鼠标落在**空白**处 ＝ 平移；落在**卡片**上 ＝ 派人的拖拽。
//    两者都用 Pointer Events，但一个走 `closest('.cvchip')` 一个不走。
