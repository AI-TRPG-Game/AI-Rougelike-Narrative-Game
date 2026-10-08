// ── 最终任务清单（左栏 · 全周常驻）─────────────────────────────
//
// 三格要在第 28 天才放，但**候选从第 1 天起就在长**（《设定.md·凭证机制》）：
//   成果 = 自己手上（或无主）的物品 · 手段 = 已经了结的事 · 共鸣 = 给过你认可的人。
// ⚠️ 候选池只读 `v.placementPools`（`turn/simulate.ts` 的**唯一口径**）——这里只是**取名字**，
//    没有任何筛选逻辑（UI 自己筛过一份，2026-09-21 才修掉：那会儿连佩在身上的短匕首都进过成果池）。

/** `[{id, ...}]` → `id → 元素` 的查找表 */
/**
 * 某个人**能不能派去办这件事** —— 点选与拖拽**共用这一份**判据（2026-10-05）。
 *
 * ⚠️ 为什么要抽成函数：这两条路先前**各判各的**，而只有点选那条判了"这个人调不调得动"
 *    （`p.available`）⇒ 拖一张**未入队**的人卡进「人」槽，它就进了 `participants`，
 *    一直挂到点「派人去」才被服务端闸门 ③ 拒（"我点得动、提交就报错"）。
 *    与其把判据抄第二遍，不如让它只有一个出处。
 * ⚠️ 口径与规则层**逐字同源**：`available` 由 `session.ts·personOf` 调 `isAvailable` 得出，
 *    而 `isAvailable` 的第一行就是 `if (!p.affiliated) return false`（`ledger/types.ts:489`）——
 *    **未入队 ⇒ 必然调不动**。`canDispatch` 是这件事自己的 `dispatchable`（`仅亲自` ⇒ 一个都派不了）。
 * ⚠️ 玩家本人**不走这个判据**：他的预算在 `clock.usedToday` 里、不是 `byNpc`，
 *    「我亲自」那一行由 `canSelf` 单独管（闸门 ① / ② 各有专属那条）。
 */
function canDispatchTo(p, ev){
  return !!p && p.available && ev.dispatchable !== '仅亲自';
}

/**
 * 派不动他的**那一条原因**（`''` = 调得动）—— 给「调不动」那一组报一句人话。
 * ⚠️ 顺序 = `isAvailable` 的判定顺序（先归属、再身体、最后在不在路上），
 *    所以玩家看到的第一条理由永远是"真正卡住他的那一条"，不是后面顺带的那些。
 * ⚠️ **不编造理由**：`affiliated` 为真但 `available` 为假，只有三种可能，逐个落到具体状态上；
 *    一种都套不上就回一句通用的话（宁可笼统，也不给一条编出来的具体伤情）。
 */
function blockedReason(p){
  if (!p.affiliated) return '尚未入队';
  if (p.status === '死亡') return '已经死了';
  if (p.status === '疯狂') return '已经疯了';
  if (p.away) return '在途';
  if (p.hp <= 1) return '只剩一口气';
  if (p.san <= 1) return 'SAN 见底';
  return '今天调不动';
}

function byId(list){ const m = new Map(); for (const x of arr(list)) m.set(x.id, x); return m; }
/** 三格各自的候选池 ＋ 取名函数（左栏清单与第 28 天那三格**共用这一份**） */
function poolView(v){
  const pools = v.placementPools || { 成果: [], 手段: [], 共鸣: [] };
  const im = byId(v.items), em = byId(arr(v.settled).concat(arr(v.waiting))), pm = byId(v.people);
  return {
    pools,
    成果: (id) => { const i = im.get(id); return i ? i.name : ''; },
    手段: (id) => { const e = em.get(id); return e ? '「' + e.title + '」' : ''; },
    共鸣: (id) => { const p = pm.get(id); return p ? p.name : ''; },
  };
}

/**
 * 清单的**全量**一行 —— 只在「详情浮层」里用。
 * ⚠️ 卡面上那颗 tag 的文本是 `成果 2`，**不是** `pl成果` —— `render-check.mjs` 有一条
 *    「玩家面上没有三个下拉框（`pl成果` / `pl手段`）」的断言，别把这两个字连起来。
 */
function plRow(label, hint, names){
  return '<div class="r"><span class="tag">' + label + ' ' + names.length + '</span>' +
    '<span class="lst"><span class="sub">' + esc(hint) + '</span><br>' +
    (names.length ? esc(names.join('、')) : '（还没有）') + '</span></div>';
}

/**
 * 六维 ── 一排小格。**只在「点开」之后出现**：卡面上一律不列。
 * ★越界报备：这是 B 轮唯一一处「点开才有的新信息」（此前只看得到玩家自己的六维）。
 *   要撤回，删掉 `sheetPerson` 里那一行 `attrGrid(p)` 就行。
 */
/**
 * 六维格 —— **装备带来的加成紧跟在那一项后面**（用户裁定：「在人物卡对应属性后面显示 (+x)」）。
 *
 * ⚠️ 显示的是**基础值 + 装备加成**，并把加成**单独标出来**：
 *    只写 "18" 玩家看不出 18 里有多少是装备给的；只写 "+3" 他又不知道基线是多少。
 *    ⇒ `18` 是实值（判定真正用的那个数），后面挂一枚绿色的 `+3`。
 * ⚠️ **数字来自 `view` 的 `itemBonuses`**（`rules/ability.ts·carriedItems` 算的），
 *    UI **不自己加** —— 物品被消耗时两处立刻会对不上，而那是很难查的一类漂移。
 * ⚠️ 没有加成时**不写任何东西**（不留 `+0` 那种空标记）。
 */
function attrGrid(p){
  const bonus = {};
  arr(p.itemBonuses).forEach(function (b) { bonus[b.attr] = (bonus[b.attr] || 0) + b.bonus; });
  return '<div class="attrgrid">' + Object.entries(p.attrs).map(function (kv) {
    const k = kv[0], n = kv[1];
    const add = bonus[k] || 0;
    const total = n + add;
    return '<div class="a' + (add ? ' boosted' : '') + '"><b>' + total + '</b>' +
      (add ? '<i class="abo">+' + add + '</i>' : '') +
      '<span>' + esc(k) + '</span></div>';
  }).join('') + '</div>';
}

/**
 * 把一段历史列表折起来：只给最近 `HIST_BASE[k] + histMore[k]` 条，
 * 剩的收成一条「还有 N 条 · 展开」（已全展开时它是「收起」）。
 *
 * ⚠️ 前提：**调用方必须先把"最近的"排在最前**（`.slice().reverse()`）——
 *    否则折叠等于"把最新发生的事藏起来"，比不折还糟。
 * ⚠️ 本来就装得下、也没手动展开过 ⇒ **不画那条折叠栏**（否则每张卡都拖一条无用的虚线）。
 */
function folded(k, rows){
  const base = HIST_BASE[k] ?? 6;
  const n = base + (histMore[k] || 0);
  const shown = rows.slice(0, n);
  const rest = rows.length - shown.length;
  if (rest <= 0 && !(histMore[k] > 0)) return shown.join('');
  return shown.join('') +
    '<div class="foldbar"><button data-act="moreHist" data-k="' + k + '" data-rest="' + rest + '">' +
    (rest > 0 ? '还有 ' + rest + ' 条 · 展开' : '收起') + '</button></div>';
}

/**
 * `folded` 的**人物版**（2026-10-06）—— 给「尚未入队」那组用。
 *
 * ⚠️ 为什么不直接用 `folded`：它假设 `rows` 已经**渲染成 HTML 串**，
 *   于是 `slice(0, n)` 切的是**字符**、`rows.length` 是**字符串长度**
 *   ⇒ 条数算错、整列都显示（实测就是这么坏的）。
 *   ⇒ 这里把**渲染推迟到切片之后**：先按 `HIST_BASE + histMore` 取人，
 *     再逐个 `personCard`。
 * ⚠️ 折叠契约（"调用方必须先把最近的排最前"）**一字未动** —— 还是那条，
 *   `rows` 的顺序由调用方负责。
 */
function foldPeople(k, rows){
  const base = HIST_BASE[k] ?? 6;
  const n = base + (histMore[k] || 0);
  const shown = rows.slice(0, n).map((p) => personCard(p, false));
  const rest = rows.length - n;
  if (n <= 0) {
    // ⚠️ **一条都不给**（`HIST_BASE.peopleOut = 0`）⇒ 只给那颗"展开"钮。
    return '<div class="foldbar"><button data-act="moreHist" data-k="' + k + '" data-rest="' + rows.length + '">'
      + '名单（' + rows.length + ' 人）· 点开看</button></div>';
  }
  if (rest <= 0 && !(histMore[k] > 0)) return shown.join('');
  return shown.join('') +
    '<div class="foldbar"><button data-act="moreHist" data-k="' + k + '" data-rest="' + rest + '">'
    + (rest > 0 ? '还有 ' + rest + ' 条 · 展开' : '收起') + '</button></div>';
}

function renderLeft(v){
  const me = v.me;
  // ═══════════════════════════════════════════════════════════════════
  // 左栏瘦身（2026-10-05 · 布局重构）
  // ─────────────────────────────────────────────────────────────────
  // 改前实测（探针 · 1600×1000）：左栏 **31 个文字节点 / 287 字**，
  // 而真正的游戏内容（中栏）只有 **79 字** —— 说明书占了 44%，地图被挤成一条缝。
  //
  // 这一轮**撤掉**的三张卡，以及**为什么它们可以撤**：
  //   · 「三王子」卡  → 沉到**底部手牌**（`renderHand` 的第一张，`.hcard.me`）
  //   · 「身外之物」  → 沉到**底部手牌**（物的卡带，紧跟人之后）
  //   · 「人手」      → 沉到**底部手牌**（同一条卡带，`未入队` 那组收在折叠里）
  // ⚠️ **不是"删掉信息"，是换个位置摆** —— 每一条都在底部卡上，`view` 一字没改。
  // ⚠️ 「最终任务清单」**留在左栏**：它现在只剩「三个计数 ＋ 第 28 天」两行
  //    （全量名单在点开里），而这条是**全周常驻**的（`ui.test.ts` 有断言），
  //    放在左栏才看得出"它在长"。⚠️ 它仍**不许**跟 `isFinalDay` 绑（同样有断言）。
  // ═══════════════════════════════════════════════════════════════════

  // ── 人手分两组：**已入队 / 尚未入队**（2026-09-20 用户裁定）────────────────
  // ⚠️ 分组判据是 `affiliated`（"是不是三王子的人"），**不是 `available`**。
  //    若拿 `available` 分，一个**重伤**的属下会掉进"未入队"那组 —— 而他人明明是你的人。
  //    ⇒ 「**今天派不了**」由卡面上的状态 chip 说，分组只回答"他是不是我的人"。
  // ⚠️ 术语逐字取「尚未入队」（`prompt/blocks.ts:84` ＋ `PROMPT清单.md:2507` 用户原话）。
  // ⚠️ 尚未入队那组**空着就不画**：画一个「尚未入队（0）」的空壳＝每局都在提醒"你还缺人"。
  // ⚠️ 折叠仍在（`folded('peopleOut', …)`）—— 它跟着"未入队"那组一起搬到了底部卡带，
  //    折叠契约（"调用方必须先把最近的排最前"）不因搬家而改变。
  // ⚠️ 2026-10-08：原先这里还算过一份 `outsiders` / `pv` / `questCounts` ——
  //    自从左栏整块搬进 `leftHtml` 后它们就是死变量（那边自己算），删掉，
  //    免得后人以为「你的欲望」的徽标有两处来源。
  $('colLeft').innerHTML = leftHtml(v);
}

/**
 * 左栏那一块**搬到中栏**之后的样子（2026-10-06 三段式布局）。
 *
 * ⚠️ 用户裁定：「**最终任务区域和未入队人物应该也是地图区内的方格**」
 *   —— 所以它们从「左栏」搬进「中栏的画布区上方」，**不是删掉**。
 * ⚠️ 「未入队」那一条**只陈述事实**（列名单的那些在底部卡带上），
 *   与 `renderHand` 里的折叠钮**分工不变**（一个事实一个落点）。
 */
/**
 * **「这一局」块**（命题 ＋ 三格计数）—— 2026-10-06 从**手牌区**搬进**最终任务区**。
 *
 * ⚠️ 用户裁定：「手牌区**不需要『欲望块』**，因为它应该是显示在**最终任务区**里面」。
 *   理由（也是这条裁定的必然结果）：它讲的是"这一局要达成什么"，
 *   那是**任务**，不是"我手上有什么" —— 放在手牌区里混淆了两件事。
 *   ⇒ 现在它与「最终任务清单」是**同一区**（`leftHtml` 的第一块）。
 *   ⇒ 手牌区**只留牌**：金币 ＋ 我的人 ＋ 我的东西。
 */
/**
 * **「这一局 · 最终任务」块** —— 2026-10-06 由 `missionBlock` 与「最终任务清单」
 * **合并成一块**（用户裁定：「欲望块和任务清单块**应该是合并的**」），
 * 布局按裁定「**宣言在上、三格在下，同一个块**」。
 *
 * ⚠️ 合并的**理由**（不是"省地方"）：它们讲的是**同一件事**——
 *   「你这一局要什么」与「你这一局达成了什么」是**同一个目标的两个时刻**。
 *   分成两块 ⇒ 玩家要在一处看欲望、另一处看进度，眼睛要来回跳。
 *   ⚠️ 点击仍开 `quest` 浮层（那是唯一能看三格明细的地方）—— **一个动作一个入口**。
 */
function missionBlock(v){
  // ⚠️⚠️ 2026-10-08（用户裁定：「2/1/0 哪来的」）：徽标从**候选池计数**改成**凭证计数**。
  //    原先数的是 `placementPools`（成果=手上的物品、手段=已了结的事、共鸣=给过认可的人）——
  //    那是"终局三格还能放哪些"的内部口径，玩家读成"框里有 N 张卡"，而终局三格里一张没有
  //    ⇒ 数字与所见对不上。改为数 `v.vouchers`（手牌区可见的凭证卡，按维度分），
  //    数字与玩家看得见的卡一一对应 ——「这一局达成了什么」说的也正是它。
  const VDIM = { 成果: 'the_great_achievement', 手段: 'the_proper_way', 共鸣: 'the_resonance_of_the_other' };
  const vs = arr(v.vouchers);
  const questCounts = ['成果', '手段', '共鸣'].map((k) =>
    '<span class="tag">' + k + ' ' + vs.filter((x) => x.dim === VDIM[k]).length + '</span>').join('');
  // ⚠️ 2026-06：这里**故意不写 `isFinalDay`** —— `ui.test.ts` 有一条断言明写
  //   「清单**不许跟终局绑在一起**」。终局那一档由 `v.phase`／结局浮层去说。
  // ⚠️⚠️ 2026-10-07 用户第 7 / 22 条：「『这一局』改成『你的欲望』」（清单原话）。
  return '<div class="card tap" data-act="detail" data-kind="quest" title="点开看他想要什么、以及系统拿哪一句判">' +
    '<h3>你的欲望 · 第 ' + v.day + ' 天 / ' + v.totalDays + '</h3>' +
    // ── 上半：宣言（你这一局要什么）──
    '<div class="hq-p">' + (v.desire.manifesto ? esc(v.desire.manifesto)
      : (v.desire.proposition ? esc(v.desire.proposition) : '还没有欲望')) + '</div>' +
    (v.desire.means ? '<div class="hq-m" style="font-size:11px;color:var(--muted)">手段：' + esc(v.desire.means) + '</div>' : '') +
    // ── 下半：三格（你这一局达成了什么）──
    '<div class="hq-c">' + questCounts + '</div>' +
    '<div class="peek row">点开看：三格里各有什么</div>' +
  '</div>';
}


