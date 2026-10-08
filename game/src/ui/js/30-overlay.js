// ── 详情浮层（B 轮）──────────────────────────────────────────────
// 「总览 → 点开细化」：卡面只回答「这是什么」，这里回答「具体是什么」。
// ⚠️ **没有新增任何字段** —— 下面用到的 basic / identity / attrs / status / recognized /
//    items 全都在 `v.people[i]`（`session.ts·personOf`）里，此前只是**没地方放**。
// ⚠️ 不展示 `openness`（规则层读数）· 不展示任何欲念数值。
function sheetHead(title, who){
  return '<h2>' + esc(title) + '</h2>' + (who ? '<div class="who">' + esc(who) + '</div>' : '');
}

/**
 * 「**你的欲望**」—— 2026-10-06 清单第 4B 条**整块重做**（用户裁定第 22 条）。
 *
 * ⚠️⚠️ **与常规事件同构是硬约束**（用户原话：「**与常规事件同构**」）⇒
 *   骨架**复用第 5 条那套 `.evdesk`**（左卡槽 ＋ 右文字 ＋ 下框按钮 ＋ 外面 deadline），
 *   **不是另做一套** —— 两套骨架必然漂，而这一屏与事件台的信息密度是一样的。
 *
 * 【与旧版的三处差别】
 *   ① 右 1/3 **全平铺、零折叠**（第 10 条：「本来只是名字＋卡槽而已，根本不需要折叠」）
 *      —— 旧的 `plRow` 是三行只读清单（点一下才看），现在欲望宣言/宣言/目的/手段
 *      **四段直接摊开**。
 *   ② 左 1/3 改成**四行卡槽**：伟大的成果（3）／正当的手段（3）／他者的共鸣（3）／
 *      **如一的初衷（1 ＋ 实时欲念值）**（用户原话逐字）。
 *      ⚠️ 第四行**不放凭证** —— 它只是欲念值的实时读数（那一维由 `rules/ending.ts`
 *      的窗口判定，玩家在界面上做不了什么也不该假装能做）。
 *   ③ 下框「确定」**只能第 28 天结束后点**（用户原话：「下面的『确定』只能在游戏结束
 *      （第 28 天结束）后点击」）—— 之前一律灰，并写清还差几天。
 *
 * ⚠️ **卡位放的是凭证，不是实体**（第 22 条）：`data-drop="voucher"` ＋ `data-vdim`。
 *    一个卡位只能收**与那一行同维度**的凭证（`canDropOn` 里判），跨行拖不进去 ——
 *    与"物品只能拖到人身上"同一条纪律。
 */
/**
 * **凭证卡的拖拽开关**（第 4B.4 条）—— 只有「你的欲望」那一屏开着时才给 `data-kind`。
 *
 * ⚠️ **这是"只在那一屏可用"的唯一实现**：其余所有屏都是"没有 `data-kind` ⇒ 拖不动"。
 *   写成 `on = on || kind==='quest'` 而**不是** `if (!on && ...)` ——
 *   否则这一屏关掉之后属性还留着，玩家在事件台里也能把凭证拖走。
 *
 * ⚠️ **已经放进槽里的那张不给**（`.placed`）—— 同一张凭证不许占两处。
 * ⚠️ 找不到就**什么都不做**：手牌区可能这一轮一张凭证都没有（新账本）。
 */
function enableVoucherDrag(on){
  const cards = document.querySelectorAll('.hcard.voucher');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (c.classList.contains('placed')) { c.removeAttribute('data-kind'); continue; }
    if (on) c.setAttribute('data-kind', 'voucher');
    else c.removeAttribute('data-kind');
  }
}

/** 把 `vPicks.slots` 收成一份 `{ 成果, 手段, 共鸣 }` 的**实体 id**（点「确定」时提交）。 */
function vPlacementsOf(v){
  const st = vPick();
  const out = {};
  for (const dim in st) {
    const first = st[dim].map((vid) => vid).find((vid) => !!vid) || '';
    if (first) {
      // ⚠️ `v:{dim}:{绑定id}` ⇒ 去掉前缀拿到真正的实体 id。
      //    服务端 `Placements` 要的是实体 id（物品/事件/人物），不是卡牌 id。
      const tail = first.split(':').slice(2).join(':');
      out[dim === 'the_great_achievement' ? '成果'
        : dim === 'the_proper_way' ? '手段'
        : '共鸣'] = tail || null;
    }
  }
  return { 成果: out['成果'] || null, 手段: out['手段'] || null, 共鸣: out['共鸣'] || null };
}