function leftHtml(v){
  // ⚠️ 2026-06：这两个局部量原先在 `renderLeft` 里算，抽成函数时**必须一起搬过来**
  //   （第一版漏了 `questCounts` ⇒ `ReferenceError` ⇒ 整页白）。
  const me = v.me;
  const all = arr(v.people);
  const outsiders = all.filter((p) => !p.affiliated);   // ⚠️ **不 map 成 HTML 串**（见下）
  // ⚠️ 2026-10-08：`pv` / `questCounts` 在这里算过一份但没人用（徽标只在 `missionBlock`
  //    里画，那边改读 `v.vouchers` 了）—— 死变量删掉，别留第二处假来源。
  // ⚠️⚠️ 2026-10-06 用户裁定：「任务清单/尚未入队**像事件块一样放在地图区的左上角**」
  //   ⇒ 两块**一起**放进 `.mapcorner`（`position:absolute` 浮在地图台面上），
  //     不再是"两个占满整宽的盒子竖排"。
  //   ⚠️ 事件块**也**是 `position:absolute`（`.cvchip`）⇒ 三者**同一套坐标系**，
  //     叠在一起才对齐；否则块与块会错位。
  //   ⚠️ 宽度 300px 固定，且 `pointer-events` 只在这块里开 ⇒ **不挡**事件块的点击。
  const inner = missionBlock(v) +
      // ⚠️ 2026-06：「最终任务清单」**已并进 `missionBlock`**（用户裁定「欲望块和任务清单块
  //   **应该是合并的**」）⇒ 这里不再单独画它。
  //   ⚠️ 下面只剩「尚未入队」那一块（名单也搬来这里了 —— 手牌区那个折叠钮已删）。
    // ⚠️⚠️ 2026-10-07 用户第 3 条（补核）：**未入队人物改成独立弹窗**。
    //   用户原话：「未入队人物展开后**无法正常收起**，我希望做成这样：**点开后进入独立弹窗**，
    //   屏幕**左侧是竖列的人物概览**（而不是和地图同级），再点其中的人物可以看某个人物的详情，
    //   点其他人物则替换，**点空白处则退出这个弹窗**」。
    //   ⇒ 地图上只留**一个入口卡**（点一下开弹窗）；名单**不再铺在地图上**。
    //   ⚠️ 顺手修掉「展开后收不回去」那个 bug：那块名单走的是 `foldPeople`
    //      （`histMore.peopleOut` 那个折叠态），而**地图每轮 `render()` 都会重画它**
    //      ⇒ 折叠态与渲染周期打架。改成弹窗之后，那块折叠 UI 整个不存在了。
    //   ⚠️ 触发的动作复用现成的 `detail` ＋ `kind="outsiders"`（`renderOverlay` 里那一支）——
    //      不新开一条动作通路（另开一处就多一处会漂的地方）。
    (outsiders.length
      ? '<div class="card tap" id="outsiderszone" data-act="detail" data-kind="outsiders"' +
        ' title="点开看还没站过来的这些人">' +
        '<h3>尚未入队（' + outsiders.length + '）</h3>' +
        '<div class="sub" style="font-size:12px;color:var(--muted)">'
          + '他们还站在你这边之外 —— 想用，得先让他们站过来。</div>' +
        '<div class="peek row">点开看名单</div>' +
      '</div>'
      : '')
    // ⚠️ 2026-06：**章级概要那一块整个搬走了**（它原来在这里、现在看不见）。
    //   理由：它是"三王子"那张卡的一部分（2026-10-05 已沉到卡带），
    //   而卡带里已有**人物卡**，再在这里复述一次就是"一个事实两个落点"——
    //   那条口径在 2026-10-05 就定下了（见上面「人还在等」那段的三次弯路记录）。
    ;
  return '<div class="mapcorner">' + inner + '</div>';
}

function cardHtml(e, ro){
  // ⚠️⚠️ 清单第 1 条（**持久化**）：`ro` ＝ **回看态** —— 事件已经交出去了（处理中），
  //    点开仍要看到玩家**当时摆下去的样子**：槽里还是他派的人、叮嘱还写着。
  //    槽位与金币只作展示（不可拖改、✔ 不出现），处理方式与叮嘱是**只读摘要**。
  //    picks 丢了（翻页 / 重开）⇒ 回退用事件自带的 `participants` 名单展示。
  const sel = pickOf(e.id);
  if (ro && !arr(sel.participants).length && arr(e.participants).length) {
    sel.participants = arr(e.participants);
  }
  const chosen = new Set(sel.participants);
  const canSelf = e.dispatchable !== '仅派遣';
  // ⚠️ 这一行只喂给「派人去」按钮的亮灭（`canDispatchTo` 是**逐人**判据，答的是"他行不行"）。
  //    两者同源：都看 `dispatchable === '仅亲自'`。
  const canDispatch = e.dispatchable !== '仅亲自';
  const meId = S.view.me.id;
  // ⚠️ 2026-10-05：**先分两组再各画各的**（此前是全员平铺一列）。
  //    病灶（用户实测）：开局只有皮普 1 人在册，却和另外 9 个未入队的人并排站在
  //    同一个下拉列表里，只靠 `opacity:.5` 区分 —— 玩家读到的是"我有 10 个手下"，
  //    而其中 9 个**一个都派不了**；更要命的是**对未入队者也报了「容量 N」**
  //    （那是 `byNpc` 里一个他根本用不上的数字，`t0.ts:202` 每天给每个人都重置 4 点）。
  //    ⇒ 判据用 `canDispatchTo`（与拖拽共用那份），**不是** `available` 单看一层。
  const all = arr(S.view.people);
  // ⚠️ 2026-10-05 补一处口径拆分（探针实测抓到的）：`canDispatchTo` 把**两件事**合在一起答，
  //    而它们的**后果完全不同**：
  //      · `仅亲自` ⇒ 这件事**一个属下都不派**（他没毛病，是这件事不给人派）；
  //      · 不可用 ⇒ 这个人**自己此刻调不动**（未入队 / 重伤 / 在途）。
  //    合在一组里会把皮普（`available = true`、有编制有容量）也列进「调不动」，
  //    还会给他安一句"今天调不动"——**那是在骗人**。
  //    ⇒ `blocked` 只收**真的调不动的人**（`available` 为假）；「仅亲自」时压根不列人。
  const crew = all.filter((p) => canDispatchTo(p, e));
  const blocked = canDispatch ? all.filter((p) => !p.available) : [];

  const rows = [];
  // 玩家本人 —— 独立一行，**不进那两组**（他的预算口径与属下不同，见 `canDispatchTo` 顶栏）
  rows.push('<label class="' + (canSelf ? '' : 'dim') + '"><input type="checkbox" data-act="pick" data-ev="' + e.id + '" data-who="' + meId + '"' +
    (chosen.has(meId) ? ' checked' : '') + (canSelf ? '' : ' disabled') + '> 我亲自（剩时 ' + S.view.remaining + '）</label>');
  for (const p of crew) {
    rows.push('<label><input type="checkbox" data-act="pick" data-ev="' + e.id + '" data-who="' + p.id + '"' +
      (chosen.has(p.id) ? ' checked' : '') + '> ' + esc(p.name) +
      '（容量 ' + p.ap + (p.status !== '正常' ? ' · ' + esc(p.status) : '') + (p.away ? ' · 在途' : '') + '）</label>');
  }

  // ── 「非他不可」而他此刻调不动 ⇒ **这是个死局，必须说清**，不能只给一个点不动的名字 ──
  //    闸门 ③ 两条路都拦（带他 ⇒ 不可派遣；不带他 ⇒ 非他不可），`required-person.test.ts:170`
  //    把这条钉得很死：没有破例放行的后门。而先前窗口里只有卡面那颗红标 + 一个置灰的复选框，
  //    玩家完全看不出"这件事今天办不了"，只会以为是自己没点对。
  const reqName = e.requiredPerson ? e.requiredPerson.name : '';
  const reqPerson = e.requiredPerson ? all.find((p) => p.id === e.requiredPerson.id) : null;
  // ⚠️ 判据是 `!reqPerson.available`（**他这个人**），不是 `!canDispatchTo`（那把"仅亲自"也算进来）。
  //    `仅亲自` ＋ `required_person` 在规则层是**两个互斥要求**（闸门 ③ 会同时报两条），
  //    那时该说的是"这件事不给人派"，而不是"他今天调不动"—— 同样是假话。
  const reqUnavailable = !!(reqPerson && !reqPerson.available);
  // ⚠️ 补一句的措辞**跟着原因走**（探针实测）：笼统写"他养好了再说"，对一个
  //    **尚未入队**的人就是假话 —— 他没伤要养，是**还没站到你这边** ⇒ 那件事不是等得来的。
  const reqAdvice = (p) => (!p.affiliated
    ? '得先让他站到你这边'
    : p.away ? '等他回来' : '医馆 / 大神殿能把他养好');
  const reqLine = e.requiredPerson
    ? '<div class="reqline' + (reqUnavailable ? ' dead' : '') + '">非 ' + esc(reqName) + ' 不可' +
      (reqUnavailable
        ? ' —— 可他此刻「' + esc(blockedReason(reqPerson)) + '」，这件事今天办不成（' + reqAdvice(reqPerson) + '）'
        : (!canDispatch
            ? ' —— 可这件事限**你亲自**处理（他不派得上）'
            : '（他就在上面，勾上他）')) +
      '</div>'
    : '';

  // ⚠️⚠️ 2026-10-07 用户第 5 条复验：**「物格」不是"还没做"，是"从来就不该有"**。
  //   用户原话：「是不是之前的物品槽逻辑的残余？现在根本不需要物品槽，
  //   物品都是直接放在人物身上的」。
  //   ⇒ 物品的**唯一**入口是把它拖到人卡上（/api/give 那条路）——
  //     事件台里那句「需要携带的物品请提前装备在人物身上哦」就是这件事的说明书。
  //   ⚠️ 这里删掉的是**两样残骸**：物格候选池，以及它那条**早就被删掉的下拉框**
  //     的选项源（下拉上一轮撤了，这两行 const 却**每轮照样求值**）。
  //     真正咬人的第三样在下面「物」那一格 —— 见那段注释。

  const tag = (t, cls) => '<span class="tag' + (cls ? ' ' + cls : '') + '">' + esc(t) + '</span>';
  // ⚠️ 原先 10 个 tag **平铺成一坨**，玩家分不出"哪些是这张卡自己的属性、哪些是派谁去的门槛"。
  //    ⇒ 分三组，各带一个极小的组标题。**只改呈现**：tag 的文字 / 数量 / class 一字未动。
  const group = (label, items) => {
    const on = items.filter(Boolean).join('');
    return on ? '<span class="taggroup"><span class="tglabel">' + label + '</span>' + on + '</span>' : '';
  };
  // ── 卡面：只留"这是什么" ──────────────────────────────────────
  // ⚠️ 分两组的依据：卡面上那三行是"**要不要理会它**"；下面「派谁去 / 主事」是
  //    "**动手时才需要看**"的 —— 后者搬进展开区（向《苏丹的游戏》借的"点开才展开"）。
  const faceTags =
    tag(e.tier === 'A' ? '当场就得定' : e.tier === 'B' ? '可以派人去' : '得你亲自去') +
    tag('时长 ' + e.cost + ' 点' + (e.cost > 4 ? '（跨天）' : '')) +
    tag('期限 ' + e.deadline + ' 天（第 ' + e.expiresOn + ' 天前）');
  const deepTags =
    group('派谁去', [
      tag(e.dispatchable, e.dispatchable === '两者皆可' ? '' : 'warn'),
      // ⚠️ 它是**硬约束**（闸门 ③ 会真的拦），所以跟 `dispatchable` 同一组、同样 `warn`；
      //    文案用「非 X 不可」而不是字段名 —— 卡面只说世界的话。
      e.requiredPerson ? tag('非 ' + e.requiredPerson.name + ' 不可', 'warn') : null,
      tag('难度 ' + e.difficulty),
      // ⚠️ 2026-10-05：`tag('属性 ' + e.hint_attr.join('/'))` → **符号徽**。
      //    纯文字的属性列表要读两遍（"智慧/魅力"要翻译成"派谁"），
      //    符号 ＋ 词一起给：符号给一眼认得，词给"我记住的那个词"。
      //    ⚠️ `attrChip` 逐个出，**不做成一枚**（一枚里塞两个词就退化成文字了）。
      e.hint_attr.length ? '<div class="taggroup attrgroup">' + e.hint_attr.map(attrChip).join('') + '</div>' : null,

      e.min_people > 1 ? tag('至少 ' + e.min_people + ' 人') : null,
      e.max_people < 3 ? tag('至多 ' + e.max_people + ' 人') : null,
      e.min_gold > 0 ? tag('建议垫 ' + e.min_gold + ' 金') : null,
    ]) +
    // ⚠️⚠️ 2026-10-05（用户裁定第 3 条后一半）：事件卡上要**提醒玩家提前给人物装备物品**。
    //    为什么这件事必须写在**事件卡**上、而不是等人进处理台才说：
    //      · 玩家看到"需要智慧"那一刻就在挑人了 ⇒ 装备的窗口正是那一刻；
    //      · 等进了处理台再提醒，他已经选完人了 ⇒ 提醒来得太晚（要么回去改、要么算了）。
    //    ⇒ 判据：这件事**要某项属性**（`hint_attr` 非空）**且**（有人能加成 **或** 他空手）。
    //      一句话讲清"该做什么"，不列具体数字（那属于点开之后）。
    (function () {
      const attrs = arr(e.hint_attr);
      if (!attrs.length) return '';
      // 谁身上带着给这些属性加成的装备？
      const all = arr(S.view && S.view.people);
      const withIt = [S.view && S.view.me].filter(Boolean)
        .concat(all.filter((p) => p.affiliated && p.available))
        .filter((p) => arr(p.itemBonuses).some((b) => attrs.indexOf(b.attr) >= 0));
      const needAttr = attrs.map((a) => a).join('/');
      if (withIt.length) {
        // ⚠️ 2026-10-06：**点名是哪几件**（用户上一轮提过这条没做完）。
        //    只说「皮普带着能加成的装备」玩家还要自己去猜是哪件；
        //    写出「皮普〈短匕首〉」他才能判断"要不要换别的给他"。
        //    ⚠️ 每人**至多列 2 件**（与 `BONUS_CAP` 一致）—— 生效的就那些。
        const who = withIt.slice(0, 2).map(function (q) {
          const nm = q.id === S.view.me.id ? '你' : q.name;
          const names = arr(q.items)
            .filter((it) => arr(it.bonus).length > 0)
            .slice(0, 2)
            .map((it) => '<b>' + esc(it.name) + '</b>')
            .join('');
          return nm + (names ? '〈' + names + '〉' : '');
        }).join('、');
        return '<div class="sub equipTip">要 ' + needAttr + ' —— '
          + who + (withIt.length > 2 ? ' 等 ' + withIt.length + ' 人' : '')
          + '带着能加成的装备</div>';
      }
      // ⚠️ 只有"有人**本来就**高"这一档不同：不用装备也能办 ⇒ 只轻轻提一句
      const strong = all.filter((p) => p.affiliated && p.available
        && attrs.some((a) => (p.attrs && p.attrs[a] || 0) >= 12));
      if (strong.length) return '';
      return '<div class="sub equipTip warn">要 ' + needAttr
        + ' —— 办之前不妨先给合适的人带上加成的装备（人卡上的 @ 是他带了几件）</div>';
    })() +
    group('主事', [ e.handlerName ? tag('主事 ' + e.handlerName, 'good') : null ]);

  // ── 展开 / 收起：**这一段整体不存在了**（2026-10-07 清残骸）────────────
  // ⚠️ 这里原来有四个 const：折叠开关、强制展开判据、"展开"标记，以及
  //   一句「已选 N 人 · 垫 N 金 · 带物件」的摘要行。第 5.1 条把折叠去掉之后
  //   它们**一个都没人读了**，而摘要行还在读那个已经不存在的"物件"字段。
  // ⇒ 一并删。**死变量是下一颗地雷的引信**（见下面「物」那一段的说明）。

  // ── 展开区：人 / 物 / 钱 **三格**（＝它的"把卡放上去"）────────────
  // ⚠️ **人格是红的（必填）**：一个人都不派，服务端会拒（`ui/session.ts·arrange` 那道守卫，
  //    以及 `turn/handle.ts:160`）。红色 ＝ "这个位置一定要放东西"，正是《苏丹》那套标记。
  const nameOf = (id) => {
    if (id === meId) return '我亲自';
    const found = arr(S.view.people).find((x) => x.id === id);
    return found ? found.name : id;
  };
  const pickedNames = [...chosen].map(nameOf);
  // ⚠️ 清单第 1 条：槽里放进去后要显示**整张卡的样子**（与手牌区一致），
  //    不再只是一个名字条 ⇒ 这里要拿到**人物对象**（名字 / 身份 / 主角标记）。
  const personOf = (id) => (id === meId)
    ? S.view.me
    : arr(S.view.people).find((x) => x.id === id) || null;
  const pickedPeople = [...chosen].map(personOf);
  // ── 三格 ＝ 三个**卡槽**（"把卡放上去"）─────────────────────────
  // ⚠️ `data-drop` 就是「**这一格收什么**」在页面上的唯一声明（C 轮）：
  //      who ← 人卡 · item ← 物卡 · gold ← **不接卡**（它是填数字的）。
  //    `canDropOn` 只认这三个值 ⇒「物品槽不能放人物」不是一句叮嘱，是**一个判据**。
  //    ⚠️ 它**不是**"放得对不对"的判据 —— 那一条（`available`/`canDispatch`/人数/金币）
  //       与点选共用 `canDispatchTo`，见那个函数的顶栏。
  // ⚠️ 「调不动」那组**不给复选框**（2026-10-05）：给一个永远点不动的方框，
  //    玩家会以为是页面坏了 —— 不如一句话告诉他有谁、以及为什么派不动。
  // ⚠️ **按原因归并**（探针实测）：开局 9 个人**全都是「尚未入队」**
  //    ⇒ 逐个列就是同一句「尚未入队」重复 9 遍，一整行噪音、什么也没多说。
  //    归并后是「另有 9 人调不动（尚未入队 9）」—— 同一份信息，短得多。
  //    理由不同的人才值得分开列（"重伤 1 · 在途 1" 才是玩家要读的情报）。
  // ⚠️ **超过 3 人就不点名**：那一组的作用是让玩家知道"我不是漏看了谁"，
  //    名单本身在左栏「人手」卡里常驻（那里分两组、可展开）⇒ 两处都列 = 同一份名单两处维护。
  //    要点名的人只有一种：**「非他不可」的那位**，而他由上面 `reqLine` 单独报名字。
  const blockedLine = (() => {
    if (!blocked.length) return '';
    /** 原因 → 那些人的名字（保持首次出现的顺序，不排序） */
    const byReason = new Map();
    for (const p of blocked) {
      const r = blockedReason(p);
      if (!byReason.has(r)) byReason.set(r, []);
      byReason.get(r).push(p.name);
    }
    const parts = [...byReason.entries()].map(([r, names]) =>
      r + ' ' + names.length + (names.length <= 3 ? '（' + esc(names.join('、')) + '）' : ''));
    return '<div class="sub blocked">另有 ' + blocked.length + ' 人调不动（' + parts.join(' · ') + '）</div>';
  })();
  // ⚠️⚠️ 2026-10-05：人槽改成**四个卡位**（用户裁定「人物槽我们都默认做四个」）。
  //    为什么是"卡位"而不是一个装着复选框列表的方框：复选框那一支要求玩家
  //    **读十个名字再逐个点**，而拖拽那一支只要**把卡拿起来放进去**——
  //    同一个结果，两种代价。`canDropOn` 早就写好了，只是过去被浮层挡住了。
  //    ⚠️ **4 是系统上限，不是这条事件的约束**（用户裁定：「统一为 4 个槽」）。
  //    逐条事件的真约束是 `max_people`（LLM 给，闸门 ⑦ 判）⇒ 两者**独立算**：
  //    槽画 4 个，但放满 `max_people` 之后**再拖也进不去**（`canDropOn` 拦）。
  const SLOTS = 4;
  // 必空的位：**红色**（用户裁定「LLM 要求至少几人参与 / 或者指定谁必须参与
  // 则对应卡槽变红表示不能为空」）。⚠️ 两个来源、两种红：
  //    `min_people` ⇒ **前 N 个**必空（任意 N 个人都够）；
  //    `required_person` ⇒ **他的那个位**必空，且写上他的名字（只有他行）。
  const needN = Math.max(0, e.min_people || 0);
  const reqIdx = e.requiredPerson ? chosen.has(e.requiredPerson.id)
    ? [...chosen].indexOf(e.requiredPerson.id) : 0 : -1;
  // ⚠️⚠️ 2026-10-06 清单第 5.5 条：**逆时针编号 ①上 ②左 ③下 ④右**（用户裁定）。
  //    `data-si` 是**那个编号** ⇒ CSS 按它定位（`.dia .pslot[data-si="0"]` 在上…），
  //    渲染侧与样式侧**读同一个数**，不会两处各写一份顺序。
  // ⚠️ **必放那位排 ①**（用户原话：「红色必放槽也是按这个顺序优先出现
  //    （**不然玩家会被强迫多放**）」）⇒ 必填判据在 `k === 0` 上（见下面 `must`）。
  const ORD = ['①', '②', '③', '④'];
  const slots = [];
  for (let k = 0; k < SLOTS; k++) {
    const whoP = pickedPeople[k];
    const who = whoP ? whoP.name : null;
    // 红色判据：前 `needN` 个 ＋ 必填那位（他若已放进来的第一个位，就不再红）
    const must = who ? false
      : (k < needN) || (k === 0 && !!e.requiredPerson && !chosen.has(e.requiredPerson.id));
    const isReq = e.requiredPerson && k === 0 && !chosen.has(e.requiredPerson.id);
    // ⚠️ 必放那位**还没放进来**时，槽中间**写他的名字**（5.5「在一个红卡槽中间写上
    //    红色的人物名字」）—— 光一个红框看不出"非他不可"，要看得见是谁。
    //    ⚠️⚠️ 2026-10-07（用户裁定）：槽**旁边**还要明确写一句「xx必须要去」——
    //      槽里的名字只说"这个位放谁"，旁边这句才把"他不去这件事就开不了工"点破。
    const reqTag = isReq
      ? '<span class="reqname">' + esc(reqName) + '</span>' +
        '<span class="reqtag">' + esc(reqName) + '必须要去</span>'
      : '';
    // ⚠️⚠️ 清单第 1 条：放进去的槽显示的是**那张卡**（名字 ＋ 身份 ＋ 主角金边），
    //    与手牌区同一副面孔 —— 拖拽的语义是"卡从手上**搬进了**这个位"，
    //    不是"位上记了一个名字"。
    slots.push('<div class="pslot' + (whoP ? ' filled' : '') + (must ? ' must' : '') + '"' +
      ' data-drop="who" data-ev="' + e.id + '" data-sloti="' + k + '" data-si="' + k + '"' +
      ' title="' + (ro
        ? esc(who) + ' —— 已交出去（只作回看）'
        : (who ? esc(who) + ' —— 点一下取回' : (isReq ? '非 ' + esc(reqName) + ' 不可' : '把人卡拖到这里'))) + '">' +
      '<span class="ord">' + ORD[k] + '</span>' +
      (whoP
        // ⚠️⚠️ 2026-10-07（用户第 1 条）：槽里那张卡**自己就是拖拽源**
        //   （`data-kind`/`data-id`）—— 用户原话「拖到事件卡槽里的卡牌，还是
        //   无法直接拖回手牌区」。此前 `.scard` 没有拖拽属性 ⇒ 抓都抓不起来，
        //   只能点 ×。现在它与手牌上那张同属一个源选择器，拖回手牌带＝取回。
        ? '<div class="scard' + (whoP.id === meId ? ' me' : '') + '" data-kind="person" data-id="' + esc(whoP.id) + '">' +
            '<span class="sn">' + esc(whoP.name) + '</span>' +
            '<span class="si">' + esc(whoP.identity || whoP.basic || '') + '</span>' +
          '</div><span class="px">×</span>'
        : reqTag + '<span class="pdash">＋</span>') +
      '</div>');
  }
  // ⚠️ 2026-10-06：人位曾挂 `data-to-whom`（物卡拖到人位 ＝ 交给这次去的人）。
  //    ⚠️⚠️ 2026-10-08（用户裁定·装备统一口径）：**这条旁路已撤** —— 装备只有
  //    一条路（手牌物卡 → 人物卡），人位改回只收人卡，`data-to-whom` 一并摘掉
  //    （它会把"落点语义"留给一个已经不存在的功能）。
  const slotWho = '<div class="slotbox" data-drop="who" data-ev="' + e.id + '">' +
    '<div class="sh">人 · ' + (chosen.size ? chosen.size + ' / ' + SLOTS : '放 ' + SLOTS + ' 个位') +
      (needN ? '（至少 ' + needN + '）' : '') + '</div>' +
    reqLine +
    '<div class="slots">' + slots.join('') + '</div>' +
    '<div class="pick">' + rows.join('') + '</div>' + blockedLine + '</div>';
  //    ⚠️⚠️⚠️ 2026-10-07（**这条最要紧**）：原来这里还有第三样残骸 ——
  //     「物」那一格的 HTML 串。它**不渲染**（上一轮已经把 .dia-item 从
  //     return 里撤了），但它是 const ⇒ **每轮渲染都照样求值**。
  //     而它的判据是「**池子空不空**」，不是「**这次到底选没选一件**」——
  //     于是：槽里放了一个**身上带东西的人**（池子非空）、却没选物件时，
  //     它去取"这次用的那件"取到 undefined ⇒ **当场抛异常**
  //     ⇒ renderOverlay 里那句 modal.innerHTML = ... 根本没执行
  //     ⇒ **事件台停在半渲染态**（用户截图里那片"莫名其妙的画面"就是这个）。
  //     ⚠️ 修法不是给它补判据 —— 是**整块删掉**：物格本来就不该存在。
  //     ⇒ 教训：**删一个格子要连它的变量一起删**。只从 return 里撤掉，
  //       等于把一颗地雷从路上挪到草丛里（node --check 与 660 条单测都看不见它）。


  // ⚠️⚠️ 2026-10-06 清单第 5.4 条：**属性实时读数**——
  //   「事件标题左侧显示处理事件所需要的属性（**一开始是 0，会根据放上去的人卡属性
  //   而实时变化**）」。
  // ⚠️⚠️ 2026-10-07 用户裁定：**取参与者对应属性的「最高值」，不是把人相加** ——
  //   「要明确变化的结果是展现参与者对应属性的最高值（而不是把参与者的数值相加），
  //   并且有小字提示玩家，属性取参与者对应属性的最高值」。
  //   ⚠️ 口径对得上规则层：投骰用的 A 本来就取**主事者**（= 参与者里这组属性上最强者，
  //   `pickLeader`）的有效属性 ⇒「最高值」比旧版的"全员相加"贴近真判定得多。
  //   逐人的有效属性仍由 `rules/ability.ts·effectiveAttrsOf` 算好透到 `view`
  //   （`UiPerson.effectiveAttrs`）⇒ 这里只做**取最大**，不重算加成。
  const 我 = S.view.me;
  const 池 = arr(S.view.people);
  const 属 = (id) => (id === 我.id ? 我 : 池.find((p) => p.id === id));
  const 实时 = arr(e.hint_attr).map((k) => {
    let v = 0;
    for (const id of chosen) { const p = 属(id); if (p) v = Math.max(v, (p.effectiveAttrs || p.attrs || {})[k] || 0); }
    return { k: k, v: v };
  });
  // ⚠️ 事件没声明属性 ⇒ **整段不出现**（空白比"要 0 项"诚实）
  const attrReadout = 实时.length
    ? '<div class="evd-attrs">' + 实时.map((r) =>
        '<span class="evd-attr' + (r.v === 0 ? ' zero' : ' ok') + '"' +
        ' title="' + (r.v === 0 ? '一个人都还没放 —— 现在是 0' : '参与者里最高的一项 ' + esc(r.k) + ' 是 ' + r.v + ' 点') + '">' +
        attrSigil(r.k, 12) + esc(r.k) + ' <b>' + r.v + '</b></span>').join('') + '</div>'
    : '';

  // ⚠️ **钱槽**：菱形**中心**那个（5.5「槽中间是金币槽」）。
  //    `min_gold > 0` ⇒ 红框 ＋ 中间写红色数字（5.5「金币槽中间也写上红色的数字
  //    表示最低金币数额，**也只能放金币**」）。
  //    ⚠️ `data-drop="gold"` **不许去掉** —— 拖拽判据（`canDropOn`）读它。
  //    ⚠️⚠️ 2026-10-07 订正（此前这里有句**与代码相反**的注释，写着"`min_gold`
  //    不是硬要求 ⇒ 只提示不拦"，害得复验时白查一轮）：第 5.4 条**逐字**写着
  //    「系统侧需要检测，**必须放置的人物、金币**、以及是否已经选择了一种处理方式，
  //    不然按键变灰无法点击」⇒ 金币曾是三道判据之一。
  //    ⚠️⚠️⚠️ 2026-10-07 晚间**用户裁定（改，推翻上面那条）**：金币**不再是 ✔ 的闸**——
  //    「去掉没有放足量金币就不能点✔的约束……玩家可以尝试通过自然语言绕过原本要花的钱」。
  //    ⇒ 红槽照旧显示最低额（那是**建议值**，让玩家知道"正常"要给多少），
  //      但一分不给也能点 ✔；此时【玩家的处理】块会**如实写**「玩家尝试不直接支付金币」
  //      （见 `blocks.ts · handlingBlock`），由 LLM 裁定对方买不买账（拒绝/抬价/被说服皆可）。
  //    （服务端本来就只兜"付不起"：`rules/gates.ts` 闸门 ⑨ 只比 `goldToPay ≤ 余额`，
  //     从不看 `min_gold` —— 前端松闸后**无需任何服务端改动**，链路天然成立。）
  //    ⚠️ 拖金币卡的第一下仍是 `min(最低额, 余额)`（`goldDropAmount`）—— 想给钱的玩家
  //      一步给够的体验不变；只是"不给"这条路现在也通。
  const goldReq = e.min_gold > 0;
  const slotGold = '<div class="goldreq' + (goldReq ? ' req' : '') + '" data-drop="gold" data-ev="' + e.id + '"' +
    ' title="' + (goldReq ? '建议垫 ' + e.min_gold + ' 金（不给也行 —— 但对方未必买账）' : '可空') + '">' +
    '<div class="pslot' + (sel.gold > 0 ? ' filled gold' : '') + '" data-drop="gold" data-ev="' + e.id + '"' +
      ' title="' + (ro
        ? '已垫 ' + sel.gold + ' 金（已交出去，只作回看）'
        : (sel.gold > 0 ? '已垫 ' + sel.gold + ' 金 —— 点一下取回' : '把金币卡拖到这里')) + '">' +
      // ⚠️⚠️ 2026-10-07 用户第 5 条补充：「金币的数值是**显示在卡槽中央**，
      //   而不是**冒出来一个批注**」⇒ 值就写在槽心那一个大数字上，那个
      //   `<input class="goldnum">`（它此前贴在钱槽**下面**、像一个旁注）整块删掉。
      //   垫钱只有一条路：**把金币卡拖进这一格**（`goldDropAmount` 定过去几枚）。
      (sel.gold > 0
        // ⚠️ 2026-10-07（用户第 1 条）：已垫的金币也**能抓起来拖走** ——
        //   `data-kind="gold"` ＋ `data-ev`（从哪件事拖出来的 ⇒ 拖回带子只退这一件）。
        ? '<span class="hg small" data-kind="gold" data-ev="' + esc(e.id) + '">' + sel.gold + '</span><span class="px">×</span>'
        : (goldReq ? '<span class="reqnum">' + e.min_gold + '</span>' : '<span class="pdash">＋</span>')) +
    '</div></div>';

  // ⚠️⚠️⚠️ 2026-10-06 清单第 5 条：**横向一屏**，左 2/3 卡槽 ＋ 右 1/3 长方格。
  //
  // 【为什么不再"点一下展开"】（5.1，用户原话「不需要再点开一次才能展开详情，
  //   **去掉这个折叠**」）⇒ **处理台一进来就是完整的**：没有折叠开关、
  //   没有"点一下才展开"那一步 —— 卡槽与处理方式**永远在**。
  //
  // 【✔ 的置灰判据】（2026-10-07 用户裁定：**金币已出闸**，只剩「必放人物 / 处理方式 /
  //   简略备注」）—— 人物闸与服务端同一个口径（`rules/gates.ts` 闸门 ③）；
  //   金钱侧服务端只兜"付不起"（闸门 ⑨），"给不给、给多少"交给叙事裁定（见上）。
  const needOk = !e.requiredPerson || chosen.has(e.requiredPerson.id);
  // ⚠️ 处理方式**互斥单选**（5.6「两个按钮必须点且只能点一个」）⇒ 用 `handling` 存，
  //   初始空（= 还没选）⇒ 那一刻 ✔ 是灰的。
  const how = sel.handling || '';
  const howOk = !!how;
  // ⚠️⚠️ 2026-10-07 用户裁定（**改**，推翻上一条"一律必填"）：**「你的具体处理方式」只在
  //   选了「简略处理」时才需要填写** —— 用户原话「玩家点了『亲自去且仔细处理』后，无需
  //   填写『你的具体处理方式』，也可以点击✔」；场景那路玩家进场后自由对话，提交框那一句
  //   本来就用不上。⇒ noteOk 只在 `how === 'brief'` 时参与合取。
  const noteOk = how !== 'brief' || !!String(sel.note || '').trim();
  // ⚠️ 「进多轮」**要求槽里有玩家自己**（用户裁定第 21 条）
  const selfOk = canSelf && chosen.has(meId);
  const canGo = how === 'scene' ? selfOk : (how === 'brief' ? canSelf || canDispatch : false);
  const okAll = needOk && howOk && noteOk && canGo && chosen.size > 0;
  // ⚠️ 清单第 1 条（持久化）：回看态把"两个互斥按钮 ＋ 叮嘱输入框"换成**只读摘要** ——
  //    玩家看到的是"我当时是这么办的"，而不是一套还能点、点了也没用的控件。
  const howHtml = ro
    ? '<div class="rohow">处理方式：<b>' +
        (how === 'scene' ? '亲自去且仔细处理（场景实时互动）' : how === 'brief' ? '简略处理' : '（已交出）') + '</b>' +
        (sel.note ? '<span class="ronote">你的具体处理方式：' + esc(sel.note) + '</span>' : '') +
      '</div>'
    : '<div class="ops modes">' +
        '<button class="' + (how === 'brief' ? 'on' : '') + '" data-act="how" data-ev="' + e.id +
          '" data-how="brief"' + (!canSelf && !canDispatch ? ' disabled' : '') + '>简略处理</button>' +
        // ⚠️ 2026-10-07 用户裁定：**只有选中「简略处理」后这里才收字** ——
        //   没选 / 选了「亲自去」时整颗输入框禁用（点「亲自去」后它自然灰掉），
        //   占位文案就是那句规则本身：「选择简略处理时需要填写」。
        '<span class="notefield">你的具体处理方式 ' +
          '<input type="text" data-act="note" data-ev="' + e.id +
          '" value="' + esc(sel.note) + '" placeholder="选择简略处理时需要填写"' +
          (how === 'brief' ? '' : ' disabled') +
          ' title="这一句会原样交给办事的人（与结算）—— 选「简略处理」时必填，「亲自去」用不上"></span>' +
      '</div>' +
      '<div class="ops modes">' +
        '<button class="' + (how === 'scene' ? 'on' : '') + '" data-act="how" data-ev="' + e.id +
          '" data-how="scene"' + (!selfOk ? ' disabled' : '') +
          ' title="' + (selfOk ? '亲自去，进多轮场景' : '槽里要有你自己（这一局必须你在场）') + '">亲自去且仔细处理（场景实时互动）</button>' +
      '</div>';

  // ⚠️⚠️ 2026-10-07（用户第 1 条）：**去掉外面那层** —— 这里不再包 `.card`
  //   （双层框四边各吃 30px+，用户原话「不需要两侧卡面，直接去掉外面那层节省空间」）。
  //   `#modal.evdeskmodal` 自己就是唯一那层金框（见它的 CSS）。
  return '<div class="evdesk">' +
    // ── 左 2/3：卡槽（上 3/4）＋ 两个处理方式按钮（下 1/4）──
    '<div class="evdesk-l">' +
      // 上 3/4 = 菱形复合槽（4 个人物槽 ＋ 中心金币槽）＋ 物品位
      // ⚠️ 2026-10-07（用户裁定·机制提示）：菱形上挂一句 tooltip（不占版面——
      //   用户第 5 条裁定过这一格"太花"，所以**只做悬停提示**，不加可见文字）：
      //   教的是"一件事最多同时派这几个人，而**多件事可以同时各办各的**"。
      '<div class="diawrap" title="四个角各放一个人；不同的事可以同时各派各的人 —— 回到地图点开另一件接着派"><div class="dia" data-drop="who" data-ev="' + e.id + '">' +
        // ⚠️ 宽菱形描边（2026-10-07 用户裁定「菱形拉宽」）：尖端 (190,40)(340,140)(190,240)(40,140)，
        //   四个 .pslot 的中心正好钉在这四点上（坐标见 CSS）。
        '<svg class="diaborder" viewBox="0 0 380 280" aria-hidden="true">' +
          '<polygon points="190,40 340,140 190,240 40,140"/>' +
        '</svg>' +
        slots.join('') +
        slotGold +
      '</div></div>' +
      // ⚠️⚠️ 2026-10-07 用户第 5 条：「左 2/3 的上 3/4 **直接呈现卡槽，只需要
      //   **4 个人物槽 ＋ 一个金币槽**」。
      //   ⇒ 撤掉的三样（都是"多余的文字与小方格按键"）：
      //     · .dia-item 物品位 —— 用户原话给了替代：「**需要携带的物品请提前装备在人物身上哦**」；
      //     · .pick 复选框名单（十来个名字）—— 人手唯一的入口是**把卡拖进菱形四角**；
      //     · blockedLine「另有 N 人调不动（…）」—— 同上，不再是一屏文字。
      //   ⚠️ 只有一种情况仍要一句话：**「非某人不可」而他那个人此刻调不动** ——
      //     那是个死局（红色卡槽里写着名字、却谁也放不进去），不点破玩家会以为页面坏了。
      '<div class="eqhint">需要携带的物品请提前装备在人物身上哦</div>' +
      (reqUnavailable
        ? '<div class="reqline dead">非 ' + esc(reqName) + ' 不可 —— 可他此刻「' +
            esc(blockedReason(reqPerson)) + '」，这件事今天办不成（' + reqAdvice(reqPerson) + '）</div>'
        : '') +
      // 下 1/4 = 两个处理方式按钮（**互斥单选**；"简略处理"在偏上侧、旁边是叮嘱框）
      // ⚠️ 回看态（ro）这里是一行只读摘要（见上面 howHtml）。
      howHtml +
    '</div>' +
    // ── 右 1/3：长方格（标题 ＋ 属性读数 ＋ 描述 ＋ 下框 ×/✔）──
    '<div class="evdesk-r">' +
      // ⚠️⚠️ 2026-10-07 用户第 5 条：「除了事件详情（可滑动），其他都直接完整呈现」
      //   ＋「**不需要其余任何文字内容与小方格按键**，现在的太花了」。
      //   ⇒ 这一格只剩三样：**标题（带小钟）＋ 属性实时读数 ＋ 事件正文**。
      //   ⇒ 删掉的：.tags（可以派人去/时长/期限/派谁去/难度/建议垫 金 那一坨）
      //             .sub（发布时机那一行 —— 它还有个真 bug：when 在 cardHtml
      //                   作用域里根本没定义，真机渲染成 "function when(){ [native code] }"）
      //             selLine（"已选 N 人"—— 槽里已经看得见，不必再复述一遍）
      // ⚠️⚠️ 2026-10-07 用户第 5 条补核：**属性读数在标题的「左侧」**——
      //   原话「事件标题左侧显示处理事件所需要的属性（一开始是 0，会根据放上去的
      //   人物卡属性而实时变化）」。此前 `attrReadout` 画在 `.evd-title` 的**下一行**
      //   （独立一行、左侧对齐），玩家读到的顺序是"先标题、再属性"，而用户要的是
      //   "左边一眼是属性、右边是标题"。—— 顺序即语义：属性是"这件事要什么"，
      //   标题是"这是什么"，前者应该在读标题前先扫到。
      //   ⇒ 挪进 `.evd-title` 内部、`<span class="nm">` **之前**（同一行、靠左）。
      '<div class="evd-title">' + attrReadout +
        '<span class="nm">' + esc(e.title) + '</span>' +
        '<span class="cost" title="处理这件事要花多少行动力">🕐… ' + e.cost + ' 点</span></div>' +
      // ⚠️ 2026-10-07（用户第 4 条）：属性读数**旁边**那句暗示 —— 教的是规则
      //   （处理方式有趣 ⇒ 可能换属性 / 免骰直接成 / 也可能翻车），让玩家敢写有趣的方案。
      //   有属性读数才出现（没有判定属性的事件没有"换属性"可言）。
      (实时.length
        ? '<div class="attrhint">有趣的处理方式有可能变更所需的属性，甚至无视属性直接成功 —— 当然，也可能导致事件失败</div>' +
          // ⚠️ 2026-10-07 用户裁定：读数口径本身也要一句小字教给玩家。
          '<div class="attrhint">属性取参与者对应属性的最高值</div>'
        : '') +
      '<div class="prose" style="margin-top:8px">' + escProse(e.content) + '</div>' +
      // ⚠️ 2026-10-07（用户）：✔ 的硬前置写成常驻提醒 —— 回看态没有 ✔，也就不必提。
      (ro ? '' :
        '<div class="opshint">放置处理角色并选择一种处理方式后，再点 ✔ 完成处理</div>') +
      '<div class="evd-ops">' +
        '<button data-act="closeDetail" title="退出当前事件">×</button>' +
        // ⚠️ 回看态不给 ✔ —— 事件已经交出去了，再给一颗"确定"只会让人以为还能改。
        // ⚠️ `data-okbase` ＝「**除 note 之外**的其余判据合取」（needOk/howOk/canGo/人数）。
        //    打字时只有 noteOk 在变 ⇒ input 处理器**只改这一颗按钮的 disabled**，
        //    绝不整轮 render —— 整轮 render 会**重建输入框 DOM**：
        //    ① 打断 IME 组合（中文没法打）；② 重复触发 input ⇒ 一个字母进三个（2026-10-07 实测）。
        (ro ? '' :
        '<button class="primary" data-act="commit" data-ev="' + e.id + '" data-how="' + esc(how) + '"' +
          ' data-okbase="' + (needOk && howOk && canGo && chosen.size > 0 ? '1' : '') + '"' +
          (okAll ? '' : ' disabled') + '>✔</button>') +
      '</div>' +
    '</div>' +
  '</div>';
}