function sheetQuest(v){
  // ⚠️ `poolView` / `候选清单` 2026-10-07 一并撤掉了（用户："这里的小字都可以删掉"）
  //   ⇒ `view.placementPools` 现在**界面上没有消费者**了（它读的是
  //   `turn/simulate.ts·placementPools`，规则层那份候选池仍是判定用的，只是不再画出来）。
  //   **留着 `poolView` 会变成死代码**，但删它要连带核 `poolView` 本身还有谁在用 —— 先不删，
  //   等确认真的没有第二处消费者再删（这一处删除是本轮的独立小尾巴，不夹在这里）。
  const 卡 = vSlots(v);
  const total = v.totalDays || 28;
  const day = v.day;
  const left = Math.max(0, total - day);
  // ⚠️ 判据：`isFinalDay` 在 view 上已有（`ui/session.ts` 从规则层那个 `isFinalDay` 直接透的）⇒
  //   **不重算**"day === total"，那会与规则层的 `isFinalDay` 有机会漂。
  const canConfirm = !!v.isFinalDay;

  // ⚠️⚠️ 2026-10-07 用户原话：「直接在对应的框旁边用小字告诉玩家，这里需要放置XX类凭证」
  //   ⇒ 每一行标签的下方就是那句话（**淡黄斜体小字**，样式同第 23 条那句地图提示）。
  //   **不再列候选清单**（那是被删掉的那段小字），也不写"可放 N 张"这种计数 ——
  //   槽位是几个，玩家自己数得到；计数只会占掉一行本该给提示的位置。
  const 行 = (dim, label, n, 要什么) =>
    '<div class="vrow"><span class="vlbl"><b>' + esc(label) + '</b>' +
      '<span class="vhint">这里需要放置' + esc(要什么) + '</span></span>' +
    '<div class="vslots">' + 卡.slots.filter((x) => x.dim === dim).map(vslotHtml).join('') +
    '</div></div>';

  return sheetHead('你的欲望', '第 ' + total + ' 天结束之后，把这一局放进去。') +
    // ── 外面：deadline（第 28 天）＋ 进度条 ──
    '<div class="vdesk-top">' +
      '<span class="dl">' + (canConfirm
        ? '今天就是<b>最后一天</b>—— 你可以放好，然后确定。'
        : '距离<b>最后一天</b>还有 <b>' + left + '</b> 天（现在是第 ' + day + ' 天）') + '</span>' +
      '<span class="daybar" title="已过 ' + day + ' / ' + total + ' 天"><i style="width:' +
        Math.min(100, Math.round(day / total * 100)) + '%"></i></span>' +
    '</div>' +
    '<div class="evdesk">' +
      // ── 左 1/3：四行卡槽（3/3/3/1）──
      '<div class="evdesk-l">' +
        行('the_great_achievement', '伟大的成果', 3, '成果类凭证') +
        行('the_proper_way', '正当的手段', 3, '事件类凭证') +
        行('the_resonance_of_the_other', '他者的共鸣', 3, '人物情感类凭证') +
        // 第四行：**不收凭证**，只实时显示欲念值
        '<div class="vrow"><span class="vlbl"><b>如一的初衷</b>' +
          '<span class="vhint">由它自己判定，这里不放凭证</span></span>' +
          '<div class="vslots"><div class="vslot init" title="欲念值只由规则层判（70~80 才算得偿所愿）">' +
            '<span class="vtitle">欲念</span><span class="vnum">' + esc(v.desire.value) + '</span>' +
          '</div></div></div>' +
        // ⚠️⚠️ 2026-10-07：**原先这里有一段候选池清单（按三个维度各列一串名字）整块删除**
        //   （用户 2026-07-07 原话：「这里的小字都可以删掉」）。
        //   理由与第 10 条同源：这一屏该有的只是**名字 ＋ 卡位**，
        //   候选清单是"告诉玩家他还没收集够"的一堆负信息，而**手牌区里那排凭证卡
        //   本身就是清单** —— 同样的内容摆两处，长的那处还折成三行挤在卡位下面。
        //   ⇒ 改成：每一行的卡位旁边用一行**淡黄色斜体小字**写"这里需要放置 XX 类凭证"，
        //     那才是玩家真正需要的引导（第 23 条定的样式）。
      '</div>' +
      // ── 右 1/3：欲望四段**全平铺、零折叠** ──
      '<div class="evdesk-r">' +
        '<div class="evd-title"><span class="nm">欲望宣言</span></div>' +
        '<div class="prose" style="font-size:15px;margin-top:4px">' +
          (v.desire.manifesto ? '「' + esc(v.desire.manifesto) + '」' : '（还没定）') + '</div>' +
        '<div class="evd-title" style="margin-top:12px"><span class="nm">你的目的</span></div>' +
        '<div class="prose" style="margin-top:4px">' +
          (v.desire.proposition ? '「' + esc(v.desire.proposition) + '」' : '还没有目的。') + '</div>' +
        '<div class="evd-title" style="margin-top:12px"><span class="nm">你的手段</span></div>' +
        '<div class="prose" style="margin-top:4px">' +
          (v.desire.means ? esc(v.desire.means) : '（还没写）') + '</div>' +
        '<div class="evd-title" style="margin-top:12px"><span class="nm">欲念</span></div>' +
        '<div class="prose" style="margin-top:4px"><b>' + esc(v.desire.value) +
          '</b>　<span class="sub" style="color:var(--muted)">最后一天收在 70~80 之间，才算得偿所愿。</span></div>' +
        // ── 下框：「确定」—— 只能最后一天之后 ──
        '<div class="evd-ops">' +
          '<button data-act="closeDetail">×</button>' +
          '<button class="primary" data-act="finish" ' + (canConfirm ? '' : ' disabled') + '>' +
            (canConfirm ? '确定' : '确定（第 ' + total + ' 天才能点）') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

/**
 * 四行卡槽的**局部状态**（`data-sloti` 0/1/2 ＋ 第四行没有槽）——
 * 与事件台那个 `picks` **同一份机制、不同一颗键**，避免两套各写一遍。
 *
 * ⚠️ **页面态、不进账本**：放格子在点「确定」的那一刻才变成一次真实的提交。
 * ⚠️ 换一局 / 读档要清掉（`resetLocalViewState` 里那一句）——
 *   否则上一局的凭证会挂在新一局的槽上。
 */
const VSLOTS = { the_great_achievement: 3, the_proper_way: 3, the_resonance_of_the_other: 3 };
// ⚠️⚠️ 2026-10-07（用户裁定）：凭证放上去**默认持久化** —— 刷新页面也不丢。
//   存 localStorage；读回来时**逐 id 对账**（`vSlots` 里做）：凭证 id 是
//   `V:{dim}:{绑定id}`，换一局 / 读另一档后旧 id 对不上 ⇒ 就地清掉，不会挂幽灵。
const VPERSIST_KEY = 'wuyu_vslots_v1';
function vPersistSave(){
  try {
    if (vPicks.slots) localStorage.setItem(VPERSIST_KEY, JSON.stringify(vPicks.slots));
    else localStorage.removeItem(VPERSIST_KEY);
  } catch (e) { /* 隐身模式 / 存储满 ⇒ 静默降级为页面态 */ }
}
function vPick(){
  if (!vPicks.slots) {
    vPicks.slots = {};
    for (const k in VSLOTS) vPicks.slots[k] = new Array(VSLOTS[k]).fill('');
    // 上一次会话放好的格子**原样接回来**（结构不合 / 存储坏 ⇒ 丢弃，走全新初始化）
    try {
      const raw = localStorage.getItem(VPERSIST_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        let ok = saved && typeof saved === 'object';
        for (const k in VSLOTS) if (ok && (!Array.isArray(saved[k]) || saved[k].length !== VSLOTS[k])) ok = false;
        if (ok) vPicks.slots = saved;
      }
    } catch (e) { /* 解析坏 ⇒ 就当没存过 */ }
  }
  return vPicks.slots;
}

/** 把 `vPicks.slots` 摊成一份带 id 的清单（渲染与判据读**同一份**） */
function vSlots(v){
  const st = vPick();
  const out = [];
  for (const dim in VSLOTS) {
    for (let i = 0; i < VSLOTS[dim]; i++) {
      let vid = st[dim][i] || '';
      // ⚠️ 持久化后的**对账**：这局账本里没有这条凭证（换局 / 读档 / 已被结算回收）
      //    ⇒ 就地清掉并落盘，别让幽灵 id 占着位（卡位显示成空、点「确定」还把它交上去）。
      if (vid && !arr(v.vouchers).some((x) => x.id === vid)) { st[dim][i] = ''; vid = ''; vPersistSave(); }
      const vc = vid ? arr(v.vouchers).find((x) => x.id === vid) : null;
      out.push({ dim: dim, i: i, vid: vid, vc: vc || null });
    }
  }
  return { slots: out };
}

/** 一个卡位的 HTML（空/实两种）—— `data-drop="voucher"` 是拖拽判据读的那一个属性 */
function vslotHtml(x){
  const ord = ['①', '②', '③'][x.i] || '';
  if (!x.vc) {
    return '<div class="vslot" data-drop="voucher" data-vdim="' + x.dim + '" data-vi="' + x.i + '"' +
      ' title="把对应的凭证卡拖到这里"><span class="ord">' + ord + '</span>' +
      '<span class="pdash">＋</span></div>';
  }
  return '<div class="vslot filled" data-drop="voucher" data-vdim="' + x.dim + '" data-vi="' + x.i + '"' +
    ' title="' + esc(x.vc.title) + '：' + esc(x.vc.detail || '（没有描述）') + '">' +
    '<span class="ord">' + ord + '</span>' +
    '<span class="px" data-act="unplaceVoucher" data-vdim="' + x.dim + '" data-vi="' + x.i + '" title="取回">×</span>' +
    '<span class="vtitle">' + esc(x.vc.title) + '</span>' +
    '<span class="vdesc">' + esc((x.vc.detail || '（没有描述）').slice(0, 40)) + '</span></div>';
}

/**
 * **还没站过来的人** —— 一块独立弹窗（2026-10-07 用户第 3 条）。
 *
 * ⚠️ 用户原话：「点开后进入**独立弹窗**，屏幕**左侧是竖列的人物概览**（而不是和地图同级），
 *   再点其中的人物可以看某个人物的详情，**点其他人物则替换**，点空白处则退出这个弹窗」。
 *
 * ⚠️ **左窄右宽**：左边回答"有谁"（竖列，一眼扫完），右边回答"他是谁"。
 *   ⇒ 右栏**直接复用 `sheetPerson`**（六维 / 认可 / 携带 / 那段描述）——**一字不重写**；
 *     两处各写一份的话，"人物详情"这件事就有两个版本了（老坑）。
 *
 * ⚠️ **选中态是页面态**（`outSel`，不进账本）：它只决定"右边显示谁"，
 *   读档 / 换局要清（`resetLocalViewState` 里那一句）。
 * ⚠️ 竖列**只列未入队的人** —— 这块弹窗的入口就是那张「尚未入队（N）」的卡，
 *   把已入队的人列进来会让入口名与内容对不上（想找已入队的人，手牌带上就有）。
 */
let outSel = null;

function sheetOutsiders(v){
  const list = arr(v.people).filter((p) => !p.affiliated && !isGone(p));
  if (!list.length) return sheetHead('没有还没入队的人', '他们都站过来了。');
  // ⚠️ 选中的那个**必须还在名单里**（他可能在弹窗开着的时候入队了）——
  //   不在就落回第一个，否则右栏会去渲染一个已经不在名单上的人。
  if (!outSel || !list.some((p) => p.id === outSel)) outSel = list[0].id;
  const rows = list.map((p) =>
    '<div class="outrow' + (p.id === outSel ? ' on' : '') + '"' +
    ' data-act="outPick" data-who="' + esc(p.id) + '" title="点一下看他的详情">' +
      '<span class="onm">' + esc(p.name) + '</span>' +
      '<span class="osub">' + esc(p.identity || p.basic || '') + '</span>' +
      '<span class="ostat">HP ' + p.hp + ' · SAN ' + p.san + '</span>' +
    '</div>').join('');
  return '<div class="outdesk">' +
    '<div class="outlist" title="还没站过来的人">' + rows + '</div>' +
    '<div class="outdetail">' + sheetPerson(v, outSel) + '</div>' +
  '</div>';
}

/**
 * **一张凭证卡的详情**（2026-10-07 用户裁定第 22 条的补充：
 * 「凭证卡卡面，应当是**标题＋凭证卡类型**，点开才能看到具体描述」）。
 *
 * ⚠️ **卡面只有标题 ＋ 类型**：那两样是玩家扫一眼就要认出来的东西；
 *    描述（一句完整的散文）放卡面上会把卡带拉得很宽，而卡带是要横向扫的。
 *    ⇒ 描述**全部收进这一层**，点开才读。
 *
 * ⚠️ **描述的来源**（同 `ui/session.ts·vouchersOf`，那里是唯一一处判定的地方）：
 *    · 三类一律 ⇒ **凭证自己的 `desc`**（LLM 结算时写的 30~75 字说明，2026-10-08 用户第 2 条）；
 *      为空时回退：成果类 ⇒ 物品 `desc`、事件类 ⇒ 事件概要 `summary`（旧档兼容）。
 *    ⚠️ **事件类要额外把事件标题显示出来** —— 玩家需要知道"这是哪件事"。
 *
 * ⚠️ **这层不给拖拽入口**（`data-drop` 一个都没有）⇒ 在这一屏里拖不动任何东西，
 *    玩家不会在这里误拖。它只是"读一页说明"。
 */
function sheetVoucher(v, id) {
  const vc = arr(v.vouchers).find((x) => x.id === id);
  if (!vc) return sheetHead('找不到这张凭证', '');
  // ⚠️ 事件类额外找一下**是哪件事** —— 它的卡面标题就是事件标题，
  //   而概要只说"这件事办成了什么"，玩家未必认得出对应哪一件。
  const 主体 = (() => {
    if (vc.dim !== 'the_proper_way') return '';
    const tail = String(vc.id).split(':').slice(2).join(':');
    const all = arr(v.settled).concat(arr(v.waiting), arr(v.hidden || []));
    const ev = all.find((e) => e.id === tail);
    return ev ? ev.title : '';
  })();
  return sheetHead(vc.title, vc.dimLabel) +
    (主体 ? '<div class="sec"><div class="h">这件事</div><div class="prose">' +
      esc(主体) + '</div></div>' : '') +
    // ⚠️ 2026-10-08（用户第 6 条）：稀有度一行 —— 与卡面同一口径（普通/罕见/珍稀/传说）。
    '<div class="sec"><div class="h">稀有度</div><div class="prose">' +
      esc(vc.rarity || '普通') + '</div></div>' +
    // ⚠️ 2026-10-08（用户第 2 条）：描述统一为「凭证上的话」—— 三类的 detail 现在
    //    都是凭证自己的 desc（事件类旧档回退到概要，标题口径也一并归一）。
    '<div class="sec"><div class="h">凭证上的话</div><div class="prose">' +
      (vc.detail ? esc(vc.detail) : '<span style="color:var(--muted)">（没有更多说明）</span>') +
    '</div></div>';
}

/** 一个人 —— 把 `v.people[i]` 里**已经存在**的字段铺开 */
function sheetPerson(v, id){
  const p = id === v.me.id ? v.me : arr(v.people).find((x) => x.id === id);
  if (!p) return sheetHead('找不到这个人', '');
  const isMe = p.id === v.me.id;
  // ⚠️ 同一条口径（见 `personCard` 顶栏那段注释）：**尚未入队的人不报容量** ——
  //    "他今天还有多少空闲"对玩家没有意义（他根本调不动这个人）。
  const st = [p.status !== '正常' ? p.status : null, p.away ? '在途' : null,
    (!isMe && !p.affiliated) ? '尚未入队' : null,
    (isMe || p.affiliated) ? (isMe ? '剩时 ' : '容量 ') + p.ap : null].filter(Boolean).join(' · ');
  const rec = arr(p.recognized);
  // ⚠️⚠️ 2026-10-07 用户裁定：携带那一节改成**四个物品卡槽**（取代旧 `.carrylist` 文字条）：
  //   · 从左到右四格，顺序 = `Person.items`（装填顺序）= **生效优先级**
  //     （`effectiveItems` 已改纯槽位顺序：有加成的前 2 件生效）；
  //   · 槽里画**真实的物品卡**（可点开详情、可拖走 —— 与手牌带上那张同一套判据）；
  //   · **卡槽变绿 = 这件的加成正在生效**（判据 `effectiveItemIds`，与规则层同源）；
  //   · 槽间拖动 = 换位（调生效优先级）；空槽也收卡（= 挪到那个位置）。
  //   ⚠️ 判据 `effectiveItemIds`（与规则层同源），**UI 不自己算**。
  const effSet = {};
  arr(p.effectiveItemIds).forEach((x) => { effSet[x] = true; });
  const items = arr(p.items);
  const slotCard = function (it) {
    // 与 `handItemCard` 同一套 data 判据（拖拽源 / 点开详情），**不重写一套**：
    // ⚠️ **不带 `data-to-whom`** —— 那是"落在它身上＝交给它的主人"的记号，
    //    槽内换位要认的是**外层 `.islot`**（见 pointerup 的槽位那一支）。
    return '<div class="icard" data-act="detail" data-kind="item" data-id="' + esc(it.id) + '"' +
      ' data-name="' + esc(it.name) + '" data-holder="' + esc(p.id) + '"' +
      ' title="' + esc(it.name) + ' —— 点开看；按住拖到别的槽＝换位，拖到手牌区＝收回（要给别人，先收回再从手牌拖）">' +
      '<div class="hn">' + esc(it.name) + '</div>' +
      // ⚠️ 2026-10-07：与手牌物卡同一套「绿词条＋属性图标」（`bonusTags`，三处共用）；
      //   特殊物品给蓝词条；两者皆无才落回类别素文本。
      '<div class="hb2">' +
        (arr(it.bonus).length ? bonusTags(it.bonus, 9)
          : (it.kind || '') === '特殊物品' ? '<span class="itsp">特殊物品</span>'
          : esc(it.kind || '')) +
      '</div>' +
    '</div>';
  };
  const slots = [];
  for (let k = 0; k < 4; k++) {
    const it = items[k];
    slots.push('<div class="islot' + (it ? (effSet[it.id] ? ' on' : '') : ' empty') + '"' +
      ' data-to-whom="' + esc(p.id) + '" data-slotwho="' + esc(p.id) + '" data-slotix="' + k + '"' +
      (it ? '' : ' title="空槽 —— 把物品卡拖进来＝装到这个位"') + '>' +
      (it ? slotCard(it) : '空') +
    '</div>');
  }
  const carrier = slots.join('');
  return sheetHead(p.name, p.basic) +
    '<div class="kv"><span class="tag">' + esc(p.identity) + '</span>' +
      '<span>HP <b>' + p.hp + '</b>　SAN <b>' + p.san + '</b></span>' +
      '<span>' + esc(st) + '</span></div>' +
    // ⚠️⚠️ **2026-10-06 用户裁定：人物形象描述**（`Person.desc` · 50~100 字）
    //   —— 「该人物形象、性格、来历的简要描述」，**所有人物同一位置**。
    //   ⇒ **这一段是 2026-10-06 才加的**：此前 `desc` 只进 prompt（`static-head.ts:90`），
    //      **界面上一个字都不显示** ⇒ "和其余人物描述位置一致"这条无处可对齐。
    //   ⚠️ 玩家那一句（「你自己，塞兰王国的三王子……」）也走这里 —— 它硬编码在
    //      `ledger/initial.ts·PLAYER_DESC`，与**其余人物同一字段、同一位置**。
    //   ⚠️ 标题用**中性**的「他是个什么样的人」—— 旧的欲望面板词条已整条删掉，
    //      这里要的是**人物卡**上的独立一段；且"他"对女性/他人不合适 ⇒ 标题不带人称。
    (p.desc ? '<div class="sec"><div class="h">他是个什么样的人</div><div class="prose">' +
      esc(p.desc) + '</div></div>' : '') +
    '<div class="sec"><div class="h">六维</div>' + attrGrid(p) + '</div>' +
    (rec.length ? '<div class="sec"><div class="h">他给过的认可</div>' +
      '<div class="prose">' + esc(rec.join('、')) + '</div></div>' : '') +
    // ⚠️ **只有「可派遣的人」才给携带那一节**（2026-09-22 用户裁定：可派遣的人物身上才需要可以分配
    //    物品的格子，未入队的人物玩家也不一定有权利知道他们携带了什么）。
    //    判据用 affiliated（是不是三王子的人）—— 与 personCard 的「尚未入队」、规则层的
    //    isAvailable 第一行、prompt/blocks.ts 的「空闲 / 尚未入队」是同一条口径。
    //    ⚠️ 未入队者**整节不出现**（不给空态句）—— 不显示就是不显示，别造第二句话。
    //    ⚠️ 六维**照给**（用户同日裁定：未入队者的六维可以看）。
    ((isMe || p.affiliated) ? '<div class="sec"><div class="h">' + (isMe ? '身上带着' : '携带')
      + ' <span class="sub" style="font-weight:400">从左到右 4 格 · 有加成的前 2 件生效（绿槽）</span></div>' +
      '<div class="cslots">' + carrier + '</div></div>' : '');
}

/** 一件东西 */
function sheetItem(v, id){
  const i = arr(v.items).find((x) => x.id === id);
  if (!i) return sheetHead('找不到这件东西', '');
  return sheetHead(i.name, i.kind + (i.bonus.length ? ' · ' + i.bonus.join(' ') : '')) +
    (i.desc ? '<div class="sec"><div class="h">说明</div><div class="prose">' + esc(i.desc) + '</div></div>'
            : '<div class="prose" style="color:var(--muted)">它没有更多说明了。</div>');
}

function renderOverlay(v){
  const ov = $('overlay');
  const modal = $('modal');
  // ⚠️ 清单第 3 条：`ovtop` ＝ "贴地图上方的浮层开着" ⇒ 左上角两块常驻卡变灰。
  //   **先摘后戴**：本轮若没有任何 .top 浮层，它必须被摘掉 —— 漏摘会灰到普通弹窗之后。
  document.body.classList.remove('ovtop');
  // ⚠️⚠️ 2026-10-06 修第 5 次 **TDZ**：`pending` 原来声明在下面（弹窗那一支附近），
  //   而**事件浮层那一支要用它**（`!pending.length` 当守卫）⇒ 抛
  //   `Cannot access 'pending' before initialization`
  //   ⇒ 后果：**事件点不开**（用户第 14 条报的正是这个）。
  //   ⚠️ `node --check` exit=0、661 条测试全绿 —— 都发现不了它（只在浏览器里跑）。
  //   ⇒ 提到**函数开头**：下面三处判据（事件浮层 / 详情 / 收尾）全部共用它。
  const pending = arr(v && v.popups);

  // ⚠️⚠️ 2026-10-07（用户裁定）：**场景进行中 ⇒ 对话窗**（复用事件台浮层的位置）。
  //    走 `.top`：手牌区留在可交互层；左气泡＝LLM 回应、右气泡＝玩家输入，
  //    进入时先重放事件描述 ＋ 固定邀请句（见 `sceneChatHtml`）。
  //    ⚠️ 它要**排在事件台之前**：场景一开，那件事就转「处理中」，
  //      玩家在收束前只与这场对话交互（结束对话即回到台面）。
  //    ⚠️⚠️ 2026-10-07 用户裁定「档 A 与常规事件同级」⇒ 这里**不再要求档 A 已清** ——
  //      否则排布闸门放开后，玩家开着场景时来了档 A，对话窗会被堵成打不开。
  if (v && v.scene && !popupResults.length) {
    ov.classList.remove('hidden');
    ov.classList.add('top');
    document.body.classList.add('ovtop');
    modal.className = 'evdeskmodal';
    modal.innerHTML = sceneChatHtml(v.scene, v);
    // 新气泡进来 ⇒ 停在最底（玩家要的是"接着说"，不是"从头翻"）
    const cb = document.getElementById('chatbox');
    if (cb) cb.scrollTop = cb.scrollHeight;
    return;
  }

  // ⚠️⚠️ 2026-10-06（**改**）：**正在办的那件事 —— 浮层**（用户裁定
  //   「点开后应该是在画面中间有一个额外的弹窗区，**在地图层上方**」）。
  //   ⚠️ 2026-10-05 曾把它改成「中栏同屏」，理由是"手牌带要保持可见可拖"——
  //     那条目标仍要成立，但**不再靠"不挡手牌带"达成**：
  //     **这个浮层自带一块迷你卡带**（下面那行 `handMini`），
  //     玩家在浮层里就能把人卡/物卡拖进槽位 ⇒ 地图完整，拖拽也还在。
  //   ⚠️ 浮层的底是**半透明**（`.evdesk` 用 `--panel` ＋ 高不透明度）⇒ 玩家仍看得到
  //     底下的地图与那一堆事件块 ⇒ 不会失去方位感（《苏丹》也是这个路子）。
  //   ⚠️⚠️ 2026-10-07 用户裁定「档 A 与常规事件同级」⇒ 这里**不再要求档 A 已清** ——
  //     旧判据 `!pending.length` 让"还没点完档 A"时点常规事件**毫无反应**
  //     （detailOpen 设了、这一支却跳过去 ⇒ 玩家看到的就是"点不开"）。
  //     ⚠️ `!popupResults.length` 保留：结算正文弹窗仍是"必须先看完"的打断。
  if (detailOpen && detailOpen.kind === 'event' && v && !popupResults.length) {
    const busy = eventOf(detailOpen.id);
    if (busy) {
      // ⚠️ 走 `.top`：**只占上 2/3，手牌区留在可交互层**（2026-10-07 补做用户第 4 条）
      ov.classList.remove('hidden');
      ov.classList.add('top');
      document.body.classList.add('ovtop');
      modal.className = 'evdeskmodal';
      modal.innerHTML =
        // ⚠️⚠️ 2026-10-07 修（用户第 5 条核验时抓到的布局崩塌）：
        //   **外层不再套一个 .evdesk 壳**。.evdesk 是 grid-template-columns:2fr 1fr，
        //   而那个壳的第一个子元素是 .evdesk-head ⇒ head 占了 2fr 那一列，
        //   cardHtml 返回的整张卡被挤进 1fr 里（真机实测：台面只有 402px 宽、
        //   还被推到最右，左边 2/3 全空）。
        //   ⇒ 壳去掉、evdesk-head（「正在办 / 标题 / 放回去」）整行也去掉 ——
        //     标题归右 1/3 那个长方格、退出键是 x（用户第 5 条的原话）。
        '' +
          // ⚠️⚠️ 2026-10-07 用户第 5 条复验：**浮层里那块「迷你卡带」整块撤掉**。
          //   它原本是为第 4 条（「事件点开时手牌区要能拖」）造的替身 ——
          //   而第 4 条真正要的东西，**底部那条手牌带本来就有**：
          //   #overlay.top 只占上 2/3，下面的卡带看得见、拖得动（实测过，
          //   本探针就是从底部那条轨道把卡拖进菱形里的）。
          //   ⚠️ 它带来的坏处都是实测出来的（用户截图）：
          //     ① 同一批卡**在屏幕上出现两次**（底部一次、浮层里一次）⇒ 不知道拖哪个；
          //     ② 它给手牌串传的是**裸串**（没套 .hand-rail）⇒
          //        .hand-mini .hand-rail{display:flex} 根本不匹配 ⇒ **卡片竖着堆成一列**
          //        （用户截图里左边那一竖条就是这个）；
          //     ③ 它白吃 122px 高度 —— 而矮屏上正缺的就是这 122px（下 1/4 的
          //        「亲自去且仔细处理」会被裁掉，用户报的正是这个）。
          //   ⇒ 一处都不要：拖拽回到底部那条卡带（一条轨道、一套判据）。
          // ⚠️⚠️ 2026-10-07 用户裁定（第二批）：**医馆/神殿不再塞进事件台**——
          //   它们是**地图上的常驻功能事件**（见 `canvasHtml` 的 `fixCards`），
          //   点开走自己的功能单（`fixSheetHtml`）。上一批在这里拼的
          //   `fixDeskHtml(v)` 整块删除 —— 用户原话「莫名其妙的塞在每个事件里，
          //   也导致了原本的图层装不下了」。
        // ⚠️⚠️ 2026-10-07 用户第 3 条：**「处理中」的事件点开＝只读回看** ——
        //   槽里还是他派的人、处理方式照旧，但**没有任何可操作的东西（点 × 除外）**：
        //   ✔ / 人槽 / 方式 / 垫金全部不出现。此前 `ro` 参数**从来没人传过**
        //   （`cardHtml(busy)` 一个参数），回看态长得和待处理一模一样 ⇒
        //   玩家再点一次 ✔，吃一句"已经排上或了结"的服务端报错（用户截图原话）。
        cardHtml(busy, busy.status !== '待处理');
      return;
    }
  }

  // ⓪½ **功能单**（医馆疗伤 / 神殿净化）—— 地图上那张 `fix:` 卡点开后的浮层。
  //    与事件台同一套手势：只占上 2/3（`.top`），手牌带留在可交互层（拖人/拖金币进来）。
  //    ⚠️⚠️ 2026-10-07 用户裁定（第十五批）：**档 A 没清也点得开** —— 恢复与常规事件同级
  //      （上批第 1 条同一口径）；只有结算结果队列还压着时才等一等（结果优先于新操作）。
  if (detailOpen && detailOpen.kind === 'fix' && v && !popupResults.length) {
    ov.classList.remove('hidden');
    ov.classList.add('top');
    document.body.classList.add('ovtop');
    modal.className = 'sheetmode fixsheet';
    modal.innerHTML = fixSheetHtml(v, detailOpen.place);
    return;
  }

  // ⓪ 有**待确认**的事（保存并退出 / 直接结算 / 删档）⇒ 它优先于档 A 弹窗。
  //    它不会与档 A 同时发生：那三条只有玩家点得出来，而档 A 未清时玩家根本点不到别处。
  if (confirmAsk){
    ov.classList.remove('hidden');
    // ⚠️ **摘掉 `top`**（2026-10-07）：确认框是"必须回答"的打断，占满全屏才对。
    //   不摘的话，上一个 `.top` 浮层关掉时它会**继承**下来 ⇒ 一个确认框只占上 2/3。
    ov.classList.remove('top');
    modal.className = confirmAsk.danger ? '' : 'plain';
    modal.innerHTML = '<h2>' + esc(confirmAsk.title) + '</h2>' +
      '<div class="body">' + esc(confirmAsk.text) + '</div>' +
      '<div class="ops" style="margin-top:12px">' +
        '<button class="primary" data-act="confirmYes">' + esc(confirmAsk.yes) + '</button>' +
        '<button data-act="confirmNo">' + esc(confirmAsk.no || '先不要') + '</button>' +
      '</div>';
    return;
  }
  // ⚠️ 这次渲染既不是确认框也不是自建面板 ⇒ 把上一次残留的软边框类清掉。
  //    漏了 `sheetmode` 的话，它会**漏给档 A 弹窗** —— 那颗该是红边、是「裁决」，不是阅览层。
  // ⚠️ 2026-10-07：`'sheetmode outmodal'`（用户第 3 条那块未入队弹窗）**也要一起清** ——
  //    漏了它，`outmodal` 会残留到下一屏（下一屏的 `#modal` 会莫名宽到 920px）。
  if (modal.className === 'plain' || modal.className === 'sheetmode'
      || modal.className === 'sheetmode outmodal') modal.className = '';

  // ⓪′ 「我想做点什么」（从页脚打开）—— 与确认框共用同一层遮罩、同一个出口。
  //     文案**逐字保留**（它是玩家语言：不写"不占条数 / 不吃 L 预算"那类系统口径）。
  if (composeOpen) {
    ov.classList.remove('hidden');
    ov.classList.remove('top');   // ⚠️ 同上：摘掉上一屏留下的 `top`
    modal.className = 'plain';
    modal.innerHTML = '<h2>我想做点什么</h2>' +
      '<div class="sub" style="color:var(--muted)">摆在你面前的事之外，你也可以自己找一件来做 —— 写一句你打算怎么做。</div>' +
      '<textarea id="createText" placeholder="例：我想去城郊替我母亲立一块碑">' + esc(composeText) + '</textarea>' +
      '<div class="ops">' +
        '<button class="primary" data-act="create"' + (v && v.remaining <= 0 ? ' disabled' : '') + '>就做这件事</button>' +
        '<button data-act="closeCompose">先不写</button>' +
        '<span class="sub" style="color:var(--muted)">提名目不用花时间；去办它才要。</span>' +
      '</div>';
        // ⚠️ 2026-10-07（用户第 2 条）：「写「你打算怎么去做」，别写「你已经做到了什么」。」
        //    这行**删了** —— 上一行那句已经是足够的引导，两行叠着是啰嗦。
    return;
  }


  // ①′ **刚处理完的那一条** ⇒ 先把它的"下半场"给玩家看完，再谈下一条。
  //     这是 2026-09-23 用户裁定的那条流里最要紧的一段：
  //     「弹出一个事件 → 玩家处理 →【保留事件页面 ＋ 玩家处理方式】→ 显示结算结果
  //       → 玩家点确认 → 进入下一个事件（上一个事件的**所有**相关内容都不再显示）」。
  //     ⇒ 它排在**详情浮层之前**：点选之后就该看见结果，不该被一个阅览层盖住。
  if (handled) {
    ov.classList.remove('hidden');
    ov.classList.remove('top');   // ⚠️ 同上
    modal.className = '';
    $('modal').innerHTML = handledHtml();
    return;
  }

  // ①‴ **被点开的档 A**（2026-10-05）—— 画布上点那张大牌才走这里。
  //     ⚠️ 排在 `detailOpen` **之前**：档 A 是必须处理的那一件，不该被一个阅览层盖住
  //        （与它原本"自动弹出"时的优先级一致 —— 只是现在要玩家先点一下牌）。
  //     ⚠️ 找不到它（已被点掉 / 陈旧页面）⇒ 落回下面的 ② 收遮罩，不留一张空壳。
  if (popupOpenId && pending.length) {
    const pe = pending.find((x) => x.id === popupOpenId) || pending[0];
    ov.classList.remove('hidden');
    ov.classList.remove('top');   // ⚠️ 同上
    modal.className = '';
    // ⚠️ **2026-10-05 用户裁定**：正站在序幕末条上时，**选项之前**先给选择面板
    //    （欲望 ＋ 六维都改成玩家自己挑）。`v.desirePick.needsChoice` 是判据（服务端算的）。
    //    ⚠️ 排在 `eventCardHtml` **之后**：他得先读完那场戏，才知道要选什么。
    // ⚠️⚠️ 2026-10-07 修死路：服务端 `needsChoice` 的口径是「站在末条上 && 账本里宣言
    //    还空着」—— 而宣言**落账发生在点掉末条那一刻** ⇒ 玩家提交选择之后它**仍为真**。
    //    旧代码在这里直接回引导屏，玩家永远出不去（真机探针抓到）。
    //    ⇒ 补一个「已提交」判据：`Session.choice.kit ≥ 0`（事实源同在服务端，初始 -1
    //      ＝ 还没挑）。已提交的玩家把 `needPick` 按假处理，直接落到下面「点掉末条」
    //      那一屏 —— 与 5699 行的原设计注释完全一致。
    let needPick = !!(v && v.desirePick && v.desirePick.needsChoice);
    if (needPick && v.desirePick.choice && v.desirePick.choice.kit >= 0) needPick = false;
    // ⚠️ **没选就不许点末条那个选项**（2026-10-05）：`Session.clickPopup` 会在**点掉之前**
    //    预检并拒掉（理由见那里 —— 放到点掉之后就是"弹窗卡死"）。
    //    ⇒ UI 这一侧同步把按钮置灰，让玩家在**按下之前**就看见"还差一步"。
    const kitChosen = !needPick || pickKit >= 0;
    // ⚠️⚠️ 2026-10-06 用户裁定（问题 5）：序幕末条那一屏**只留一句话 ＋ 一个按钮**。
    //   原话（要删的那段）：「在过的日子不是你的：你生的这个位置，这两个哥哥，那门早晚要定的
    //   亲事，这一身漂亮得发沉的袍子，没有一样是你自己挑的。你翻了个身，心口有个东西动了一下
    //   ——很轻，不像念头，更像一件早就搁在那儿、直到此刻才被你摸到的东西。它还没有名字。」
    //   ⇒ 换成「**你受够了这样的生活，你下定决心要让塞兰王国迎来大变！**」
    //   ⇒ **选项列表整条不出现**（用户：「下面的东西全部不需要在这次弹窗出现」），
    //     改为一个按键「**选择你的欲望宣言**」，点它进入宣言选择那一步。
    //   ⚠️ `needPick` 为假时（即**已经**选过了）仍旧走原来那条：选项列表要出现
    //     —— 那一屏的功能是"点掉这最后一条"，不能把出口一起删掉。
    if (needPick && !pickStage) {
      $('modal').innerHTML =
        '<h2>原初的欲望</h2>' +
        '<div class="prose" style="margin-top:10px;font-size:15px;line-height:1.8">' +
          '你受够了这样的生活，你下定决心要让塞兰王国迎来大变！</div>' +
        '<div class="ops" style="margin-top:16px">' +
          '<button class="primary" data-act="pickOpen">选择你的欲望宣言</button>' +
        '</div>' +
        '<div class="ops" style="margin-top:8px"><button data-act="closePopupOpen">先不处理</button></div>';
      return;
    }
    // ⚠️ 2026-10-06（问题 5）：`needPick` 时**不再给标题与解说** ——
    //   那两句（「那东西还没有名字」／「它得由你命名…」）是原来那一屏的**解说**，
    //   而用户原话是「下面的东西全部不需要在这次弹窗出现」⇒ 一并去掉。
    //   剩下的是**面板本身**（宣言 or 属性），那才是玩家要操作的东西。
    //   ⚠️ `needPick` 为假时（已选过）仍旧要标题 —— 那一屏的功能是"点掉最后一条"。
    // ⚠️⚠️ 2026-10-07 用户裁定：**先详情后选项** ——「点击事件后应该显示事件详情＋玩家的选项，
    //   玩家点击选后再呈现结果」。旧版把详情整段吞了、上来就是选项列表（序幕与正文的
    //   档 A 同病 —— 都走这一支），玩家对着几个不明所以的按钮做决定。
    //   ⇒ **`eventCardHtml(pe)` 打头**（标题 ＋ 地点 ＋ 正文），选项与阶段面板跟在后面；
    //     点选之后的下半场不变（`handled` 那张卡本来就有详情 ＋ 所选 ＋ 结果）。
    $('modal').innerHTML =
      eventCardHtml(pe) +
      (needPick ? '' : '<h2 style="margin-top:14px">你当场就得拿主意</h2>' +
        '<div class="sub" style="color:var(--muted)">' +
          '没有别人能替你走这一步 —— 定下来，当场就有下文。') +
      '</div>' +
      (needPick && pickStage === 'kit'
        // ⚠️ 第二步：宣言那一步（问题 6）—— **只给那几句宣言**，属性那步在它之后（问题 7）。
        ? kitStageHtml(v.desirePick)
        : (needPick ? advStageHtml(v.desirePick) : '')) +
      (needPick ? '' : pe.options.map((o, i) => '<button class="opt" data-act="popup" data-ev="' + pe.id + '" data-i="' + i + '"' +
        (kitChosen ? '' : ' disabled') + '>' +
        esc(o.text) + '</button>').join('')) +
      '<div class="ops" style="margin-top:10px">' +
        (needPick && pickStage === 'kit'
          ? '<button data-act="pickBack">返回</button>'
          : '<button data-act="closePopupOpen">先不处理</button>') +
      '</div>';
    return;
  }

  // ①″ 详情浮层（B 轮）—— 点开一张卡看「具体内容」。
  //     ⚠️⚠️ 2026-10-08（用户裁定）：**档 A 未清不再拦详情查看** ——
  //        旧判据 `!pending.length` 让"还没点完档 A"时点人物卡 / 物品卡 / 地点 / 凭证 /
  //        「尚未入队」**毫无反应**（`detailOpen` 设了、这一支却被跳过 ⇒ 玩家看到的就是"点不开"）。
  //        档 A 是"待办"，不是"锁屏"：与事件台（2026-10-07 放开）、功能单同一条纪律。
  //        唯一还压它一头的只有 `popupResults`（结算正文是"必须先看完"的打断）。
  // ⚠️⚠️ 2026-10-05：**事件的详情不进浮层**（用户裁定：「点开后手牌区就不能拖拽了」）。
  //    病灶（用户实测 ＋ 截图）：浮层上面盖着**遮罩**，而拖拽源（底部手牌带）
  //    在遮罩下面 ⇒ 看得见卡、**拖不动**。而我们明明已经写好了 `canDropOn`
  //    （认人卡、认物卡，第五轮又加了认金币卡）—— **那条路事实上一直是断的**。
  //    ⇒ 事件详情改**同屏**：中栏顶部一条「正在办：××」（可收起），
  //      底部手牌带保持可见可拖。人/物/钱三格做成《苏丹》那样的**卡位**。
  //    ⚠️ **只有事件走这条路**：人物/物品/这一局的详情仍是浮层 ——
  //    它们是"看一眼"，而事件是"要动手"，动手这件事必须在手牌旁边做。

  if (detailOpen && v && !popupResults.length) {

    // ⚠️ 走 `.top`：**「你的欲望」与事件台同一图层**，手牌区不被遮挡
    //   ⇒ 凭证卡能从手牌区拖进四行卡位（用户 2026-07-07 原话：
    //   「『你的欲望』应当和常规事件在同一图层，即不遮挡手牌区，
    //     不然玩家无法放凭证」）。
    //   ⚠️ `person` / `item` 两个详情**也走 `.top`** —— 它们同样要拖物品卡给人（`/api/give`）。
    ov.classList.remove('hidden');
    ov.classList.add('top');
    document.body.classList.add('ovtop');
    modal.className = 'sheetmode';
    const d = detailOpen;
    // ⚠️⚠️ 2026-10-07 用户第 3 条：**「尚未入队」是一块自己成套的弹窗**（左竖列 ＋ 右详情），
    //   它不套 `.sheet`（那一层是"一页文字"，会把左右两栏压成上下）。
    //   ⚠️ 它**不给凭证拖拽入口**（`enableVoucherDrag(false)` 不必调：`.voucher` 本就没 `data-kind`）。
    if (d.kind === 'outsiders') {
      // ⚠️ 额外挂一个 `outmodal` —— 这一屏是**左右两栏**，720px 会把右栏挤扁
      //   （`#modal.sheetmode` 的 `max-width` 是给"一页文字"定的）。
      modal.className = 'sheetmode outmodal';
      $('modal').innerHTML = '<div class="sheet outsheet">' + sheetOutsiders(v) + '</div>' +
        '<div class="ops" style="margin-top:12px"><button class="primary" data-act="closeDetail">退出</button>' +
        '<span class="sub" style="color:var(--muted)">点左边的人换一个看；点空白处也能退出。</span></div>';
      return;
    }
    const inner = d.kind === 'quest' ? sheetQuest(v)
      : d.kind === 'person' ? sheetPerson(v, d.id)
      : d.kind === 'voucher' ? sheetVoucher(v, d.id)
      : sheetItem(v, d.id);
    // ⚠️⚠️ 2026-10-06 清单第 4B.4 条：**凭证卡只在「你的欲望」这一屏可拖**
    //   （用户原话：「放在手牌区，但**只能在『你的欲望』事件中使用**」）。
    //   ⇒ 在这一屏 `innerHTML` 写完之后、手牌区重画**之前**补上 `data-kind` ——
    //     `handRailInner` 每轮 `render()` 都重画，而 `render()` 先调 `renderHand` 再 `renderOverlay`
    //     ⇒ 必须在这里补（下一轮 render 手牌会被清掉、这个属性得每轮重补一次）。
    enableVoucherDrag(d.kind === 'quest');
    $('modal').innerHTML = '<div class="sheet">' + inner + '</div>' +
      '<div class="ops" style="margin-top:12px"><button class="primary" data-act="closeDetail">收起</button>' +
      '<span class="sub" style="color:var(--muted)">点卡片外面也能收起。</span></div>';
    return;
  }
  // ①‴″ **难度选择弹窗**（2026-10-08 用户第 5 条）—— 觉醒刚完成、第 1 天还没铺开的那一拍。
  //     此刻末条刚被点掉（popups 已空）、`popupResults` 也是空的、`detailOpen` 为空 ⇒
  //     前面几支全不命中，正好插在收遮罩那行之前 —— 世界停住，等玩家挑叙事风味。
  if (difficultyOpen) {
    ov.classList.remove('hidden');
    ov.classList.remove('top');
    modal.className = '';
    // ⚠️ 三档文案**逐字**照用户原话 —— 「--  哦」的双空格是用户原文的梗，不许"修"；
    //    档 3 里"运动"一词后原先连写了两个"的"，那是笔误，2026-10-08 用户裁定删掉一个。
    // ⚠️ 2026-10-08 用户裁定（同批第 4 条）：标题换「你想要一个什么样的故事？」、
    //    删那句小字批注、三档前加 A/B/C；**点完一颗 ⇒ 它变暗、其余不可再点**
    //    （`difficultyPicked` 锁 UI —— 见 90-events.js·pickDifficulty）。
    const TIERS = [
      [1, 'A. 没错！这就是一个为你打造的故事，一个围绕你运转的世界，你的任何言行与想法都会立马得到热情的迎接 -- 虽然还是会有一些小磕绊，但你懂的，小调剂而已啦。'],
      [2, 'B. 世界与故事有其运行之规则，但它们偶尔也会适当纵容你的荒谬的言行，回应你蓬勃的欲望 -- 也许因为苍天不负有心人？'],
      [3, 'C. 这是一个严肃真实的世界，宇宙的法则决定了事物运动的规律，社会的架构塑造了人们的欲望与诉求，后者又反过来影响社会的运转与前行 --  哦，你在哪里？从上句话开始倒数28个字，看到了吗，你就在那里！'],
    ];
    $('modal').innerHTML =
      '<h2>你想要一个什么样的故事？</h2>' +
      '<div class="ops" style="margin-top:14px">' +
        TIERS.map((x) =>
          '<button class="opt" data-act="pickDifficulty" data-level="' + x[0] + '"' +
          (difficultyPicked ? ' disabled' : '') +
          ' style="white-space:normal;text-align:left;line-height:1.7' +
          (difficultyPicked === x[0] ? ';opacity:.45' : '') + '">' + esc(x[1]) + '</button>').join('') +
      '</div>';
    return;
  }
  if (!pending.length && !popupResults.length) { ov.classList.add('hidden'); $('modal').innerHTML = ''; return; }
  ov.classList.remove('hidden');
  ov.classList.remove('top');   // ⚠️ 同上
  modal.className = '';

  // ② 档 A ⇒ **不再自动弹出**（2026-10-05 用户裁定「开局一进去就是疯狂点弹窗太突兀了」）。
  //    改成：画布正中摆一张**大牌**，玩家点了才开这一层。
  //    ⚠️ `popupOpen`（画布上那一下）走的是**同一个** `/api/popup` 通路与同一批选项 ——
  //       这只是**什么时候显示**变了，"点一下即结算"这条规则一个字没改。
  //    ⚠️ 结算正文（下面 ③）**仍然自动弹**：那是"你刚做完一件事的结果"，
  //       藏起来等于让玩家以为自己白做了一件事。**该打断的才打断。**
  // ⚠️⚠️ 2026-10-07 用户裁定「档 A 与常规事件同级」的连带：**结算正文不再被档 A 堵住**。
  //    旧判据 `if (pending.length)` 一刀切收遮罩 —— 档 A 没点完时，刚到账的结算结果
  //    （含骰子动画）整队干等，玩家看到的又是"结算什么都没弹"。
  //    ⇒ 档 A 只在**没有结果要看**时才收遮罩（大牌还铺在画布上，随时点得到）。
  if (pending.length && !popupResults.length) {
    // ⚠️ 不弹 ⇒ 直接收起遮罩。玩家点画布上那张牌时会重新走进来。
    ov.classList.add('hidden');
    $('modal').innerHTML = '';
    return;
  }

  // ③ 一笔结算（正文事件的了结 / 场景收束 / 终局话术 …）⇒ **同样一次一条**，
  //    看完点「知道了」才轮到下一条（此前是全堆在一块儿）。
  //    ⚠️ 2026-09-24：这一屏改用 `plain`（金棕）而不是默认那套红 ——
  //      红是留给「你当场就得拿主意」的强制弹窗与危险确认的；一笔下文顶着
  //      两个红字 ＋ 一圈红框，口气对不上（用户这一轮正是在调这个权重）。
  modal.className = 'plain';
  const r = popupResults[0];
  // ③′ **骰子动画弹窗**（2026-10-07 用户裁定）—— 这笔结果若是简略处理掷过骰的那件事，
  //    先在这里播"骰子怎么落的"，玩家点「查看结算结果」才放它换成下面那张普通结果卡。
  //    ⚠️ 骰子在**排布那一刻**就已经掷完（服务端 `handleEvent`），这里的动画是
  //    **纯展示**：播的就是那份既定结果，不掷第二次。
  if (r.roll) {
    // 弹窗态按**条目身份**记（`popupResults` 每次进出都是新对象）：
    // 换了一条 ⇒ 回到"还没掷"；同一条 ⇒ 保留玩家掷到哪一步了（重渲染不重播）。
    if (diceState.entry !== r) diceState = { entry: r, rolled: false, done: false };
    if (!diceState.done) {
      ov.classList.remove('hidden');
      ov.classList.remove('top');
      modal.className = 'plain dicemode';
      $('modal').innerHTML = dicePopupHtml(r);
      return;
    }
  } else if (diceState.entry) {
    diceState = { entry: null, rolled: false, done: false };
  }
  const more = popupResults.length > 1
    ? '<div class="sub" style="color:var(--muted)">后面还有 ' + (popupResults.length - 1) + ' 条。</div>'
    : '';
  $('modal').innerHTML =
    '<h2>结果</h2>' +
    more +
    '<div class="res">' +
      (r.title ? '<div class="sub" style="color:var(--muted)">' + esc(r.kind) + ' · ' + esc(r.title) + '</div>' : '') +
      // ⚠️ 2026-10-05：逐段浮现 ＋ 资源增减演出。档 A 同样要"看得见地变了" ——
      //    它不掷骰，但金币/好感照样在动（只给文字等于让玩家自己心算）。
      segmentHtml(r.text, 'segline') +
      meterDeltaHtml(meterDiffs(beforeMeters, readMeters(S && S.view))) +
      // ⚠️ 2026-10-07（用户裁定）：六维属性的变化**不做动画** —— 在这张结算卡上
      //    直接写一行小字：「谁谁谁 某属性 +x」。
      attrChangeHtml(pendingAttrLines) +
    '</div>' +
    '<div class="ops" style="margin-top:12px"><button class="primary" data-act="closeResults">知道了</button></div>';
}

/**
 * **开局选择面板**（2026-10-05 用户裁定：欲望 ＋ 六维都改成玩家自己挑）。
 *
 * ⚠️ **它渲染的是"还没发出去的那次编辑"**（`pickKit` / `pickAdv` 两个本地变量），
 *    灌进来时**从 `v.desirePick.choice` 取**（`syncPick`）—— 服务端的 `Session.choice`
 *    才是事实源，这里只是草稿。
 * ⚠️ **判据全在服务端**（`needsChoice` ＋ `pickDesire` 的越界拒）⇒ UI 不重算一遍
 *    "亮点最多 2 个"，只把后果显示出来（点第三个时那句提示）。两份判据必然漂移。
 * ⚠️ **两条文本都显示，但措辞不同**：宣言是**他自己写下的原话**（大字、居中），
 *    判据是**系统拿它判 28 天的那一句**（小字、灰色）—— 别让玩家分不清哪句会一直在。
 */
/**
 * **第一步：选欲望宣言**（2026-10-06 用户裁定 · 问题 6）。
 *
 * ⚠️ 排版是裁定的一部分：**几个框平铺并排**（两列栅格、几条就几格，不是竖着一列），
 *   每个框里 **大字主体 ＝ 手段＋目的合成的那句**，
 *   **下面小字 ＝ 宣言原话**当修饰性文字。
 *   原话（要删的那段）：「你受够了这样的生活，你下定决心要让塞兰王国迎来大变！」
 *   —— 那句在**上一屏**（序幕那一句），不在这里。
 *
 * ⚠️⚠️ **为什么主体用 `means ＋ proposition` 而不是 `manifesto`**：
 *   后端 `DesireKit` 三个字段各判一个维度 —— `manifesto`（宣言 · 只上卡面与终局，
 *   **不进任何判定**）、`means`（手段 · 判「正当的手段」）、`proposition`（目的 · 判「欲向」）。
 *   ⇒ 玩家要承诺的是**手段与目的**，那才是 28 天里天天拿来判他的东西；
 *     宣言原话是**修辞**，当修饰正好。
 *   ⚠️ 而 28 天后拿他判的是**服务端落的 `desire.manifesto/means/proposition`** ——
 *     这里选哪个，最后都是那三个字段一起进账本，**不许在这里改口径**。
 */
function kitStageHtml(dp){
  syncPick(dp);
  const kits = arr(dp && dp.kits);
  const cards = kits.map(function (k){
    const on = pickKit === k.index;
    const body = esc(k.means) + '，' + esc(k.proposition);
    return '<button class="kitcard' + (on ? ' on' : '') + '" data-act="pickKit" data-k="' + k.index + '" ' +
      'aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="kc-body">' + body + '</span>' +
      '<span class="kc-tag">' + esc(k.manifesto) + '</span>' +
    '</button>';
  }).join('');
  return '<div class="kitstage">' +
    '<div class="ktitle">挑一句你这 28 天都认的话</div>' +
    '<div class="kgrid">' + cards + '</div>' +
  '</div>';
}

/**
 * **第二步：选优势属性**（2026-10-06 用户裁定 · 问题 7）。
 *
 * ⚠️ 改动三处，其余一字未动：
 *   ① 顶部**保留已选的宣言**当提醒（用户原话：「前面选择的欲望宣言要保留到这个弹窗作为提醒」）
 *   ② 「六项总和 60，点亮越多单项越高、其余越低 —— 专精的代价就是平庸。」
 *      ⇒ 改成「**请选择你的优势属性，可选0-2项**」（原话给定）
 *   ③ 按钮「就这样」⇒ 改成「**确定**」
 * ⚠️ **六维怎么分仍是服务端那套算术**（`ATTR_ADV_MAX` ＋ 均值约束），这里只是**点名**——
 *   用户裁的是「**只改文案＋按钮名**」，不是改分配规则。
 */
function advStageHtml(dp){
  syncPick(dp);
  const kits = arr(dp && dp.kits);
  const mine = kits.find((k) => k.index === pickKit);
  const ADV = ['争斗','敏捷','智慧','魅力','社交','感知'];
  const chosen = ADV.filter((a) => pickAdv[a]);
  const full = chosen.length >= 2;
  const adv = ADV.map(function (a){
    const on = !!pickAdv[a];
    return '<button class="optchip" data-act="pickAdv" data-a="' + esc(a) + '" ' +
      'aria-pressed="' + (on ? 'true' : 'false') + '" ' +
      'style="margin:4px 6px 0 0;' + (on ? 'border-color:var(--gold);color:var(--gold);' : '') + '">' +
      esc(a) + '</button>';
  }).join('');
  return '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">' +
    // ① 已选宣言的提醒（问题 7 明确要"保留到这个弹窗作为提醒"）
    (mine
      ? '<div class="pickedline"><span class="pl-t">你刚挑的</span>' +
        '<span class="pl-b">' + esc(mine.means) + '，' + esc(mine.proposition) + '</span>' +
        '<span class="pl-tag">' + esc(mine.manifesto) + '</span></div>'
      : '') +
    '<div style="font-weight:650">再定下你拿什么去换</div>' +
    // ② 文案按裁定替换
    '<div class="sub" style="color:var(--muted);margin-top:2px">请选择你的优势属性，可选0-2项</div>' +
    '<div style="margin-top:8px">' + adv + '</div>' +
    '<div class="sub" style="font-size:12px;color:var(--muted);margin-top:6px">' +
      (chosen.length === 0
        ? '一项都不选也可以 —— 六项一样平庸。'
        : '已选 ' + chosen.length + ' 项：' + esc(chosen.join('、')) + (full ? '（最多 2 项）' : '')) +
    '</div>' +
    '<div class="ops" style="margin-top:10px">' +
      // ③ 按钮名按裁定替换
      '<button class="primary" data-act="pickCommit"' + (pickKit < 0 ? ' disabled' : '') + '>确定</button>' +
      '<button data-act="pickBack">返回</button>' +
      (pickKit < 0 ? '<span class="sub" style="color:var(--muted)">先回去挑一句宣言。</span>' : '') +
    '</div>' +
  '</div>';
}

function desirePickHtml(dp){
  syncPick(dp);
  const kits = arr(dp && dp.kits);
  const ADV = ['争斗','敏捷','智慧','魅力','社交','感知'];
  const chosen = ADV.filter((k) => pickAdv[k]);
  const rows = kits.map(function(k){
    const on = pickKit === k.index;
    return '<button data-act="pickKit" data-k="' + k.index + '" ' +
      'style="display:block;width:100%;text-align:left;margin-top:8px;padding:10px 12px;' +
      'border:1px solid ' + (on ? 'var(--gold)' : 'var(--line)') + ';' +
      'background:' + (on ? 'var(--gold-soft)' : 'transparent') + '">' +
      '<div style="font-weight:650;font-size:14px">' + esc(k.label) + '</div>' +
      '<div style="margin-top:4px;font-size:14px;line-height:1.6">' + esc(k.manifesto) + '</div>' +
      // ⚠️ 手段与目的**分开两行、各带标签**（2026-10-06）：它们各判一个维度 ——
      //    手段判「正当的手段」、目的判「欲向」。糊成一句玩家就分不清自己在承诺什么。
      '<div style="margin-top:6px;font-size:12px;color:var(--muted)">手段：' + esc(k.means) + '</div>' +
      '<div style="font-size:12px;color:var(--muted)">目的：' + esc(k.proposition) + '</div>' +
    '</button>';
  }).join('');
  const adv = ADV.map(function(a){
    const on = !!pickAdv[a];
    return '<button class="optchip" data-act="pickAdv" data-a="' + esc(a) + '" ' +
      'style="margin:4px 6px 0 0;' + (on ? 'border-color:var(--gold);color:var(--gold);' : '') + '">' +
      esc(a) + '</button>';
  }).join('');
  const full = chosen.length >= 2;
  return '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">' +
    '<div style="font-weight:650">先定下你想要什么</div>' +
    '<div class="sub" style="color:var(--muted);margin-top:2px">' +
      '这句话此后 28 天不会变 —— 每天每一手都会拿它判「离它更近了还是更远了」。' +
    '</div>' +
    rows +
    '<div style="margin-top:14px;font-weight:650">再定下你拿什么去换</div>' +
    '<div class="sub" style="color:var(--muted);margin-top:2px">' +
      '六项总和 60，点亮越多单项越高、其余越低 —— 专精的代价就是平庸。' +
    '</div>' +
    '<div style="margin-top:8px">' + adv + '</div>' +
    '<div class="sub" style="font-size:12px;color:var(--muted);margin-top:6px">' +
      (chosen.length === 0
        ? '还没点亮任何一项 —— 六项一样平庸。'
        : '已点亮 ' + chosen.length + ' 项：' + esc(chosen.join('、')) + (full ? '（最多 2 项）' : '')) +
    '</div>' +
    '<div class="ops" style="margin-top:10px">' +
      '<button class="primary" data-act="pickCommit"' + (pickKit < 0 ? ' disabled' : '') + '>就这样</button>' +
      (pickKit < 0 ? '<span class="sub" style="color:var(--muted)">先在上面挑一句。</span>' : '') +
    '</div>' +
  '</div>';
}

/** 把本地草稿**灌成**服务端那份选择 —— 每次进这一层都调，别让它变成第二份事实源 */
function syncPick(dp){
  const c = (dp && dp.choice) || { kit: -1, advantages: [] };
  if (pickKit === -1) pickKit = typeof c.kit === 'number' && c.kit >= 0 ? c.kit : -1;
  if (!Object.keys(pickAdv).length) {
    pickAdv = {};
    arr(c.advantages).forEach(function(a){ pickAdv[a] = true; });
  }
}

/** 一条档 A 的正文块（标题 · 舞台 · 内容）—— 弹窗与"处理完的那张卡"共用同一份排版 */
function eventCardHtml(e){
  return '<div style="margin-top:12px"><div class="title" style="font-weight:650">' + esc(e.title) + '</div>' +
    '<div class="sub" style="color:var(--muted)">' + esc(e.stage) + '</div>' +
    '<div class="body">' + escProse(e.content) + '</div></div>';
}

/**
 * **处理完的那张卡** —— 事件正文 ＋ 玩家处理方式 ＋ 结算结果，合成**一张**卡（2026-09-23 用户裁定）。
 *
 * ⚠️ 三段缺一不可：
 *    · 事件正文 —— 用户原话「**保留事件页面**」（读完就没了的弹窗，玩家回头想不起来自己刚才在选什么）；
 *    · 选项列表 ＋ 高亮所选 —— 用户原话「**玩家处理方式**」。其余选项**淡下去但留着**，
 *      玩家要看得见"我当时是在这几个里选的"；
 *    · 结算结果 —— 贴在**同一条**下面，而不是混进一坨谁也认领不了的说明里。
 * ⚠️ 选项**不带 `data-act`**：这一屏是"回看"，不是"再选一次"（档 A **一生只能点一次**，
 *    再给一次可点的机会只会撞上"这条已经结算过了"）。
 */
/* ═══════════════════════════════════════════════════════════════════
   资源增减的演出（2026-10-05 · 学《苏丹》的资源提示）
   ─────────────────────────────────────────────────────────────────
   用户的判断：「各类资源的增减也是会有额外动画提醒玩家的，**而不是静默变化、
   只有文字提示**」—— 这条说到根子上了。

   病灶（不是观感问题，是信息问题）：我们的 `delta` 是**静默落账**的。
   结算浮层里写「好感 2 · 银 32」—— 玩家读到的是**结果**，
   而"刚才那一下动了多少"这件事在**任何地方都没有被演出来**。
   ⇒ 玩家要自己去心算"原来是多少"。

   做法：**在 UI 侧算前后差值**（`beforeView` / `afterView` 两份 view 对比），
   然后把「涨了 / 跌了」做成一次**看得见的动作**。
   ⚠️ **零请求、零规则改动**：两份 view 都已经在手里了（`api()` 前后各一份），
      差值是**算出来的**，不是新加的读数 —— 它回答的问题本来就在两个 view 里。
   ⚠️ 这是**纯呈现**：不参与任何判定，也绝不回写。关掉动画一切照旧。
   ═══════════════════════════════════════════════════════════════════ */

/** 上一次动作之前的**读数**快照（只在页面内存活，刷新即失） */
let beforeMeters = null;

/* ═══════════════════════════════════════════════════════════════════
   参与卡归位（2026-10-05）
   ─────────────────────────────────────────────────────────────────
   用户的纠正：「卡牌在用的时候，它就不在手牌区了（拖拽进一个事件后你在手牌区就看不到它了）
   ⇒ 所以它们结算时本来就在画面里，**反而是后续可能会飞回来 / 撕毁等**！」

   照这个做下来，第一件事是**去掉一个假动作**：
     ❌ "参与卡飞入判定盘" —— 他本来就不在卡带上，飞进来是凭空造的动画。
     ❌ "结算完真的从判定盘搬回卡带" —— 参与人**根本不在判定盘上**（那只是一份名单）。
   两处都会让玩家以为"我的卡被程序搬来搬去"，而账本里根本没有这种搬运。

   真正该做的是这件事，而且它**只需要一行状态**：
     **他不见了，现在又出现了 —— 这件事要被看见。**
   卡本来就会自己回到卡带（`ledger/types.ts·isAway` 判"在不在路上"，
   他归队日当天就回来）。所以这里做的不是"移动"，是**让那张卡亮一下**：
   结算浮层一关，他那张卡闪一次金光 ＋ 微微弹一下 ⇒ 眼睛跟到了"人回来了"。

   ⚠️ **零请求、零账本改动**：人的位置由 `isAway` 说了算，这里只演一次。
   ⚠️ 只在**真的有参与人**且**他刚刚还在路上**时亮 —— 不然每结算一次都闪一遍，
      那就不是提示而是噪音（第二次就没人看了）。
   ═══════════════════════════════════════════════════════════════════ */
/** 刚结算完、正等着"亮一下"的人 id（页面状态，一次性） */
let backHome = [];

/** 记住"谁去办了这事" —— 在**派出去那一刻**记（那时他正要离开卡带） */
function noteDispatched(ids){
  const me = S && S.view && S.view.me ? S.view.me.id : 'npc000';
  const list = arr(ids).filter((x) => x && x !== me);
  if (list.length) backHome = list;
}

/**
 * 让"刚回来的人"那张卡亮一下。
 *
 * ⚠️ **在 `render()` 之后调**（那时卡带已经是新的 DOM），且**延时清标记** ——
 *   标记必须活过这一轮动画，否则动画刚开始就被下一次 `render()` 抹掉了。
 * ⚠️ 找不到人（他已离场/不在 `people` 里）就**什么都不做** ——
 *   不留一个空壳标记等下一次 `render()`。
 * @param ids 人 id 列表
 */
function markHomecoming(ids){
  var done = false;
  for (var i = 0; i < ids.length; i++) {
    var el = document.querySelector('.hcard[data-id="' + (window.CSS && CSS.escape ? CSS.escape(ids[i]) : ids[i]) + '"]');
    if (el) { el.classList.add('back'); done = true; }
  }
  if (!done) return;
  setTimeout(function () {
    var els = document.querySelectorAll('.hcard.back');
    for (var k = 0; k < els.length; k++) els[k].classList.remove('back');
  }, 1500);
}

/** 盯着那几个会变的顶层读数 —— 全部取自 `view` 里**本来就有的**字段 */
/* ═══════════════════════════════════════════════════════════════════
   变化清单（2026-10-06 · 用户裁定「避免静默的状态变化」）
   ─────────────────────────────────────────────────────────────────
   用户的原话：「所有卡牌（包括人物卡、物品卡等）的获得与失去
   （包括一次性物品的被使用、被派遣的人物处理完事件重新回到手牌区等），
   都应该有简短动画提示玩家，甚至声望等数值的变化也要有动画效果」。

   ⚠️ **为什么它能成立**：`view` 每个动作前后各有一份**全量快照**
      ⇒ 差值是**算得出来的**，不需要任何新数据、**不碰规则层**。
   ⚠️ **它替掉了三处"手抄"**：
      · `readMeters` 只抄 5 个字段 ⇒ **每个人的** HP/SAN 查不到；
      · 动画只在结算屏与卡带各有一套触发点；
      · `markHomecoming` 只在"玩家派出去的人"回来时触发 ⇒
        **LLM 新造的人**、**事件过期自动结算**回来的人，全都漏掉。
   ⚠️ 一条铁律：**清单只"看"，不回写**。它不参与任何判定，
      演出失败（动画被跳过、元素找不到）也只是没演，不影响游戏。
   ═══════════════════════════════════════════════════════════════════ */

/** 上一份 view 的**全量**快照（不是手抄的几个字段）。刷新即失。 */
let beforeView = null;
/** 本次动作算出的变化清单 —— 演出在 `render()` 之后消费它。 */
let pendingChanges = [];
/**
 * 六维属性的**文字版**变化清单（2026-10-07 用户裁定）——
 * 属性动画不好做 ⇒ 在**结算卡**上写「谁谁谁 某属性 +x」的小字。
 * `api()` 里算、结算弹窗渲染时消费，下一次动作时被覆盖。
 */
let pendingAttrLines = [];

/**
 * 一次动作的**变化清单**。三类，卡与数各占一半。
 * @typedef {{kind:string, ...}} Change
 */
function buildChanges(before, after){
  const out = [];
  if (!before || !after) return out;

  // ── ① 人：进出 ─────────────────────────────────────────────────
  //    ⚠️ 比的是**在册**（`view.people` 那一整份），不是"能派的那些" ——
  //    死了的人仍在名册里（第五轮定的"留在卡带上"），
  //    真正"离册"的是 `lost.people` 那种（他整条从 `people` 里消失了）。
  // ⚠️ `indexPeople` 返回的是**对象**（`{id: 人}`）⇒ 必须遍历 `Object.keys`，
  //    `for...of` 一个对象会直接抛 `is not iterable`（**在浏览器里也一样炸**，
  //    且它抛在 `render()` 里 ⇒ 整页不画 —— 这种错最难查，所以这里写死遍历键）。
  const bp = indexPeople(before), ap = indexPeople(after);
  for (const id of Object.keys(ap)) {
    if (bp[id]) continue;
    const q = ap[id];
    // ⚠️ 2026-10-08：`affiliated` 必须带 —— 新人**入队/未入队**的落点与提醒文案
    //    全靠它分流（用户裁定：入队飞卡带＋「加入了你的队伍」；
    //    未入队飞「尚未入队」区＋「你可以在尚未入队区域查看」，3 秒）。
    out.push({ kind: 'person-in', id: id, name: q.name, status: q.status, affiliated: !!q.affiliated });
  }
  for (const id of Object.keys(bp)) {
    const p = bp[id], q = ap[id];
    if (!q) { out.push({ kind: 'person-out', id: id, name: p.name, gone: isGoneStatus(p.status) }); continue; }
    // 归属变了 ＝ 离队（`affiliated` true → false）／入队（反向）
    if (p.affiliated && !q.affiliated) out.push({ kind: 'person-leave', id: id, name: q.name });
    else if (!p.affiliated && q.affiliated) out.push({ kind: 'person-join', id: id, name: q.name });
    // 状态变了（正常 → 重伤 / 濒死 / 死亡 / 疯狂）＝ 那一档的演出
    if (p.status !== q.status) out.push({ kind: 'person-status', id: id, name: q.name, from: p.status, to: q.status });
  }

  // ── ② 物：进出（**获得**与**失去/消耗**同一条路，只是演出不同）────
  //    ⚠️ 比的是**所有人在带的所有东西**，不只是玩家的 ——
  //    LLM 给玩家新造一件东西时它落在玩家名下，但那是在"任何人的 items"里。
  const bi = indexItems(before), ai = indexItems(after);
  // ⚠️⚠️ 2026-10-08：`indexItems` 只看**长在人身上的**（me/people 的 items）——
  //    **手牌区（holder=null）的东西它看不见**，两处误判，都用顶层 `view.items`
  //    （全量表 · holder 权威）交叉校正：
  //    · **注册漏报**：LLM 注册新物品直接落手牌区（不在任何人身上）⇒ indexItems
  //      收不到 ⇒「结算卡→手牌区」的飞牌（用户裁定）永远不触发 ⇒ 顶层表补发；
  //    · **摘下误伤**：从人身上摘回手牌区 ⇒ indexItems 表现为"人身上消失"⇒ 误走
  //      item-out（撕毁/灰飞）。用户裁定：**摘回手牌区不演**（卡牌出现在手牌区
  //      本身就是提醒）⇒ 顶层表还在、无人携带、未消耗 ⇒ 静默跳过。
  const bTop = new Map(arr(before && before.items).filter(Boolean).map((x) => [x.id, x]));
  const aTop = arr(after && after.items).filter(Boolean);
  // 顶层表新出现的 id（LLM 注册 ⇒ 落手牌区或直接给人）⇒ item-in（飞进手牌区/主人卡）
  for (const x of aTop) {
    if (bTop.has(x.id)) continue;
    out.push({ kind: 'item-in', id: x.id, name: x.name, itemKind: x.kind, holder: x.holder ?? null });
  }
  for (const k of Object.keys(ai)) {
    if (bi[k]) continue;
    // 新"长到人身上"：顶层表里**已有**的 ⇒ 装备（手牌区→人）⇒ 从结算卡飞到主人卡；
    // 顶层表里**没有**的 ⇒ 上一条已发过（LLM 直接给人），不重复。
    if (!bTop.has(k)) continue;
    out.push({ kind: 'item-in', id: k, name: ai[k].name, itemKind: ai[k].kind, holder: ai[k].holder });
  }
  for (const k of Object.keys(bi)) {
    if (!ai[k]) {
      // ⚠️ 交叉验证：顶层表里还在、无人携带、未消耗 ⇒ 是**摘回手牌区**，不演；
      //    真消失（消耗/失去/离册）才走撕毁/灰飞。
      // ⚠️ 演出分两档：**用过**（用掉的）与**失去**（被毁/被抢/落水）。
      //    规格里裁定的区分：用过 ＝ 撕毁；失去 ＝ 灰掉飞走。
      //    ⚠️⚠️ **判据是 `kind === '消耗品'`**（2026-10-06 改）——
      //    此前靠**日志正则**（「×× 用掉了 ××」）判，那条路**脆**：LLM 改一句措辞
      //    就认不出，用掉的东西会被演成"被抢了"。
      //    ⚠️ 而 `indexItems` **本来就把 `kind` 存下来了**（它是身份骨架 · 永不变），
      //    且消耗与否的**唯一口径**就是它（`rules/ability.ts·isOneShot` 由 kind 推导）⇒
      //    **同一份判据，零新增数据、零解析**。
      //    ⇒ 连带**删掉了**那个靠日志正则的 `markUsedFromLog`（连同 `usedItemNames`）。
      const still = aTop.find((x) => x.id === k);
      if (still && !still.holder && !still.consumed) continue;
      out.push({
        kind: 'item-out', id: k, name: bi[k].name,
        used: isOneShotKind(bi[k].kind),   // ⚠️ 与小卡那个「尽」**共用同一个函数**
      });
    } else if (bi[k].holder !== ai[k].holder && ai[k].holder) {
      // ⚠️⚠️ 2026-10-08（用户裁定）：**摘回手牌区（新主人为空）不演** ——
      //    玩家自己的拖拽（give to:''）与 LLM 的收回都一样：卡牌出现在手牌区
      //    本身就是提醒，再飞一遍是重复打扰。装备给人（新主人有值）照演。
      // 换了主人 ＝ 转移（借出）—— 也要看得见
      out.push({ kind: 'item-move', id: k, name: ai[k].name, from: bi[k].holder, to: ai[k].holder });
    }
  }

  // ── ③ 数：逐个读数 ─────────────────────────────────────────────
  //    ⚠️ **每个下属的 HP/SAN 也在这里** —— 这是手抄做不到的那一处。
  for (const m of numDiffs(before, after)) out.push(m);

  return out;
}

/**
 * **演一遍这份清单**（2026-10-06）。
 *
 * ⚠️ **在 `render()` 之后调**（那时 DOM 已是新的，飞行才能找到落点）。
 * ⚠️ **只看不写**：任何一步找不到元素就**跳过那一条**，绝不影响其他条、
 *    更不影响游戏（清单不参与判定，见上面那条铁律）。
 * ⚠️ **一次动作里所有演出同时排**（用户裁定「这些动画应当可以同时出现」）
 *    ⇒ 逐条**错开 70ms** 起演，而不是排队等前一条演完。
 *    错开是为了"眼睛能跟上一条"，不是"限制同时"。
 * ⚠️ 飞行替身一律 `position:fixed` ＋ 高 `z-index`（用户裁定：
 *    「事件在处理时，手牌区、声望区、未入队的人物区图层都不会隐藏，
 *    这样动画可以正常显示」）⇒ **走最上层，不被任何中间层遮挡**。
 */
function playChanges(changes){
  if (!changes || !changes.length) return;
  const v = S && S.view;
  if (!v) return;
  let i = 0;
  for (const c of changes) {
    const delay = 70 * i;
    i++;
    try {
      switch (c.kind) {
        case 'person-in':   // 新人出现（LLM 造的）⇒ 从画布正中浮起
          at(delay, function () { flyInPerson(c); }); break;
        case 'person-out':  // 离册（罕见）⇒ 灰掉飞走
          at(delay, function () { flyAwayGone(c); }); break;
        case 'person-leave':// 离队 ⇒ **飞到未入队区**（⚠️ 不是变灰：他还能拉回来）
          at(delay, function () { flyLeave(c); }); break;
        case 'person-join': // 入队 ⇒ 从未入队区飞回卡带
          at(delay, function () { flyJoin(c); }); break;
        case 'person-status': // 状态变了（重伤/濒死/死亡/疯狂）⇒ 就地亮一下
          at(delay, function () { flashPerson(c); }); break;
        case 'item-in':     // **获得**（用户裁定：物品获得也要动画）
          at(delay, function () { flyInItem(c); }); break;
        case 'item-out':    // 消耗 ＝ 撕毁 ／ 失去 ＝ 灰掉飞走
          at(delay, function () { c.used ? tearItem(c) : flyAwayItem(c); }); break;
        case 'item-move':   // 转移（借出/收回）⇒ 小方块飞到新主人身上
          at(delay, function () { flyMoveItem(c); }); break;
        case 'num':         // 数值 ⇒ 那处亮一下 ＋ 数字滚动
          at(delay, function () { flashNum(c); }); break;
        default: break;     // 未知种类静默跳过（清单格式变了也不该炸）
      }
    } catch (e) { /* ⚠️ 演出失败一律吞掉 —— 它是装饰，不是功能 */ }
  }
}

/** 延后 `ms` 毫秒执行（`setTimeout` 的薄封装，让上面那串读起来是一句句的） */
function at(ms, fn){ setTimeout(fn, ms); }

/** 找一个人的卡（`.hcard[data-id=…]`）；找不到返回 null */
function cardOfPerson(id){
  const e = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  return document.querySelector('.hcard[data-id="' + e + '"]');
}

/** 找一件物的卡（人或物卡上那张都算）；找不到返回 null */
function cardOfItem(id){
  const e = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  return document.querySelector('.hcard[data-id="' + e + '"]');
}

/**
 * **落点在折叠区 / 屏幕外时的那句兜底提示**（2026-10-06 · 用户裁定
 * 「避免静默的状态变化」的延伸）。
 *
 * ⚠️ **为什么需要它**：变化发生在**收着**的东西上时（尚未入队的人、
 *    折叠区里的物品），那个元素**不在 DOM 里**（折叠是渲染时才不画的）
 *    ⇒ 飞行没有起终点 ⇒ 观众什么也没看到。
 *    ⚠️ 而"什么也没看到"正是这整套机制要消灭的那件事 ⇒
 *    **落点找不到时不能说"没有"**，要说"刚才那件事发生了什么"。
 * ⇒ 一枚**屏幕中央的小提示**，1.6 秒后自己走掉。
 *    不做历史、不给关闭按钮（用户裁定「就淡出」）。
 */
function toast(c, ms){
  const el = document.createElement('div');
  el.className = 'chgtoasts';
  // ⚠️ 一次动作可能有**多条**落点找不到 ⇒ 合并成一条（用户裁定过一次"合并同类"）
  el.textContent = c;
  document.body.appendChild(el);
  // ⚠️ 2026-10-08：`ms` 可选 —— 默认还是 1.6 秒（用户裁定「就淡出」），
  //    新人物出现那条要念完一句话（「你可以在尚未入队区域查看」）⇒ 用户点名 3 秒。
  setTimeout(function () {
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
  }, ms || 1600);
}

/**
 * 「欲望面板首次自动弹出」的左侧引导 toast（2026-10-08 用户第 3 条，**3 秒**）。
 * ⚠️ 只在 `render()` 末尾调用 —— 那时 `#modal`（`.sheetmode` 的欲望面板）已在 DOM 里，
 *   实量它的左缘 ⇒ toast 贴在**弹窗左侧 18px**（`right = 视口宽 − modal左缘 + 18`）。
 * ⚠️ 宽度自适应：左侧那条（让给 `.mapcorner` 的）不够 520px 就**收缩**（`r.left − 38`），
 *   保底 180px —— 宁可窄一点也不许溢出屏幕左沿。
 */
function desireIntroToast(){
  const m = $('modal');
  if (!m) return;
  const r = m.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'chgtoasts desirehint';
  el.style.maxWidth = Math.max(180, r.left - 38) + 'px';
  el.style.right = (window.innerWidth - r.left + 18) + 'px';
  el.style.top = Math.max(64, r.top + 8) + 'px';
  el.textContent = '这是你本局的欲望界面，也是你让塞兰国迎来大变的决心！请仔细查看面板，努力在接下来的日子里获取凭证、增长欲念值吧！';
  document.body.appendChild(el);
  setTimeout(function () {
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
  }, 3000);
}

/**
 * 造一个**飞行替身**（`position:fixed`，走最上层）。
 * @param from 起点 `{left, top, width, height}`（可空 ＝ 从屏幕边缘外飞入）
 * @param to 终点同款
 * @param cls 替身额外的 class（决定长什么样）
 * @param text 替身上的字
 * @param ms 飞行时长
 */
function spawnFly(from, to, cls, text, ms){
  const f = document.createElement('div');
  f.className = 'fly ' + cls;
  f.textContent = text || '';
  const w = Math.max(24, Math.min(64, (to && to.width) || 40));
  f.style.width = w + 'px';
  f.style.height = (to && to.height ? Math.max(24, to.height) : w * 1.4) + 'px';
  const x0 = (from ? from.left + from.width / 2 : window.innerWidth + 40) - w / 2;
  const y0 = (from ? from.top + from.height / 2 : -40) - f.style.height.replace('px', '') / 2;
  const x1 = (to ? to.left + to.width / 2 : window.innerWidth / 2) - w / 2;
  const y1 = (to ? to.top + to.height / 2 : window.innerHeight / 2) - f.style.height.replace('px', '') / 2;
  f.style.left = x0 + 'px';
  f.style.top = y0 + 'px';
  f.style.setProperty('--dx', (x1 - x0) + 'px');
  f.style.setProperty('--dy', (y1 - y0) + 'px');
  f.style.animationDuration = (ms || 900) + 'ms';
  document.body.appendChild(f);
  setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, (ms || 900) + 80);
  return f;
}

/** 读一个元素的矩形（`null` 元素返回 `null` 而不是抛） */
function rectOf(el){ return el ? el.getBoundingClientRect() : null; }

/**
 * **结算卡的矩形**（2026-10-08 · 用户点名「卡牌从结算卡飞到手牌区」的起点）。
 *
 * ⚠️ 只在结算界面**真的开着**时给矩形：`#overlay` 带着 `hidden`（`display:none`）时
 *    `getBoundingClientRect` 全是 0 —— 从 (0,0) 飞过来等于"从左上角凭空冒出"，
 *    比从屏幕边缘飞入还难看。⇒ 那时回退 `null`（＝屏幕右缘外飞入，老行为）。
 */
function settleRect(){
  const ov = document.getElementById('overlay');
  const m = document.getElementById('modal');
  if (!ov || !m || ov.classList.contains('hidden')) return null;
  const r = m.getBoundingClientRect();
  return (r && r.width > 0 && r.height > 0) ? r : null;
}