// ⚠️⚠️ 2026-10-06 清单第 4B 条：原先那个「三格候选项就地选择」的 `slotHtml` **已删** ——
//   它服务的是 P5-B 那张地图区放格子卡（三个 `optchip` 按钮 ＋ 建议标记），
//   那一整块与它的候选状态都已撤（第 16 / 22 条）。
//   ⇒ 放格子现在**只有一处**：`sheetQuest` 的四行卡位（凭证拖放）。
//   留着它就是"两处都能放格子"，而它那条路没有凭证可拖、也没有凭证可显示。

function renderMid(v){
  const parts = [];

  // ⚠️⚠️ 2026-10-06 用户裁定（**改**，推翻了 2026-10-05 那条「同屏处理台」）：
  //   「点开后应该是在画面中间有一个**额外的弹窗区，在地图层上方**，
  //     而不是**显示在地图层上面**」
  //   ⚠️ 10-05 那条把它**内嵌进中栏**、理由是"手牌带要保持可见可拖"——
  //     但代价是**它把地图本身顶掉了**（事件块被挤到一边、画布不再是主体）。
  //   ⇒ 改回**浮层**，但**浮层里自带一块"卡带"**：
  //     玩家拖东西不必去够屏幕最下面 ⇒ 「手牌带保持可拖」那条目标**仍然达成**，
  //     而地图不用被挤。
  //   ⇒ 中栏**不再**画它 ⇒ 地图完整、事件块不被挤。
  //   ⚠️ 浮层那条在 `renderOverlay` 里**已打开**（见那里 `kind === 'event'` 那一支）。

  if (v.isOver) {
    const e = v.ending;
    parts.push('<div class="card" style="border-color:var(--gold-line);background:var(--gold-soft)"><h3>终局</h3>' +
      '<h2 style="font-size:18px;color:var(--accent)">' + esc(e.name) + '　<span class="chip">' + esc(e.kind) + (e.flavor ? ' · 风味 ' + esc(e.flavor) : '') + '</span></h2>' +
      '<div class="sub" style="color:var(--muted)">第 ' + e.day + ' 天 · ' + esc(e.reason) + '</div>' +
      (e.title ? '<div class="sub" style="color:var(--muted)">「' + esc(e.title) + '」</div>' : '') +
      '<div class="body" style="margin-top:8px">' + esc(e.text || '（这一局的话术缺失 —— ending 侧链没有产出）') + '</div>' +
      '<div class="sub" style="color:var(--muted)">放格子：成果 ' + esc(e.placements.成果 || '（空）') + ' / 手段 ' + esc(e.placements.手段 || '（空）') + ' / 共鸣 ' + esc(e.placements.共鸣 || '（空）') + '</div>' +
    '</div>');
  }

  // ⚠️⚠️ 2026-10-06 清单第 4B 条（用户裁定第 22 条 / 第 16 条）：**地图区这张「放格子」卡整块删除**。
  //   它是 P5-B 时代的旧通路（下拉三选 ＋ 一颗「按建议值」按钮），而现在：
  //     · 放格子的唯一入口是**「你的欲望」那一屏**（四行卡槽 ＋ 凭证拖放 ＋ 只有最后一天能确定）；
  //     · 「**按建议值**」那颗按钮**按用户裁定删掉**（第 16 条：「删掉 autoPlace，不做兜底」）
  //       —— 系统替玩家填三格，与"这一局是他自己走出来的"直接冲突。
  //   ⇒ 两处并存会让玩家在地图区点到一个**没有凭证卡可拖**的旧界面，
  //     而那一处的「结束这一局」绕过了第 22 条要的整个流程。

  // ⚠️⚠️ 2026-10-07（用户裁定）：**场景不再画在中栏** —— 它搬进浮层对话窗
  //    （`renderOverlay` 里 `v.scene` 那一支，复用事件台的位置）。
  //    中栏这块旧卡整段撤掉：两处各画一遍 = 同一场对话两个入口。

  // ⚠️ 2026-10-05：原先这里有一张「等着你当场拿主意（N）」的提示卡，**撤掉了** ——
  //    它与画布正中那张**大牌**说的是同一件事（同一口径两处呈现 = 同一段话读两遍，
  //    那正是"细碎"的来源）。现在那句话只留在大牌的卡面与画布卡标题上。
  // ⚠️⚠️ 2026-10-06 三段式布局：**「最终任务清单」＋「未入队」从左栏搬进这里**
  //    （用户裁定「最终任务区域和未入队人物应该也是**地图区内的方格**」）。
  //    ⇒ 它排在**画布之上**（画布是主体，清单是它的抬头）。
  //    ⚠️ 左栏那个 `#colLeft` 元素已 `display:none`（`renderLeft` 仍调用，但写进
  //    一个看不见的元素）—— 保留那次调用是为了**不改动它内部那堆断言**。
  // ⚠️ 2026-06：`leftHtml` 现在**由 `canvasHtml` 画进 `.canvas-pan`** ——
  //   它要与事件块（`.cvchip`，也是 `position:absolute`）**同一套坐标系**，
  //   否则"浮在左上角"会与事件块错位。
  // ⚠️⚠️ 2026-10-07 用户第 23 条：「『这些是摆在...』这句话应该显示在地图**最上面居中**，
  //   而且是淡黄色斜体小字（表示是提示性小字）」。
  //   ⇒ 它是**中栏的第一个元素**（真实布局块，不是绝对定位）⇒ 必然在整栏最顶、正中。
  //   ⚠️ **只在没有档 A 待办时出现**（有档 A 时台面里那句换成「就这一件（N）」，
  //     那才是玩家此刻该看的东西 —— 提示语不该在"必须处理"时占注意力）。
  // ⚠️⚠️ 2026-10-08（用户裁定）：这句话按阶段分三态 ——
  //   ① 序幕（`v.prologue` 非空 = 还有待处理的序幕档 A）⇒ 序幕版提示；末条
  //      「原初欲望的觉醒」还没铺出（`openingLaid` 假）时旁边带「直接正式开始游戏」按钮，
  //      铺出后按钮消失（玩家该去点那张卡）。
  //   ② 觉醒刚点完、还没翻进第 1 天的间隙（day 0 且序幕已完）⇒ 什么都不显示 ——
  //      那一刻是 pickCommit 的自动收尾，不该被提示语抢注意力。
  //   ③ 正式游戏（day ≥ 1 且没有档 A 待办）⇒ 原句照旧（下面 2026-06 那句）。
  const pro = v.prologue;
  if (pro) {
    parts.push('<div class="cvtop">以下是你要处理的事件，请通过这些事件了解你自己和你的周边吧！' +
      (pro.openingLaid ? '' :
        '<button class="cvskip" data-act="skipPrologue" title="跳过剩下的序幕事件，直接翻开「原初欲望的觉醒」">直接正式开始游戏</button>') +
      '</div>');
  } else if (!(arr(v.popups).length) && (v.day || 0) > 0) {
    parts.push('<div class="cvtop">这些是摆在你面前的事，你也可以通过左下角的「我想做点什么」自己创建事件</div>');
  }
  parts.push(canvasHtml(v));

  $('colMid').innerHTML = parts.join('');
}

// ⚠️⚠️ 2026-10-07（用户裁定）：**场景交互 = 常规对话窗** —— 复用事件台浮层的位置，
//    不再是中栏那张"卡"。用户原话：「左边气泡是LLM的输出，右边气泡是玩家的输入；
//    窗口里的对话可以滑动」「进去这个界面后，要重新出现一遍事件的具体描述
//    （视为第一个LLM气泡），然后后面加一个固定消息"你打算怎么做？"，然后玩家可以自由输入」。
// ⚠️ 2026-10-07（用户复裁）：**字号大一些** —— .bub 13.5px ⇒ 15px（输入框同档）。
// ⚠️ 逐轮记录（`sc.turns`）是**一句打包的字符串**：`第 N 轮｜玩家「…」｜叙述`——
//    拆开就是一对气泡；玩家那句在右、LLM 的叙述在左。
//    ⚠️ 2026-10-07：场景不掷骰 ⇒ 原来夹在中间的「判定 X」段已不存在。
function sceneChatHtml(sc, v){
  const ev = eventOf(sc.eventId);
  const bubbles = [];
  // ① 首个 LLM 气泡 ＝ **事件的具体描述**（进场景重放一遍 —— 玩家不必退出去翻事件卡）
  bubbles.push('<div class="bub llm"><b>' + esc(sc.title) + '</b>' +
    (ev && ev.content ? '<br>' + escProse(ev.content) : '') + '</div>');
  // ② 固定的邀请句
  bubbles.push('<div class="bub llm">你打算怎么做？</div>');
  // ③ 逐轮气泡
  for (const t of sc.turns) {
    const seg = String(t).split('｜');
    const said = (seg[1] || '').replace(/^玩家「/, '').replace(/」$/, '');
    const narr = seg.slice(2).join('｜').trim();
    bubbles.push('<div class="bub me">' + esc(said) + '</div>');
    bubbles.push('<div class="bub llm">' + (narr ? escProse(narr) : '<span style="color:var(--muted)">（无回应）</span>') + '</div>');
  }
  // ⚠️ 2026-10-08 用户裁定：轮数用尽**只禁输入、不自动跳结算** —— 到了上限（round ≥ cap）
  //    就把输入框和「说这一句」一起禁掉，只留「结束对话」让玩家**手动**触发收尾结算
  //    （服务端 `sceneSay` 另有一道闸防绕过）。
  const capped = sc.round >= sc.cap;
  return '<div class="evd-title"><span class="nm">场景 · ' + esc(sc.title) + '</span>' +
      '<span class="cost">第 ' + sc.round + ' / ' + sc.cap + ' 轮 · 在场 ' +
      sc.present.map((p) => esc(p.name)).join('、') + ' · 已报花销 ' + sc.spent +
      (sc.goldLocked ? '（最多 ' + sc.goldLocked + '）' : '') + '</span></div>' +
    '<div class="chatbox" id="chatbox">' + bubbles.join('') + '</div>' +
    '<textarea id="sayText" style="width:100%;height:56px;margin-top:10px"' + (capped ? ' disabled' : '') +
      ' placeholder="' + (capped ? '本场轮数已用尽 —— 请点「结束对话」收尾结算' : '你要说什么 / 做什么……') + '"></textarea>' +
    '<div class="ops" style="margin-top:8px"><button class="primary" data-act="say"' + (capped ? ' disabled' : '') + '>说这一句</button>' +
      '<span class="sep">|</span><button data-act="leave">结束对话（收尾结算）</button></div>';
}


/**
 * 一个字符串的**确定性**散列（FNV-1a 变体）。
 * ⚠️ 它决定「这条事落在画布哪儿」 ⇒ 必须是**纯函数**：同一个 id 每次都得到同一个数。
 *    否则每次重画（勾人 / 展开 / 存读档）事件都会**跳位**，玩家会以为自己点错了东西。
 */
function hashOf(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * 把 N 条事件摆到画布上 —— **确定性伪随机**，视觉上像随手撒的。
 *
 * 用户口径（2026-09-22）：「事件较为随机出现在画布上就可以，**不需要根据地点分区**，
 * 地图上只需要出现事件的 title 就可以，点开后才看到详情。」
 * ⇒ **不读 `location` / `stage`**，不分区、不设层级（《设定.md》:619 因此原样成立）。
 *
 * 三条纪律：
 *   ① **不重叠**（2026-10-06 重写，见下面那段说明）；
 *   ② **稳定**：排序键是 id 的 hash ⇒ 事件增减时只有少数几条换位
 *      （按插入序或按 id 字典序排，都会整片挪）；
 *   ③ 位置是**百分比** ⇒ 换窗口大小、条数变化都不会跑出界。
 *
 * ⚠️⚠️ **2026-10-06 重写「不重叠」**（用户裁定问题 8：「事件在地图上的显示很奇怪，
 *    **部分事件的图层会重叠**」）。**真因不是"没排"，是三处对不上**：
 *   · 旧算法 `y = (r + 0.5) * (100 / rows)` ⇒ **按条数均分**每行高度；
 *   · 而 `.cvchip` 是 `max-width:180px` ＋ **`word-break:break-word`、没有 `line-clamp`**
 *     ⇒ 标题多长就多高（**没有上限**）⇒ 一行的实际需要高度**不是** `100/rows`；
 *   · `.canvas` 又有 `min-height:420px; max-height:min(72vh,100%)` ⇒ 画布**不一定**长得够。
 * ⇒ 改成**按标题字数算真实卡高**，再据此定行距；行距算出来装不下就**减少列数**。
 * ⚠️ **纯计算、不读 DOM**：读 `offsetHeight` 得等下一帧（元素还不存在），
 *   那样会看到"先叠一下再弹开"。**估算是稳的**，且不抖。
 * ⚠️ 抖动**不许吃掉行距**：旧代码的 `jy` 能把两张相邻行的卡推到一起 ⇒ 抖动幅度
 *   必须**小于**（行距 − 卡高）的一半，否则"排好了又被抖叠"。
 */
/** 上一帧量到的台面宽度（首帧量不到时用它兜底，见 `canvasHtml` 里那三级回退） */
var lastCanvasW = 0;
// ⚠️ 2026-10-08：左栏（`.mapcorner`）底缘的**实测记忆** —— 首帧量不到时用它
//    （与 `lastCanvasW` 同一手法，见 `canvasHtml` 里那段量测）。
var lastCornerBottom = 0;

function canvasSlots(ids, titles, W, H, opts){
  // ⚠️ 2026-10-07：`opts`（可省）—— 档 A 大牌与普通散事**共用同一套摆位算法**，
  //    只是**卡的尺寸不同**（大牌 340 宽、字号 16）：
  //    · `chipW`  ／ `padY` ／ `lineH` ／ `markH` —— 卡面尺寸（与 CSS 同源，见 `.cvchip.big`）；
  //    · `topOffset` —— **这一批从更低的纵线起步**：大牌先铺（第一遍调用），
  //      散事第二遍调用时让开大牌占掉的那段高度，两批才不会叠在一起。
  opts = opts || {};
  var n = ids.length;
  if (!n) return { list: [], rows: 0, cardH: 0, slotH: 0, zoneW: 0, zoneH: 0, padL: 0, padT: 0, needH: 0 };
  titles = titles || {};
  // ⚠️ 三个尺寸**与 CSS 同源**（`.cvchip` 那些值）—— 改 CSS 就得改这里
  var CHIP_W = opts.chipW || 180;      // `.cvchip{max-width:180px}`（大牌 340）
  var PAD_Y = opts.padY || 14;         // `.cvchip{padding:7px 11px}` ⇒ 上下共 14（大牌 32）
  var LINE_H = opts.lineH || 18;       // `font-size:13px; line-height:1.4` ⇒ 18.2（大牌 16px×1.45 ⇒ 23）
  var GAP = 14;                        // 行间留白
  var REF_H = 420;                     // `.canvas{min-height:420px}` —— 画布的**下界**
  var MARK_H = opts.markH !== undefined ? opts.markH : 20;  // 块头上那一行（状态行 ＋ 属性图标）的高度（大牌没有 ⇒ 0）
  var TOP0 = Math.max(0, opts.topOffset || 0);              // 让开上一批（大牌）已占的高度

  // ⚠️⚠️ 2026-10-07 用户 08:54：「事件的位置本身，需要限制在一个**合理的长方格**内，
  //   只不过这个长方格的**边框不实际显示出来**」。
  //   ⇒ 这四个内缩量就是那个长方格（**不画边**，只留白）：
  //     · 左内缩要**让开左上角那两块常驻卡**（`.mapcorner` 宽 292px ＋ 台面自身 12px）；
  //       但那两块只在**上半身**占位 ⇒ 左内缩按"上三行"的高度算，下面几行放回全宽，
  //       否则事件会被整体挤到右边、在空旷的台面右半边堆成一列。
  //     · 上内缩给 `.cvtop` 那句提示与块头那行标记让位。
  var W0 = Math.max(360, Number(W) || 800);
  var H0 = Math.max(260, Number(H) || REF_H);
  // ⚠️ 2026-10-07：`padT` **天生含 `TOP0`**（大牌那批先铺掉的高度从这里让出来）——
  //   起步纵线、上沿钳制、行数预算、`needH` 全部自然跟着走，不用各处单加。
  var padL = 12, padR = 12, padB = 12;
  var padT = 10 + TOP0;
  var CORNER_W = 304;    // `.mapcorner` 292 ＋ 台面 12
  // ⚠️ 270 是 2026-10-08 实测校准（1440×900 · 假brain）：`.mapcorner` offsetTop 12 ＋ 高 258
  //    ⇒ 真实底缘 270，加 padT(10) ⇒ 回退 CORNER_BOTTOM=280，与实测记忆值（278，含 +8 呼吸）同档。
  //    旧值 232 低于实际 ⇒ 首帧（量不到时）让开段偏短，行高随标题长度浮动时可能压上下沿。
  var CORNER_H = 270;    // 那两块的高度 —— 回退值，实测优先（`opts.cornerBottom`）
  // ⚠️⚠️ 2026-10-08（用户裁定「序幕事件不得与左栏重合」）：左栏底缘以**实测**为准 ——
  //    写死值只是首帧兜底（上一帧是标题屏量不到）。调用侧量 `.mapcorner` 实际底缘传进来。
  var CORNER_BOTTOM = (opts.cornerBottom !== undefined && opts.cornerBottom !== null)
    ? opts.cornerBottom : (padT + CORNER_H);

  // 一张卡的真实高度：标题按 `CHIP_W` 的宽度折行 ⇒ 每行约 floor(CHIP_W / 13) 个汉字
  var perLine = Math.max(4, Math.floor(CHIP_W / 13));
  function cardH(id){
    var t = String(titles[id] || '');
    var lines = Math.max(1, Math.ceil(t.length / perLine));
    return PAD_Y + MARK_H + lines * LINE_H;
  }
  // ⚠️ **按这一批里最高的卡算行距** —— 用平均值会在"一长一短"时算矮了，长标题那张就探出界
  var tallest = 0;
  for (var k = 0; k < n; k++) tallest = Math.max(tallest, cardH(ids[k]));
  var slotH = tallest + GAP;

  // ⚠️ **列数按真实可用宽度算**（不再是"按 800px 估"）——
  //   可用宽度 = 台面宽 − 左内缩 − 右内缩；一张卡连间隙占 `CHIP_W + 26`。
  var zoneW = Math.max(180, W0 - padL - padR);
  var maxCols = Math.max(1, Math.min(4, Math.floor((zoneW + 26) / (CHIP_W + 26))));
  var cols = Math.min(maxCols, n <= 1 ? 1 : (n <= 4 ? 2 : maxCols));
  var rows = Math.ceil(n / cols);
  // ⚠️⚠️ 2026-10-07：**纵向放不下就降一档列数**（探针抓到的真问题）。
  //   例：14 条那一档 3 列要 5 行 × 84px ＝ 420px > 可用 418px ⇒ 顶上那张探出上沿 2px。
  //   ⇒ 降到"装得下"为止；**降到 1 列仍装不下**（14 条 × 66px ＝ 924px），
  //     那是"事件太多"的病 —— **不硬塞**，如实报一个 `needH` 让调用处把台面抬到那个高，
  //     页面出滚动条（`.canvas-card` 那套已经在做这件事）。
  for (var guard = 0; guard < 4 && cols > 1; guard++) {
    if (rows * slotH <= H0 - padT - padB) break;
    cols--;
    rows = Math.ceil(n / cols);
  }

  // ⚠️ **纵向**：整批卡的高度**居中**在可用区里（上下各留一半空白），而不是从 0 开始铺
  //   ⇒ 台面矮时不会顶到上沿。
  //   ⚠️ ⚠️ `Math.max(slotH, …)` **不是** `Math.max(rows * slotH, …)` ——
  //     后者会让"装不下时"的那几行**又落回台面里**（叠在一起）。
  //     装不下 ⇒ `startY = padT`（从顶部开始排），由 `needH` 让调用处把台面抬起来。
  // ⚠️⚠️ **变量名一律英文**（中文标识符在 JS 里不合法，本项目已踩过）
  var zoneH = Math.max(slotH, H0 - padT - padB);
  // ⚠️ `startY = padT`（**不做居中**）：槽位模型自己一行一行往下排，
  //   居中会让"卡少的时候飘在中间"（实测那是大片死空白的来源）。短了就短着。
  var startY = padT;

  var cw = zoneW / cols;
  var list = ids.slice().sort(function (a, b) { return hashOf(a) - hashOf(b); })
    .map(function (id, i) {
      var c = i % cols, r = Math.floor(i / cols);
      var h = hashOf('#' + id);
      var jitterX = ((h % 5) - 2) * 0.6;                     // ±1.2px ⇒ 横向几乎不动
      var jy = (((h >> 5) % 5) - 2) * (GAP * 0.5 / rows);
      // ⚠️ 卡心 y = **该行的中心**（`startY + r*slotH + tallest/2`），不是「自己卡高的一半」——
      //    用自己那半的话，同一行里高矮不一的卡会**错开**（实测同行能差 14px，看着像没排整齐）。
      // ⚠️ **x 是"卡心"**：`(c+0.5)*cw` 已经把列宽摊成"卡心在格中心"，
      //    加上 `padL` 才是真正的像素位置 ⇒ 最后一列的右缘恰好落在 `W0 − padR`。
      return {
        id: id, c: c, r: r,
        jitterX: jitterX,                                      // ⚠️ 2026-10-07：**必须挂出来**
                                                       //   —— 下面"按行重排"那一步要用它。
                                                       //   漏挂 ⇒ `it2.jitterX` 是 undefined
                                                       //   ⇒ 整个 `x` 变 NaN ⇒ **整批卡消失**（探针抓到的）。
        x: padL + (c + 0.5) * cw + jitterX,                   // **像素**（不是百分比）；上面会按行重排一遍
        rowY: startY + r * slotH,                            // 那一行的**上沿**（像素）
        rowMid: startY + r * slotH + tallest / 2,            // 那一行的**中心**（同行对齐用它）
        jitterY: jy,
        cardH: cardH(id),
      };
    });
  // ⚠️⚠️ **上半身让开左上角那两块常驻卡**（2026-10-07 用户 08:54 截图里的那个问题）：
  //   事件块压在「最终任务清单 / 尚未入队」上面，两边都看不清。
  //
  //   ⚠️⚠️⚠️ 这里的前三版都有真 bug（都是 `probe/verify-canvas-zone.mjs` 抓出来的）：
  //     ① 把整列一起推到「`CORNER_W + CHIP_W/2`」⇒ 两张卡挪到同一条竖线上；
  //     ② 改成"只推会压的那一张"，但只跟**同行**比 ⇒ 与邻行的卡叠上；
  //     ③ 改成"逐张往下顺延" ⇒ 顺延多出的高度**被硬夹回台面**，
  //        于是推出下沿的那几张又叠回一起（越界与相交同时出现）。
  //   ⇒ 现在的口径：**先按列排开、再按行排开**，而"让开左上角"**只影响那几行的横向起点**。
  //     具体：`padL` 在上半身那一段之内**加大**（让开 `.mapcorner`），下半身恢复小 `padL`
  //     ⇒ **不额外占行、不挪 y**，纵向高度完全由 `rows × slotH` 决定（那是"够用"的）。
  // ═══════════════════════════════════════════════════════════════
  // 逐行铺卡 —— **槽位模型**（2026-10-07 重写；前三版都是原地打补丁，全被探针打回）
  //
  // ⚠️⚠️⚠️ 之前的三个坑（都是 `probe/verify-canvas-zone.mjs` 一个个抓出来的）：
  //   ① 按「列下标 × step」算 x，右缘钳制把不同列挤到同一个 x ⇒ 叠在一起；
  //   ② 单列时 `step` 的 `|| 1` 让除数变 1 ⇒ `x = NaN` ⇒ **整批卡消失**；
  //   ③ `Math.min(slotInRow, perRow - 1)` 把排不下的那张**压到已占的格**上。
  //   ⇒ 现在的口径（一句话）：**先算每行放得下几格，再一行一行往上填；填满了就加一行。**
  //     没有钳制、没有 min、没有除法 —— 三个坑的来源（"算完再修"）全部去掉。
  //
  // ⚠️ **左上角那两块常驻卡**（`.mapcorner`，宽 304、高 232）让"上半身"几行的起点右移，
  //   那些行能放的格数因此**更少** ⇒ 于是自然会**往下多排几行**，直到出了那块的高度。
  //   这是"让开"与"排得下"两件事自动对齐的地方，不需要任何额外的挪动逻辑。
  var list2 = list.slice();          // 保持稳定顺序（`list` 的顺序由 hash 决定，不动它）
  var placed = [];
  var cursor = 0;
  var guardRows = 0;
  while (cursor < list2.length && guardRows < 40) {
    var mid = startY + guardRows * slotH + tallest / 2;
    // ⚠️⚠️ 2026-10-08：判据用**卡顶**（`mid − tallest/2`）而不是卡心 ——
    //    卡心过了左栏底缘、卡顶还没过 ⇒ 这一行与左栏**下沿叠上**（序幕大牌高 55px，
    //    卡心判据会漏进 27px 的重叠带）。以卡顶为准，整张卡都过了底缘才恢复全宽。
    var x0 = (mid - tallest / 2 < CORNER_BOTTOM) ? padL + CORNER_W + 10 : padL;
    var right = W0 - padR;
    // ⚠️ **这一行放得下几格**：卡宽 ＋ 26 间隙。至少 1（否则起点那一格自己都放不下）。
    var perRow = Math.max(1, Math.floor((right - x0) / (CHIP_W + 26)));
    // ⚠️ 槽距：让最右那一张的右缘正好落在 `right`。perRow===1 时不除（那正是坑 ②）。
    var gapW = perRow > 1 ? (right - CHIP_W - x0) / (perRow - 1) : 0;
    for (var g = 0; g < perRow && cursor < list2.length; g++) {
      var it2 = list2[cursor++];
      it2.x = x0 + CHIP_W / 2 + g * gapW + it2.jitterX;
      it2.rowMid = mid;
      // 夹进长方格：横向这两个方向（纵向的钳制在下面统一做一次）
      if (it2.x - CHIP_W / 2 < x0) it2.x = x0 + CHIP_W / 2;
      if (it2.x + CHIP_W / 2 > right) it2.x = right - CHIP_W / 2;
      placed.push(it2);
    }
    guardRows++;
  }
  // ⚠️⚠️ **纵向钳制只做两件事**（下面这两行是全部的纵向逻辑，不夹下沿）：
  //   ① 每张卡的**卡顶**不得高于 `padT`（判据**含 `jitterY`** —— 渲染时 y ＝ rowMid+jitterY）；
  //   ② 下沿**交给 `needH`**（调用处拿它当台面高度，页面出滚动条）——
  //     在这里硬夹下沿 = 把装不下的几张叠回一起（那正是坑 ③ 的本质）。
  var minMid = padT + tallest / 2;
  for (var q = 0; q < placed.length; q++) {
    var top = placed[q].rowMid + placed[q].jitterY - placed[q].cardH / 2;
    if (top < padT) placed[q].rowMid += padT - top;
    if (placed[q].rowMid < minMid) placed[q].rowMid = minMid;
  }
  // ⚠️ 行数按**真正铺出来的行**重算（`needH` 与它是同一个数 ⇒ 台面高度与摆位同源）
  var realRows = guardRows;
  return {
    list: placed, rows: realRows, cardH: tallest, slotH: slotH, cols: cols, refH: REF_H,
    zoneW: zoneW, zoneH: zoneH, padL: padL, padT: padT,
    // ⚠️⚠️ **台面至少要这么高才装得下**（2026-10-07）—— 调用处拿它当 `min-height`。
    //   **为什么要它而不是"硬塞"**：1 列 14 条要 924px，塞进 418px 就必然叠成一团。
    //   报出来 ⇒ 台面真长到 924px、页面出滚动条 ⇒ 每张都看得见、都点得到。
    needH: padT + padB + realRows * slotH,
  };
}

/**
 * **画布** —— 摆在你面前的事。
 *
 * 只装两类（2026-09-22 用户裁定「需要出现的事件，只有今天出现、未处理且未过期的、
 * 处理中的，其他都不需要」）：
 *   · **待处理**（`v.todo`）—— 还没派人去办，而且**没过期**（过期的在 `enterDay` 就结了）；
 *   · **处理中**（`v.waiting`）—— 已经派了人、等时间到点揭晓。
 * ⚠️ **档 A 不在画布上**：它是强制弹窗，一出来就盖住全屏（用户原话「弹窗的事件直接弹出」）。
 * ⚠️ **已结算 / 过期的都不在**：结果由「结算」那一次弹窗给过，画布不留痕（用户原话
 *    「文本消息也只需要在点开事件后可以看到就行，不需要单独保存出来」）。
 * ⚠️ 卡面上**只有标题**；正文 / 派谁去全在点开之后（`sheetEvent`）。
 */
function canvasHtml(v){
  // ⚠️ 2026-10-05（序幕铺牌）：**档 A 也上画布**，不再强制弹窗。
  //    用户的原话是「开局一进去就是疯狂点弹窗太突兀了」—— 问题不是"弹窗"这个控件，
  //    是**十次毫无关系的打断**：每弹一条，玩家要读一段、重建一次上下文、再被夺走焦点。
  //    ⇒ 把它们画成画布上**显眼的大牌**（`.cvchip.big`）：看得见"就这一件"，
  //      点它才展开，读完点确认。顺序仍由写账侧保证（池中只有一条），
  //      "没点完不许进下一天"由闸门 ④ 保证（`nextDay` 会问闸门）——**规则侧一字未改**。
  // ⚠️ 档 A 不进 `canvasSlots` 的百分比摆位 —— 它只占**正中**一个位置，
  //    与那两池散落的事**视觉上分开**（一个在中间、几个散在四周）。
  const pops = arr(v.popups);
  // ⚠️⚠️ 2026-10-07 用户裁定（第二批）：**医馆疗伤 / 神殿净化是地图上的常驻功能事件**——
  //   队伍里有人 hp/san 不满（1~2）才出现 ＋ 带同款呼吸脉冲；无过期时间；
  //   点开是功能单（人槽＋金币槽＋×/✔，不走 LLM，见 `fixSheetHtml`）。
  //   ⚠️ 它们**参与散事摆位**（id 前缀 `fix:`，chips 那里分叉渲染）——
  //     上一批塞进每个事件弹窗里的那张卡（`fixDeskHtml`）整块删除：
  //     用户原话「你把医馆和神殿莫名其妙的塞在每个事件里，也导致了原本的图层装不下了」。
  const fixCards = ['医馆', '大神殿'].filter(function (pl) { return fixNeeded(v, pl); })
    .map(function (pl) { return { id: 'fix:' + pl, title: FIX_SPECS[pl].title, place: pl }; });
  const items = arr(v.todo).concat(arr(v.waiting)).concat(fixCards);
  if (!items.length && !pops.length) {
    // ⚠️ 2026-10-07：那句邀请**已经提成中栏的第一个元素**（`renderMid` 里那个 `.cvtop`）
    //   ⇒ 这里**不再画第二遍**（同一个口径两处呈现＝同一段话读两遍）。
    // ⚠️⚠️ 2026-10-07（用户报告"处理完所有事会把「你的欲望」和「未入队」顶掉"）：
    //   **空态也必须走完整的 `.canvas` 结构** —— 「最终任务（欲望）」＋「尚未入队」
    //   两块住在 `.canvas-pan` 里（`leftHtml(v)`），此前空态直接 return 一张普通卡片，
    //   台面整个没了 ⇒ 那两块跟着消失，玩家以为功能被删了。
    //   ⇒ 空态 = **同一张台面**（保持高度）＋ 台面正中一句空态话，两块照常浮在左上角。
    return '<div class="canvas" style="min-height:420" data-canvas>' +
      '<div class="canvas-pan">' + leftHtml(v) +
        '<div class="card" style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);min-width:300px">' +
          '<div class="empty">这会儿没有摆在你面前的事。</div>' +
        '</div>' +
      '</div>' +
      '<div class="cvrecruit">当觉得事情很多、行动点不够用时，不妨试试招募人手，然后多派几个人去并行处理事件</div>' +
    '</div>';
  }
  const byIdOf = new Map();
  items.forEach(function (e) { byIdOf.set(e.id, e); });
  // ⚠️⚠️ 2026-10-06：把 **titles** 传进去 —— 摆位要按「这张卡有多高」算（`canvasSlots` 里的
  //    `cardH` 按标题字数分档估行数）。不传的话所有卡都按最短估，长标题那几张会叠上。
  //    ⚠️ 2026-10-07：**档 A 也要进来** —— 它们现在走同一套摆位（见下面 `popSlots`）。
  const titleOf = {};
  items.forEach(function (e) { titleOf[e.id] = e.title; });
  pops.forEach(function (e) { titleOf[e.id] = e.title; });
  // ⚠️⚠️ 2026-10-07：**台面真实宽度**（摆位限制在长方格内，用户 08:54 的原话）。
  //
  // ⚠️⚠️⚠️ **首帧读不到**（2026-10-07 真机截图证实：事件块全挤在左边 258px 处，
  //   而台面有 1000+ 宽）：`colMid` 此刻**还是空的**（`renderMid` 正在往里写，
  //   而 `canvasHtml` 是拼字符串的那一步）⇒ **`clientWidth` 恒为 0**。
  //   我上一版注释写"首帧也不会是 0"，**是错的**（`colMid` 有内容是上一轮 `render()` 留下的）。
  //   ⇒ **三级回退 ＋ 记住上一次**：
  //     ① `colMid.clientWidth`（第二帧起就有值 —— 上一轮渲染的内容还在）
  //     ② 台面 `.canvas` 的 `clientWidth`（同上）
  //     ③ **视口宽 × 0.55**（三栏布局里中栏大约这么多；首帧唯一能用的值）
  //   每读到一次非 0 就记进 `lastCanvasW`，窗口变窄/变宽后不必等两帧。
  const midEl = $('colMid');
  const panEl = document.querySelector('.canvas');
  let CW = 0;
  if (midEl && midEl.clientWidth) CW = midEl.clientWidth;
  else if (panEl && panEl.clientWidth) CW = panEl.clientWidth;
  else CW = Math.round((document.documentElement.clientWidth || 1280) * 0.55);
  if (CW > 0) lastCanvasW = CW;
  else CW = lastCanvasW || Math.round((document.documentElement.clientWidth || 1280) * 0.55);
  const CANVAS_W = Math.max(360, CW - 28);   // 28 = 台面自身左右内边距
  // ⚠️⚠️ 2026-10-08（用户裁定「序幕事件不得与左栏重合」）：左栏底缘**实测**后传给摆位 ——
  //    与 `CANVAS_W` 同一手法（上一帧的 DOM 还在 ⇒ 量它；首帧量不到 ⇒ 回退；记忆防抖）。
  //    ⚠️ `.mapcorner` 与 `.cvchip` 同住 `.canvas-pan`（都是 absolute）⇒ `offsetTop/Height`
  //      给的就是**摆位坐标系里**的底缘，天然同源，不需要再换算。
  //    ⚠️ 序幕/正文的首帧（上一帧是标题屏）量不到 ⇒ 用记忆值（`lastCornerBottom`），
  //      连记忆都没有 ⇒ `canvasSlots` 内部回退（padT+232）。序幕期间左栏内容恒定，
  //      一旦第二帧量到一次，整个序幕期都稳定准确。
  //    ⚠️⚠️ 选择器必须限定 `.canvas-pan`：`leftHtml` 画了**两份** —— `renderLeft` 一份
  //      进 `#colLeft`（旧壳，页面里隐藏）、`canvasHtml` 一份进 `.canvas-pan`（真台面）。
  //      裸 `querySelector('.mapcorner')` 命中 DOM 靠前的 **colLeft 那个**（隐藏 ⇒ 恒 0）
  //      ⇒ 实测从未生效过，一直在走回退值。（2026-10-08 实测发现。）
  const mcEl = document.querySelector('.canvas-pan .mapcorner');
  if (mcEl && mcEl.offsetHeight > 0) {
    lastCornerBottom = mcEl.offsetTop + mcEl.offsetHeight + 8;   // +8：呼吸留白
  }
  // ⚠️ 量不到（0）就传 `undefined` —— `canvasSlots` 按参数缺失走它自己的回退（padT+232）
  const CORNER_BOTTOM_MEAS = lastCornerBottom > 0 ? lastCornerBottom : undefined;
  // ⚠️⚠️ **2026-10-07 用户裁定：档 A 全部铺上地图**（不再独占正中、不再"点完一张才见下一张"）
  //   ⇒ **两批摆位**：第一遍给**档 A 大牌**（宽 340 的那一档），第二遍给散事 ——
  //     散事那遍带 `topOffset`＝大牌占掉的高度 ⇒ 两批上下错开，**绝不叠**。
  //   ⚠️ 大牌卡面尺寸与 CSS 同源：`.cvchip.big{padding:16px 20px; font:16px/1.45}`
  //     ⇒ `padY:32 / lineH:23 / markH:0`（大牌没有状态行）。
  const popsSlots = pops.length
    ? canvasSlots(pops.map(function (e) { return e.id; }), titleOf, CANVAS_W, 420,
        { chipW: 340, padY: 32, lineH: 23, markH: 0, cornerBottom: CORNER_BOTTOM_MEAS })
    : null;
  const POP_H = popsSlots ? (popsSlots.needH || 0) : 0;
  // ⚠️ **两步调用**：第一步只为拿 `slotH × rows` 算出画布该多高，
  //   第二步把这个高度**喂回**摆位算法 —— 它内部要把整批卡**居中**在可用区里
  //   （不知道可用区高度就居不了中，那正是"贴着上沿/下沿"的原因）。
  let slots = canvasSlots(items.map(function (e) { return e.id; }), titleOf, CANVAS_W, 420, { topOffset: POP_H, cornerBottom: CORNER_BOTTOM_MEAS });
  // ⚠️ 2026-10-05 改了两次，最终口径是「**保底高度 ＋ 由 CSS 吃满剩余**」：
  //    · 第一次（只按条数算死）：只有 1~2 条事时画布仍 300~438px，
  //      一条 60px 的卡孤零零飘在中间 ⇒ **大片死黑看着像加载失败**。
  //    · 第二次（布局重构后）：中栏不再被左栏拖着长，6 条事时画布只有 450px，
  //      下方**空到页脚** —— 换了个方向还是留白。
  //    ⇒ 现在的做法：JS 只给一个**保底** `min-height`，真正的高度交给 CSS 去吃满
  //      （见 `.canvas-card{flex:1}` ＋ `.canvas{height:100%}`）。
  //      条数少 ⇒ 被拉高填满中栏；条数多 ⇒ `min-height` 顶开、`#colMid` 出滚动条。
  //    ⚠️ 下限 190 是「一张卡约 62px ＋ 上下各留 65px」的呼吸位；再矮卡会贴边。
  // ⚠️⚠️ **高度改成按「实际行高 × 行数」算**（`slots.slotH` 是 `canvasSlots` 算出来的真值）
  //    ⇒ 画布高度与摆位**同源**了。旧那句"行数 × 150"已删：
  //    它是**重叠的第二个来源** —— 画布只有 150×行数 高，摆位却按行数均摊，两边对不上。
  // ⚠️⚠️ 2026-10-06：高度**完全由摆位结果反推**（`slotH × rows` ＋ 上下留白）
  //    ⇒ 画布与摆位**同一个数**，不可能再对不上（旧那个"行数 × 150"就是对不上才叠的）。
  // ⚠️⚠️ `slots.needH` 是**摆位算法算出来的"至少要这么高"**（含上下留白）。
  //   事件多到一行放不下时它会大于台面 ⇒ 这里直接拿它当高度，页面出滚动条，
  //   **而不是把所有卡挤进现有高度里叠着**（用户 08:54 的原话：位置要限制在长方格内）。
  const H = Math.max(240, slots.needH || ((slots.slotH || 0) * slots.rows + 28), POP_H);
  // ⚠️ **第二步**：拿真高度重算一次（这一次才有"居中在可用区"与"让开左上角那两块"）
  //   ⚠️⚠️ 2026-10-08 补传 `cornerBottom`：这一步在 `items.length > 1` 时**覆盖**第一步的
  //     slots —— 漏传会让"让开左栏"在散事 ≥2 条时整个丢掉（序幕恰恰就是这种形态）。
  if (items.length > 1) slots = canvasSlots(items.map(function (e) { return e.id; }), titleOf, CANVAS_W, H, { topOffset: POP_H, cornerBottom: CORNER_BOTTOM_MEAS });
  // ⚠️⚠️ 2026-10-06 清单第 4C 条（用户裁定第 15 条：**不需要**那个队列弹窗）
  //   ⇒ **不做弹窗**（理由与总纲同源：把最重要的并行度信息藏进"点开才看见"就是反的）
  //   ⇒ 改成：① 每个待揭晓的事件块**头顶画自己的"还要几格"** ＋ ② 地图区顶部一个**条数徽标**。
  //   ⚠️ **纯前端派生**（`reveal_at.used − clock.usedToday`，数据已在 view 上）⇒ 零规则层改动。
  const live = arr(v.waiting);
  const 剩格 = (e) => {
    if (!e.reveal_at) return 0;
    if (e.reveal_at.day > v.day) return 0;          // 跨天 ⇒ 今天点几下都点不掉
    return Math.max(0, e.reveal_at.used - v.usedToday);
  };
  // ⚠️⚠️ 2026-10-07 用户第 15 / 24 条（补核）：**「正在处理」就是点了 ✔ 的事件**。
  //   用户原话（第 24 条）：「『正在处理的事件』指的就是**点了 ✔ 的事件**，
  //   因为我们有些事件的结算结果不是即时的，要靠玩家主动拨时针才能结算」；
  //   （第 15 条）：不要那个按条数报「排了几件」的弹窗。
  //   ⇒ 弹窗早已不做（这条 2026-10-06 已落），但**徽标上的措辞还停在旧口径**
  //     （旧词是系统视角的黑话，玩家视角就是"正在处理"）。
  //   ⇒ 统一用**玩家那一侧的词**：徽标「正在处理」，事件块上的小字也同一口径。
  //   ⚠️ 这段注释**不逐字复述**被断言禁止的那个串（写了就自己撞自己，前车之鉴）。
  // ⚠️⚠️ 2026-10-07 清单第 4 条（**再改**）：地图右上角那枚「N 正在处理」徽标**整块撤掉**
  //   （用户原话：「把这里莫名其妙的『正在处理』图像去掉」）。状态改由**每个事件块自己**
  //   在头上写（见下面 `statusMark`）—— 一件事的状态长在这件事身上，不集中在角落报数。
  //   ⇒ `queueBadge` / `.cvqueue` / `.cvq-*` 一并退役（CSS 侧同轮删）。

  // ⚠️⚠️⚠️ 2026-10-07 用户 08:54 再指：**第 5 条要求的三个标记一个都没画**。
  //   原文：「deadline直接显示在地图区，**每个事件的头上做一个小钟+感叹号+时间数字，表示deadline**，
  //   不需要在事件详情里显示，**若事件正在处理，则改为小钟+省略号+剩余的处理时间**；
  //   **地图区的每个事件左侧呈现处理这件事件需要的属性，用图标表示不需要文字**」。
  // ⇒ 三块都在这里补上（数据 `deadline` / `hint_attr` / `cost` / `reveal_at` **本来就在 view 上**，
  //    此前一处都没渲染）。
  /** ① 头上的**一行状态小字**（清单第 4 条 · 用户原话措辞）：
   *    · 处理中 ⇒「处理中：还需 y 点行动力」（y ＝ 今天还要拨几格才揭晓）；
   *    · 待处理有期限 ⇒「未处理：还有 x 天过期」；今天到期 ⇒「未处理：今天过期」（染红）；
   *    · 待处理没期限 ⇒ 只写「未处理」（不硬编一个 0 出来）。
   *    ⚠️ 它**取代**了旧的小钟标记（⏱！d天）：图标要学一次才懂，文字一眼就读到。 */
  function statusMark(e, live) {
    if (live) {
      // ⚠️⚠️ 2026-10-08（乐观挪池）：点 ✔ 后、回包前，事件被前端搬进 waiting 但
      //    `reveal_at` 还没写（服务端排布那一刻才有）⇒ 不报「还需 0 点」（那会让
      //    玩家去拨钟扑空），报真话：还在裁定。回包一落地，自然换成真正的揭晓话术。
      if (!e.reveal_at) {
        return '<span class="cvstat on" title="已经派人去办了 —— 后台正在裁定，结果稍候自动揭晓">处理中：正在裁定…</span>';
      }
      // ⚠️⚠️ 2026-10-07 用户第 3 条：跨天揭晓的事件此前**也报「还需 0 点行动力」**
      //   （`剩格` 对 `reveal_at.day > v.day` 一律返回 0）—— 玩家读到"还需 0 点"
      //   却怎么点都不揭晓，自然以为"已经结算了怎么还在画布上"。
      //   ⇒ 跨天的改报真话：第 x 天揭晓。
      if (e.reveal_at && e.reveal_at.day > v.day) {
        return '<span class="cvstat on" title="已经派人去办了 —— 结果在第 ' + e.reveal_at.day + ' 天揭晓">处理中：第 ' + e.reveal_at.day + ' 天揭晓</span>';
      }
      const n = 剩格(e);
      return '<span class="cvstat on" title="已经派人去办了 —— 再拨 ' + n + ' 点行动力就揭晓">处理中：还需 ' + n + ' 点行动力</span>';
    }
    if (e.deadline === null || e.deadline === undefined) {
      return '<span class="cvstat">未处理</span>';
    }
    const d = Math.max(0, Number(e.deadline) - v.day);
    return '<span class="cvstat' + (d === 0 ? ' hot' : '') + '" title="' +
      (d === 0 ? '今天就是最后期限' : '还有 ' + d + ' 天到期') +
      '">未处理：' + (d === 0 ? '今天过期' : '还有 ' + d + ' 天过期') + '</span>';
  }
  /** ② 左侧的属性图标（**只要图标，不要文字** —— 用户原话） */
  function attrMarks(e) {
    const as = arr(e.hint_attr);
    if (!as.length) return '';
    return '<span class="cvmeta">' + as.map(function (k) {
      return '<span class="cvsig" title="要「' + esc(k) + '">' + attrSigil(k, 12) + '</span>';
    }).join('') + '</span>';
  }
  const chips = slots.list.map(function (sl, i) {
    // ⚠️ 功能事件（医馆/神殿）：自己的一支 —— 无状态行、无属性图标、无过期，
    //   一句描述 ＋ 那圈呼吸（它也是"摆在你面前、等你处理"的事）。
    if (sl.id.indexOf('fix:') === 0) {
      const pl = sl.id.slice(4);
      const sp = FIX_SPECS[pl];
      return '<div class="cvchip fixv pulse" style="left:' + sl.x.toFixed(1) + 'px;top:' +
        (sl.rowMid + sl.jitterY).toFixed(1) + 'px;--i:' + i + '"' +
        ' data-act="fixOpen" data-place="' + pl + '"' +
        ' title="点开安排谁去（' + sp.effect + '）">' +
        '<span class="cvstat">功能 · 不限时</span>' +
        '<span class="cvt">' + esc(sp.title) + '</span>' +
        '<span class="cvd">' + esc(sp.effect) + '</span>' +
      '</div>';
    }
    const e = byIdOf.get(sl.id);
    const live = e.status === '揭晓待办';
    // ⚠️ 第 8 条：**「必须先处理」的那些事件也一律显示到地图上**（此前它们只在事件台里出现）。
    //   体现为「**正在处理**」＋ 点开后那个人**已经被吸进去且不可操作**（`requiredPerson` 那个红槽）。
    const must = !!e.requiredPerson;
    // ⚠️ 2026-10-07 用户裁定：**未处理的都带那圈呼吸**（大牌的动态推广到全体），
    //   已交出去的（`.live`）不带 ＋ 整块灰化 —— 动与静一眼分出"轮没轮到你"。
    return '<div class="cvchip t' + esc(e.tier) + (live ? ' live' : ' pulse') + (must ? ' must' : '') + '"' +
      // ⚠️ `sl.rowMid` 是**像素**（那一行的中心），除以画布真高 `H` 换成百分比 ——
      //    `.cvchip` 用 `transform:translate(-50%,-50%)` 定位 ⇒ 那个数是**卡心**的 y。
      // ⚠️ **x / y 都是像素**（2026-10-07）—— 摆位算法已经改成"在长方格内按像素排"，
      //    再换算成百分比就把"限制在长方格内"这件事抵消掉了（百分比是相对整块台面的）。
      ' style="left:' + sl.x.toFixed(1) + 'px;top:' + (sl.rowMid + sl.jitterY).toFixed(1) + 'px;--i:' + i + '"' +
      ' data-act="detail" data-kind="event" data-id="' + esc(e.id) + '"' +
      ' title="点开看它是什么、该怎么办">' +
      // ⚠️ 清单第 4 条：状态行**在块头**（"在每个事件头上显示"），属性图标跟在其后；
      //    旧的那条块底小字（「正在处理 · 还剩 N 格」）与状态行重复 ⇒ 撤（口径只剩一处）。
      statusMark(e, live) + attrMarks(e) +
      '<span class="cvt">' + esc(e.title) + '</span>' +
      (must ? '<span class="cvw must">非 ' + esc(e.requiredPerson.name) + ' 不可</span>' : '') +
    '</div>';
  }).join('');
  // ── 档 A 的大牌（2026-10-05 铺上画布；2026-10-07 用户裁定再改）──────
  // ⚠️ **全部铺开、参与摆位**（不再写死 50%/50% 叠成一摞 —— 多件档 A 同铺时
  //    玩家看得见每一件，点完一张其余还在原地等着）。
  // ⚠️ 位置由 `popsSlots`（`chipW:340` 档）算好，**像素内联**（与散事同一套坐标系）。
  // ⚠️ 「就这一件」那句卡面小字撤了（2026-10-07 用户裁定）—— 多件同铺时那句话说不通。
  // ⚠️ `data-act="popupOpen"`（不是 `detail`）：档 A 走**它自己的**那层浮层，
  //    点开之后是**事件详情 ＋ 选项**（点一下即结算），不是阅览。
  const popsById = new Map();
  pops.forEach(function (e) { popsById.set(e.id, e); });
  const bigChips = (popsSlots ? popsSlots.list : []).map(function (sl, i) {
    const e = popsById.get(sl.id);
    if (!e) return '';
    return '<div class="cvchip big tA" style="left:' + sl.x.toFixed(1) + 'px;top:' + sl.rowMid.toFixed(1) + 'px;--i:' + i + '"' +
      ' data-act="popupOpen" data-ev="' + esc(e.id) + '"' +
      ' title="点开看它是什么、要怎么定">' +
      '<span class="cvt">' + esc(e.title) + '</span>' +
    '</div>';
  }).join('');
  // 画布那张卡要**自己撑满**中栏（`flex:1`）⇒ 里面的画布才能跟着长。
  // ⚠️ `.canvas-pan` 是**被平移/缩放的那一层**（台面），点阵留在外层 `.canvas`（窗）——
  //    两者合成一个元素时 `overflow:hidden` 的裁剪框与 transform 原点永远对不齐。
  // ⚠️ 标题在有档 A 时换话术：那一句"没有别人能替你走这一步"是给它的，不是给散事说的。
  // ⚠️⚠️ 2026-10-06 用户裁定（清单第 6 条）：「『摆在你面前的事』改成
  //   **『这些是摆在你面前的事，你也可以通过左下角的「我想做点什么」自己创建事件』**」
  //   ⚠️ **计数去掉了**（原句里没有）—— 一句话里夹个「（3）」反而把它读成清单标题，
  //     而它现在要读的是**一句邀请**（地图上也可以自己加事）。
  //   ⚠️ 「就这一件」那一支**保留原样** —— 那是档 A 专用话术（`pops` 非空时），
  //     与用户要改的那句不是同一个语境。
  // ⚠️⚠️ 2026-10-07（用户第 23 条 · 定位补做）：那句邀请**搬出 `.canvas`** ——
  //   它的基准原先是台面，而台面里还浮着「最终任务清单」「尚未入队」两块
  //   ⇒ 视觉上不是"地图最上面居中"。
  //   ⇒ 现在由 **`renderMid` 在中栏最顶画一次**（同一个口径只画一处）。
  //   ⚠️⚠️ 2026-10-07 用户裁定：「就这一件（N）」这句台面标头**整句删掉** ——
  //     档 A 已经全部铺在地图上、每张牌自己会说话，台面不再需要一句总标。
  // ⚠️ 队列徽标已撤（清单第 4 条）—— 台面头部什么都不剩。
  // ⚠️⚠️ 2026-10-07 用户第 6 / 23 条（补核）：**地图区只剩那一句提示 ＋ 事件块本身**。
  //   用户原话（第 6 条）：「都说了地图区自己不需要有方框」＋（第 23 条）「台面的边也不要了，
  //   但是『这些是摆在…』这句话应该显示在地图最上面居中，而且是淡黄色斜体小字」。
  //   ⇒ 原先挂在台面**下方**的两行常驻说明整段删掉：
  //     · 「点一下才会看到它是怎么回事、该怎么办。　拖空白处平移 · 滚轮缩放。」
  //     · 「点一件散着的事 —— 它会展开成"怎么办"（派谁去 / 带什么 / 垫钱）。」
  //   ＋ 两条 `hintHtml` 首次引导（它们说的是同一件事，重复一遍）。
  //   ⚠️ `hintHtml` 的**定义留着**（`HINT_KEY` / `hintHtml`）—— 它是通用机制，
  //      只是地图区不再有调用者；删定义要连带核 localStorage 键，不在本轮范围。
  //   ⚠️ 那句邀请**只有一处**：`renderMid` 里的 `.cvtop`（中栏第一个元素）。
  return '' +
    // ⚠️ 2026-06：`min-height` 加了**下限 420px**。
    //   改前是 `Math.max(H, …)`，而 `H` 按**条数**算（2 条 ⇒ 240px）
    //   ⇒ 事件少的时候画布只有 240 高，下方空出大半屏（实测 130px ＋ 大片黑）。
    //   ⚠️ 但**不能**改成 `height:100%`（那会让"事件多"时画布被拉得过高、
    //   每块之间空得离谱）⇒ 用**下限**而不是拉伸：条数少时由下限撑住，
    //   条数多时仍由 `H` 顶开。
    '<div class="canvas" style="min-height:' + Math.max(H, pops.length ? 260 : 0, 420) + '" data-canvas>' +
      // ⚠️ `leftHtml(v)` ＝「这一局·最终任务」＋「尚未入队」两块，
      //   与 `bigChips` / `chips`（事件块）**同在 `.canvas-pan` 里** ⇒ 同一坐标系。
      //   ⚠️ 台面标头（「就这一件（N）」）已删 —— 那句邀请归 `renderMid` 的 `.cvtop`。
      '<div class="canvas-pan">' + leftHtml(v) + bigChips + chips + '</div>' +
      // ⚠️⚠️ 2026-10-07 用户裁定：地图区**底部居中**一条常驻小字 —— 行动点不够用时的出路提示。
      //   它说的是"招募人手 → 多线并行"这条玩法，不是某张卡的状态 ⇒ 挂在**台面**上
      //   （不进 `.canvas-pan`：那层会被平移/缩放，常驻提示要钉在窗上不动）。
      '<div class="cvrecruit">当觉得事情很多、行动点不够用时，不妨试试招募人手，然后多派几个人去并行处理事件</div>' +
    '</div>';
}

/**
 * 一条事件的详情 —— **点开画布上那一条**时才出现。
 *
 * ⚠️ **待办**那一支直接复用 `cardHtml`：它本来就是「动手那一套」（派人 / 带物 / 垫钱），
 *    一字不重写 —— 否则画布点开与拖拽落点会各长一份判据（同一个口径两处实现的老坑）。
 * ⚠️ **处理中**那一支**不给派遣按钮**：那件事已经在办了，再给一套「派人去」只会让人
 *    以为可以再排一次。它给的是「谁在办 ＋ 什么时候揭晓 ＋ 到目前为止的正文」。
 */
function sheetEvent(v, id){
  const e = arr(v.todo).concat(arr(v.waiting)).find(function (x) { return x.id === id; });
  if (!e) return sheetHead('这件事不在了', '它可能已经了结 —— 结果在给你看过之后就不再留着。');
  const when = '第 ' + e.created_day + ' 天摆到面前 · 期限 ' + e.deadline + ' 天' +
    (e.expiresOn ? '（第 ' + e.expiresOn + ' 天前）' : '');
  // ⚠️ 2026-10-05：**左纹章 ＋ 右正文**（学《苏丹》那个事件面板的对位结构）。
  //    左块只回答「这是个什么档的事、要什么属性」，右块只回答「发生了什么、怎么办」。
  //    ⚠️ 属性徽**明写出来**（"要 智慧 · 魅力"）而不是只给符号：符号给一眼认得，
  //       文字给"我记住的那个词" —— 两者一起才既快又不漏。
  const attrLine = arr(e.hint_attr).length
    ? '<div class="attrline">要 ' + arr(e.hint_attr).map(attrChip).join('') + '</div>'
    : '<div class="attrline muted">这件事没有指定属性 —— 谁去都使得上劲</div>';
  const open = function (body) {
    return '<div class="shtop">' + eventSigil(e) +
      '<div class="shbody"><h2 class="shname">' + esc(e.title) + '</h2>' +
        '<div class="who">' + esc(e.stage) + '　' + when + '</div>' + attrLine + body + '</div></div>';
  };
  if (e.status === '待处理') {
    return open('<div class="sec"><div class="h">怎么办</div>' + cardHtml(e) + '</div>');
  }
  // ⚠️⚠️ 清单第 1 条（**持久化**）：**处理中**的点开 ＝ 回看当时摆下去的样子
  //   （只读处理台：槽里还是他派的人、叮嘱还写着）——
  //   不再是"谁在办"那行系统视角的账，搞得像从没处理过一样（用户原话）。
  //   揭晓时刻与到目前为止的正文**保留** —— 那两样才是回看时真正想知道的。
  //   （「它的来历」撤了：正文已在处理台右栏那一格里，同一段话不读两遍。）
  const texts = arr(S && S.feed).filter(function (f) { return f.eventId === id && f.text; });
  return open(
    '<div class="sec"><div class="h">怎么办 · 已交出去</div>' + cardHtml(e, true) + '</div>' +
    (e.reveal_at ? '<div class="sec"><div class="h">什么时候揭晓</div><div class="prose">第 ' +
      e.reveal_at.day + ' 天第 ' + e.reveal_at.used + ' 点（拨时针到点就揭晓）</div></div>' : '') +
    (texts.length ? '<div class="sec"><div class="h">到目前为止</div>' +
      texts.map(function (f) { return '<div class="prose">' + escProse(f.text) + '</div>'; }).join('') +
      '</div>' : ''));
}

/**
 * 上帝视角（默认收起）—— **开发读数一律住在这里**，玩家面上不出现。
 * 三栏：读数 ｜ 闸门（分两栏）｜ 系统日志。
 *
 * ⚠️ 闸门分栏的依据来自 **`rules/gates.ts·GATE_LANE`**（跟着 `v.gates[i].lane` 走）——
 *    UI 不许自己按 `code` 再编一份分类（同一个口径两处实现的老坑）。
 * ⚠️ 末尾那条「当前状态」快照行**不列进任何一栏**：它的 `code` 与闸门 ① 同名，
 *    混进去会让面板看起来像把闸门 ① 列了两遍（views 里叫 `statusLine`）。
 */
function gateLine(g){
  return '<div class="feed" style="border-left-color:' + (g.pass ? 'var(--ok)' : 'var(--danger)') + '">' +
    '<div class="fh">' + (g.pass ? '✓' : '✗') + ' ' + esc(g.code) + '</div>' +
    '<div class="sub" style="font-size:12px">' + esc(g.reason) + '</div></div>';
}

function renderGod(v){
  const el = $('godpanel');
  if(!el) return;
  if(!god){ el.className = 'hidden'; el.innerHTML = ''; return; }
  const lanes = { 动作拦截: [], 控件置灰: [] };
  for (const g of arr(v.gates)){
    const k = g.lane === '动作拦截' ? '动作拦截' : '控件置灰';
    lanes[k].push(g);
  }
  const lane = (title, note, list) =>
    '<div><h4>' + title + '（' + list.length + '）</h4>' +
    '<div class="sub" style="font-size:11.5px;color:var(--muted);margin-bottom:5px">' + note + '</div>' +
    (list.map(gateLine).join('') || '<div class="empty">（无）</div>') + '</div>';
  const sl = v.statusLine;
  el.className = '';
  el.innerHTML =
    '<div class="card"><h3>读数</h3>' +
      '<div class="sub">欲念 <b>' + v.desire.value + '</b> · 区间 <b>' + esc(v.desire.band) + '</b></div>' +
      '<div class="sub">危险区 <b>' + esc(v.zone) + '</b></div>' +
      '<div class="sub">藏 ' + v.hiddenCount + ' 条 · 种子 ' + v.seed + ' · 步数 ' + v.steps + '</div>' +
      (sl ? '<div class="feed" style="border-left-color:' + (sl.pass ? 'var(--ok)' : 'var(--danger)') + '"><div class="fh">当前状态（不是闸门）</div>' +
        '<div class="sub" style="font-size:12px">' + esc(sl.reason) + '</div></div>' : '') +
      (arr(v.seeds).length ? '<div class="sub" style="font-size:12px;margin-top:6px">种子池：' +
        arr(v.seeds).map((s) => (s.source === '硬种子' ? '[硬] ' : '') + s.code + ' ' + esc(s.title)).join('；') + '</div>' : '') +
    '</div>' +
    '<div class="card"><h3>闸门 · 分两栏</h3><div class="lanes">' +
      lane('动作拦截', '与具体哪条事件无关 —— 决定"现在还能不能点"。', lanes.动作拦截) +
      lane('控件置灰', '对着一条具体待办才算得出 —— 决定"哪个按钮是灰的"。', lanes.控件置灰) +
    '</div></div>' +
    '<div class="card"><h3>系统日志</h3><div id="syslog">' + esc(arr(S.log).slice(-120).reverse().join('\n')) + '</div></div>';
}

function renderFooter(v){
  const left = v.remaining;
  // ⚠️⚠️ 2026-10-07 用户裁定（机制理解负担）：拨点四连键**统一成一颗**——
  //   「进入正午/进入下午/进入傍晚/进入深夜」。按一下走一个时段（= 1 点），
  //   按钮文字永远说**下一时段**叫什么 —— 玩家不必再翻译"拨 2 点是几点"。
  //   ⚠️ 可拨区间判据照旧读 `v.dial`（`rules/clock.ts·dialRange`，清单第 9.1 条）：
  //     有人在外面办事时，`dialMax` 被"最小的那笔"压过 —— 1 点总是安全的
  //     （拨 1 点最多刚好把最早到点的那件事推到揭晓，不会拨过头）。
  const dialMax = (v.dial && Number.isFinite(v.dial.max)) ? v.dial.max : left;
  const NEXT = ['正午', '下午', '傍晚', '深夜'];
  const used = v.usedToday || 0;
  const nextPart = NEXT[Math.min(used, 3)];
  const canDial = left > 0 && dialMax >= 1;
  const dialBtn = left <= 0
    ? '<span class="chip">今天的时间走完了 —— 进下一天吧</span>'
    // ⚠️ 2026-10-08 用户裁定：拨钟按钮**变大、颜色变深**（`primary` 深底 ＋ `big` 大字）——
    //    它是玩家推进时间的主动作，原先混在页脚里太不显眼。
    : '<button class="primary big" data-act="dial" data-n="1"' + (canDial ? '' : ' disabled') +
      ' title="' + (canDial
        ? ('花 1 点时间，进入' + nextPart +
           (nextPart === '深夜' ? ' —— 还剩 1 点时间的事会在这时揭晓' : '；在外面办事的人，到点就会带结果回来'))
        : '拨不了 —— 再拨就超过正在处理那件事的揭晓点了') +
      '">进入' + nextPart + '</button>';
  // ⚠️⚠️ 2026-10-08 用户裁定：这行提示**常驻** —— 不再"有处理中的事才显示"，
  //    游戏正式开始后玩家就该一直看得见"拨时针 → 到点揭晓"这条规则（没人在办也显示 0 件）。
  const waitingN = arr(v.waiting).length;
  const waitingHint = '<span class="fhint">' + waitingN + ' 件事在外面办着 —— 拨进下一时段，到点揭晓结果</span>';
  // ⚠️ 2026-10-05：按钮的**内容与顺序一字未动**，只给"出口"那三颗套了一个 `.exits` 容器
  //    （CSS 用它画一道竖线，把"离开这一局"和"推进这一天"在视觉上分开）。
  //    ⚠️ 那条 `<span class="sep">|</span>` 的竖线分隔符因此退休 —— 竖线已经是容器边界了，
  //    留着就成了双线。
  $('footer').innerHTML =
    // 槽位号要留着：那是玩家自己挑的位置，他有权知道这一局存在哪儿。
    // （种子号与步数仍住在上帝视角里 —— 它们是开发读数，不是世界的一部分）
    (S.slot === null || S.slot === undefined ? '' : '<span class="chip">存档 ' + (S.slot + 1) + '</span>') +
    // ⚠️⚠️ 2026-10-07 用户裁定（第三批）：「我想做点什么」**搬进手牌区左端的方格**
    //   （`renderHand` 的 `.hand-compose`）—— 页脚这颗小按钮太不显眼，
    //   用户原话「手牌区左边应该是一个明显的『我想做点什么』的方格」。
    dialBtn +
    waitingHint +
    // ⚠️ 2026-10-08 用户裁定：拨钟按钮升级为主视觉后，「进下一天」**相应变小**
    //    （`primary` 深底保留、去掉 `big` 大字）—— 两颗并排时大的是"推进时间"，
    //    翻日是小一号但仍是深色的"这一天的决定"。
    '<button class="primary" data-act="nextday"' + (v.isFinalDay ? ' disabled' : '') + '>进下一天</button>' +
    '<span class="sp"></span>' +
    // ⚠️ 两个**出口**，一左一右分开放（原先那颗「重开（同种子）」已撤 —— 它是开发口径，
    //    而且现在每个动作都自动存档，"重开"会把玩家自己那一档直接盖掉）。
    '<span class="exits">' +
    '<button data-act="saveQuit">保存并退出</button>' +
    // ⚠️⚠️ 2026-10-07（用户裁定）：「直接结算」**任何时候都可以点** —— 原来那句
    //   `v.isOver ? ' disabled'` 撤掉。它点的瞬间永远通向同一个出口：
    //   确认 → 强制结算动画（结局全屏）→「回到开局」。局已终了时再点，
    //   结算动画已经播过，点击直接送回标题屏（见 click 处理器里 `giveup` 分支）。
    '<button class="q-danger" data-act="giveup">直接结算</button>' +
    '<button data-act="god">' + (god ? '收起上帝视角' : '上帝视角') + '</button>' +
    // 昼夜切换 —— 它是**偏好**（跨会话记住），不是这一局的动作 ⇒ 排在出口组最末。
    // ⚠️ 顺带也是给玩家的一个交代：这个界面长什么样，是可以自己定的。
    themeBtnHtml() +
    '</span>';
}

/**
 * 清掉**局内**的临时选择（勾了谁 / 三格放了什么 / 弹窗结果）。
 * ⚠️ 读档、开新局、回标题屏之后必须清 —— 它们只是页面上的状态，账本里没有。
 */
