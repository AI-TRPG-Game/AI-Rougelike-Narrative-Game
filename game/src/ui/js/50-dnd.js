// ── 拖拽（C 轮）─────────────────────────────────────────────────
// 三步：按下 → 位移超过阈值才"起拖" → 松手看落在哪一格。
// ⚠️ 判据全部与点选共用（见文件顶上那一段声明），这里**不新增任何规则**。
/**
 * 按 id 找出**这条事件**（`canDropOn` 要读它的 `dispatchable`）。
 * ⚠️ 事件散在两池里（`todo` 待处理 / `waiting` 处理中），而三格 `data-ev` 两种都可能出现 ——
 *    只查 `todo` 的话，一张「在办」的卡展开后拖东西进去会一律判 false（静默失灵）。
 * ⚠️ 找不到就返回 `null`（调用方拒），**不猜**：一条 id 对不上的事件不该被当成"两者皆可"。
 */
function eventOf(id){
  return arr(S && S.view && S.view.todo).concat(arr(S && S.view && S.view.waiting))
    .find((e) => e.id === id) || null;
}

/** 这一格接不接这件东西 —— 答「**放不放得进**」；`who` 那一格与点选共用 `canDispatchTo` */
/** 手上金币（`S.view` 可能为空 —— 标题屏与刚开局的瞬间） */
/** 人 id → 名字（取回时要说"取回了他"，不能报一串 id） */
function nameOfId(id){
  if (id === (S.view && S.view.me && S.view.me.id)) return '我';
  const f = arr(S && S.view && S.view.people).find((x) => x.id === id);
  return f ? f.name : id;
}

// ⚠️⚠️ 2026-10-07（用户裁定）：**金币计算永远是串行的** —— 事件台上垫了多少，
// 手牌（与顶栏）立马扣多少；点 × / 拖回 ⇒ 原额立刻回来。真正的扣账在 arrange
// 提交那一刻由服务端做，所以**成功回调里必须把那件事的 picks 清掉**（见 arrange
// 分支的注释）—— 否则"已扣过的账"再被 `placedGold()` 减一次 = 凭空少钱。
function placedGold(){
  let n = 0;
  for (const id in picks) {
    // ⚠️⚠️ 2026-10-07（用户报告"吞金币"）：**只数还没交出去的台面**。
    //   病灶：`commit`（✔）成功后 `picks[evId]` **刻意不清**（回看台要显示当时的摆法，
    //   见 commit 分支那条注释）⇒ 里头的 `gold` 也留着；而这一笔钱服务端在提交那一刻
    //   **已经真扣**（`view.gold` 已反映）⇒ `haveGold = view.gold − placedGold` 把它
    //   **再减一次** ⇒ 手牌金币卡凭空少一截（事件了结前一直少，读起来就是"吞金币"）。
    //   ⇒ 判据：事件已离开「待处理」（处理中/揭晓待办/已结算）⇒ 它台面上的钱
    //     **不再参与净额**（回看台上的"已垫 X 金"照显示 —— 那是展示，不是扣款）。
    const ev = eventOf(id);
    if (!ev || ev.status !== '待处理') continue;
    n += Math.max(0, (picks[id] && picks[id].gold) || 0);
  }
  return n;
}
function haveGold(){ return S && S.view ? Math.max(0, (S.view.gold || 0) - placedGold()) : 0; }

/**
 * 在某个卡槽上**闪一句话**（2026-10-05 · 金币拖拽的第 ① 档用）。
 *
 * ⚠️ 为什么不弹 toast：toast 是**全局**的，而这件事是**这一格**的 ——
 *    玩家此刻的眼睛盯着钱格，不盯着屏幕顶上一条飘过去的字。
 * ⚠️ 用完即清（1200ms）：它是一次性反馈，不该在槽上留疤。
 */
function flashSlot(slot, text){
  if (!slot) return;
  let f = slot.querySelector('.slotflash');
  if (!f) {
    f = document.createElement('div');
    f.className = 'slotflash';
    slot.appendChild(f);
  }
  f.textContent = text;
  setTimeout(function () { if (f && f.parentNode) f.parentNode.removeChild(f); }, 1200);
}

// ⚠️ 2026-10-07 用户裁定：「删掉这个奇怪的携带特效」——
//    旧的 markCarried（22px 小方块从源卡缩着飞到目标人卡）整函数已删，
//    连带 `.carryfly` / `@keyframes carryFly` / `.hcard.carried-in` 三段 CSS。
//    交出去之后 `api()` 里的 `render()` 重画一遍就是全部反馈：卡带少一张、
//    `@n` 变一个数、详情页绿槽挪位 —— 事实本身就够清楚。

/**
 * 这件东西能不能交给（或从）那个人（2026-10-06）。
 *
 * ⚠️ **判据全部来自 view**，与服务端 `/api/give` 里那道闸门⑤ **同一份数据**
 *    （`view` 每人 `items` 与 `holder` 都是账本的投影）⇒ UI 置灰与服务端拒绝一致。
 *    ⚠️ 这里**不重算 `CARRY_CAP`**：服务端会用 `who.items.length` 再判一次，
 *    两处各写一份上限就会漂（我上一轮就是这么凭空造了一个字段）。
 *
 * @param itemId 物品 id
 * @param toWhom 目标人 id（`npc000` = 玩家自己 ＝ 收回）
 */
function canGiveTo(itemId, toWhom){
  const v = S && S.view;
  if (!v || !toWhom) return false;
  const who = toWhom === v.me.id ? v.me : arr(v.people).find((p) => p.id === toWhom);
  if (!who) return false;
  // ⚠️⚠️ 2026-10-06 补一个**漏掉的判据**：**未入队的人不收东西**。
  //    改前这里只判"他有没有满"，于是东西能拖给一个尚未入队的人 ——
  //    那是 `handCard` 的 `{noDrag}`（不给 `data-kind`）之外的**另一条漏洞**：
  //    他的卡不能当拖拽**源**，但**还能当落点**。
  //    ⚠️ 口径与 `卡槽与LLM分工.md` §1.2 那一行同源：
  //    「未入队的人**不给你东西**」—— 人没在你这边，装备就不进他的账。
  if (toWhom !== v.me.id && !who.affiliated) return false;
  // 物品必须**存在且没被消耗**
  // ⚠️ 2026-10-08（无人携带）：查**全量表** `v.items` —— 要给的东西可能还没在
  //    任何人身上（`holder=null`，就躺在手牌区）；旧查法（我 ＋ 各人名下拼起来）
  //    会把无人携带的误判成"不存在"。
  const it = arr(v.items).find((x) => x.id === itemId && !x.consumed);
  if (!it) return false;
  // 他已经拿着 ⇒ 这次点的是**取回**（收回自己）或**转移**（给第三个人），都合法
  const already = arr(who.items).some((x) => x.id === itemId);
  if (already) return true;
  // ⚠️ 上限：4 位（闸门 ⑤ 的 `CARRY_CAP`）—— 只在**加东西**时才算；
  //    收回／转移都**不会让他变满**，所以上面那一支已经 return 了。
  return arr(who.items).length < 4;
}

/** 这个人**此刻正站在**某个事件台/功能单的槽里吗？（页面态：`picks` / `fixPicks`） */
function personPlacedInDesk(pid){
  for (const id in picks) {
    const op = picks[id];
    if (op && arr(op.participants).indexOf(pid) >= 0) return true;
  }
  for (const fp in fixPicks) if (fixPicks[fp] === pid) return true;
  return false;
}

/** 有任何一件事**已垫了金币**吗？（事件台 `picks[*].gold` ＋ 功能单 `fixGold`） */
function goldPlacedAnywhere(){
  for (const id in picks) if (picks[id] && picks[id].gold > 0) return true;
  for (const fp in fixGold) if (fixGold[fp]) return true;
  return false;
}

function canDropOn(slot, src){
  if (!slot || !src) return false;
  const d = slot.dataset.drop;
  // ⚠️⚠️ 2026-10-08（用户裁定·**装备统一口径**＋**无人携带**）：物品卡从一个人身上
  //   拖下来时（holder 有值），**无论落到哪（包括落到另一个人身上）都不再自动装备给
  //   任何人** —— 唯一合法去向是**手牌区（摘下，`holder=null`）**。想给谁，先摘回
  //   手牌区，再**从手牌区的物品卡**拖到手牌区的人物卡 / 展开的人物卡上。
  //   ⇒ "手牌区的物品卡" ＝ **无人携带**（`!holder`）—— 卡带上的物卡就是它。
  //   ⇒ 无 `data-drop` 的落点只认两种：
  //     · **详情页物品槽**（`.islot`，带 `data-slotwho`）：
  //         同一个人名下 ⇒ 槽位换位（调生效优先级，原有功能）；
  //         手牌区的东西 ⇒ 装进他的槽（= 给他，统一路径）。
  //     · **卡级 `data-to-whom`**（手牌带人物卡 / 详情页人卡）：
  //       只有**手牌区的东西**能落（= 装备给那张卡的主人）；别人身上的东西落上来一律拒。
  if (d === undefined && slot.dataset.slotwho !== undefined) {
    if (src.kind !== 'item') return false;
    if (src.holder === slot.dataset.slotwho) return true;   // 同主 ⇒ 槽位换位
    return !src.holder && canGiveTo(src.id, slot.dataset.slotwho);
  }
  if (d === undefined && slot.dataset.toWhom !== undefined) {
    if (src.kind !== 'item') return false;
    return !src.holder && canGiveTo(src.id, slot.dataset.toWhom);
  }
  // ⚠️⚠️ 2026-10-07：固定功能卡（医馆疗伤 / 神殿净化）—— 只收**一个人**，
  //    判据与 `/api/restore` 服务端那道闸同源：已满（≥3）的不用去、剩余行动力
  //    不够点数的去不了、没入队/没了的不收。
  // ⚠️⚠️ 2026-10-07（用户裁定）：**整条手牌带都是「收回」的落点** ——
  //    卡槽里的物品要能拖回手牌区。此前只有「拖到某张卡的身上」一条路
  //    （`data-to-whom`），拖到带子空处 `dropHit` 为 null ⇒ 毫无反应，
  //    玩家以为"拖不回来"（用户原话：「上面的物品无法正常拖拽到手牌区」）。
  if (d === 'hand') {
    // ⚠️⚠️ 2026-10-07（用户第 1 条）：手牌带现在收**三种**「拿回来」——
    //   · 物卡：别人的东西收回自己（原有判据不动）；
    //   · 人卡：**事件台槽里已放的人** —— 拖回带子 ＝ 从那件事里取回（页面态）；
    //   · 金币：**金币槽里已垫的钱** —— 拖回带子 ＝ 取回垫金（页面态）。
    //   没被放置的人卡/金币拖回带子是无意义动作 ⇒ 亮"放不进"。
    if (src.kind === 'item') {
      // ⚠️ 2026-10-08（**无人携带**）：拖回手牌带 ＝ **摘下**（`holder=null`，
      //   不占任何人的携带位）—— 不管它现在在谁身上（含玩家自己那张卡）。
      //   已经没人拿着（就在手牌区）再拖回带子是无意义动作 ⇒ 亮"放不进"。
      return !!src.holder;
    }
    if (src.kind === 'person') {
      if (src.ev) return true;                       // 从事件台槽里抓起来的那位 —— 一定可取回
      // 手牌上抓的人：只有他已经站在某个台/功能单里才"取回"得有意义
      return personPlacedInDesk(src.id);
    }
    if (src.kind === 'gold') return !!src.ev || goldPlacedAnywhere();
    return false;
  }
  if (d === 'fix') {
    if (src.kind !== 'person') return false;
    const v = S.view;
    const per = src.id === v.me.id ? v.me : arr(v.people).find((x) => x.id === src.id);
    if (!per) return false;
    if (isGone(per)) return false;
    if (src.id !== v.me.id && !per.affiliated) return false;
    const place = slot.dataset.fix;
    const field = place === '医馆' ? 'hp' : 'san';
    if ((per[field] ?? 3) >= 3) return false;   // 已满 ⇒ 不需要治疗
    const pts = place === '医馆' ? 3 : 2;       // 医馆 3 点 · 神殿 2 点（与 RESTORE_SPEC 同源）
    const left = src.id === v.me.id ? v.remaining : (per.ap ?? 0);
    return left >= pts;
  }
  // ⚠️⚠️ 2026-10-07（用户裁定·第二批）：功能单的**定额金币槽** ——
  //    拖金币卡进来 = 按定额记下（不是自由垫数：诊金是明码标价）。
  //    ⚠️ 金币是**池**，槽里"垫了"只是页面态（`fixGold`），卡带上的金币卡**不消失**
  //      —— 与事件钱槽同一语义（`picks[ev].gold` 也不从手上收走那张卡）。
  if (d === 'fixgold') {
    if (src.kind !== 'gold') return false;
    return (S.view.gold ?? 0) >= FIX_SPECS[slot.dataset.fix].cost;
  }
  if (d === 'who') {
    // ⚠️ 2026-10-05 补：这一支此前只判 `src.kind === 'person'`、**不判这个人派不派得动**
    //    ⇒ 拖一张**未入队**的人卡进「人」槽，它就进了 `participants`：UI 上看着成功了，
    //    一直挂到点「派人去」才被服务端闸门 ③ 拒（"我拖进去了，怎么提交就报错"）。
    //    点选那一支一直判了 `available`（复选框是 `disabled` 的）⇒ **两条路原本不一致**。
    //    现在两条都走 `canDispatchTo` —— 判据只有一处。
    // ⚠️ 玩家本人**也**能拖进来（他左栏那张「三王子」卡同样带 `data-kind="person"`）⇒
    //    这里不能把 `affiliated` 那一刀砍到他身上：他不是下属，但「我亲自」这一行是合法的。
    //    他能不能上，仍由 `canSelf`（`dispatchable === '仅派遣'` ⇒ 亲自去不了）那一支管。
    const ev = eventOf(slot.dataset.ev);
    if (!ev) return false;
    // ⚠️⚠️ 清单第 1 条（持久化）：**处理中**的事件有一个只读回看台（cardHtml(e,true)）——
    //   它的槽只是**展示**玩家当时的输入，不再收卡（拖过去亮"放不进"，
    //   松手也进不了账）。可操作的只有「待处理」那一份处理台。
    if (ev.status !== '待处理') return false;
    // ⚠️⚠️ 2026-10-05（用户裁定第 3 条）：**物品槽取消** —— 物品改成「**拖到人身上**」。
    //    理由（用户原话）：「物品没有卡槽直接拖到人物卡上」＋「物品卡有个特效
    //    卡片缩小插入到人物卡上」—— 这条路把"谁带什么"变成**看得见的一层关系**，
    //    而"事件卡里一个孤零零的物品下拉框"表达不了"这东西归谁"。
    // ⚠️⚠️ 2026-10-08（用户裁定·**装备统一口径**）：这一格**改回只收人卡**。
    //    此前物卡落到人位 ＝ 交给这次去的人（`canGiveTo`）—— 但它与"从人身上
    //    拖下来的东西只能回手牌区"的新口径打架：同一个格子，从手牌拖来是"给他"，
    //    从别人身上拖来是"转交"，玩家分不出也不该分。⇒ 装备**只有一条路**：
    //    先收回手牌区，再**从手牌的物品卡**拖到人物卡上。落到这里的物卡一律拒
    //    （原因见 `dropBlockReason`）。
    //    注：`pointerup` 的 who 分支把 `src.id` 塞进 `participants` —— 物卡过不了
    //    上面的 `src.kind !== 'person'` 闸，不会再有"物件当人派出去"的暗门。
    // ⚠️⚠️ 2026-10-05：**这里刻意不接物卡** —— 见 `canDropOn` 顶上那段。
    //    用户裁定的方向是「物品拖到人身上」（改变**携带关系**），
    //    而携带关系住在 `Person.items`（账本字段），**UI 侧没有写它的通路**：
    //      · `usedItemId` 是「这次用哪件」的**单值**叙事指定，不改携带；
    //      · 闸门 ⑤（`CARRY_CAP = 4`）只**校验**"至多 4 件"，不提供"装填"入口
    //        （`卡槽与LLM分工.md` §1.2 原话：「判据在，但**生产路径无入口**」）。
    //    ⇒ 物品要真能"拖到人身上"，得先在规则侧开一条 `/api/give`（装填/取下）。
    //      那是账本写入（`Person.items` ＋ `Item.holder` 两处），
    //      **本轮不做**（要先定"取下"与"消耗"怎么算）—— 见交付说明。
    if (src.kind !== 'person') return false;
    // ⚠️ 2026-10-05：人形改成四个卡位 ⇒ 这里要拦**两种满**：
    //    ① 槽满（4 个都有人了）—— 用户裁定「统一为 4 个槽」；
    //    ② 超这条事件的上限（`max_people`，LLM 给 · 闸门 ⑦ 判那个数）。
    //    ⚠️ **两条独立算**（已在 `卡槽与LLM分工.md` §2.3 裁定「各自独立算」）：
    //       4 是系统给的槽数，`max_people` 是这条事件的性质 —— 谁更小听谁的。
    //    ⚠️ 已经在这条里的人**可以再点一下取回来** ⇒ 重复放自己不算"超上限"。
    const picked = arr(pickOf(slot.dataset.ev).participants);
    if (picked.indexOf(src.id) >= 0) return true;
    // ⚠️⚠️ 2026-10-07（用户报告"卡槽只能放某个人却让玩家一遍遍试"）：**必放位只收那位本人**。
    //   此前拖拽**不判** `required_person`（只有 ✔ 的 `needOk` 在判）⇒ 把别人放进 ① 号位
    //   也"放得上"，可 ✔ 永远灰着 —— 玩家只能一个个试。现在：
    //   「非 X 不可」且他还没进来时，**① 号位只收 X**（别人拖进去亮出原因，见
    //   `dropBlockReason`）；②③④ 照常收别人。他进来之后 ① 恢复普通位。
    //   ⚠️ 点选那一路（复选框）不受此限 —— 那是按名单勾人，`needOk` 照旧把关。
    //   ⚠️⚠️ 2026-10-08（用户报告"所有事件卡都放不上任何人物卡"的真凶）：
    //     这里原本写的是 **`e.requiredPerson`** —— 而本函数里定义的变量叫 **`ev`**，
    //     `e` 根本不存在 ⇒ 每次拖人卡进事件槽都在这一行抛 `ReferenceError`，
    //     被 pointerup 的 try/finally **静默吞掉**（不落卡、不闪原因、控制台才有红字）
    //     ⇒ **所有事件槽对所有人物卡一律失败**。改前先有 `ev`（7984 行），笔误而已。
    if (ev.requiredPerson && slot.dataset.sloti === '0' &&
        picked.indexOf(ev.requiredPerson.id) < 0 && src.id !== ev.requiredPerson.id) {
      return false;
    }
    if (picked.length >= 4) return false;
    if (picked.length >= (ev.max_people || 0)) return false;
    if (src.id === S.view.me.id) return ev.dispatchable !== '仅派遣';
    return canDispatchTo(arr(S.view.people).find((x) => x.id === src.id), ev);
  }
  if (d === 'voucher') {
    // ⚠️⚠️ 2026-10-06 清单第 4B.4 条：凭证卡**只能拖进「你的欲望」那一屏的四行卡位**。
    //   三条判据（缺一条就会出现"我明明拖进去了怎么没反应"）：
    //     ① 源必须是 **voucher 卡**（人卡/物卡/金币拖进凭证槽一律拒）；
    //     ② **维度必须与那一行相同**（成果的卡进不了手段那一行）——
    //        与"物品只能拖到人身上"同一条纪律：格子有自己的类别。
    //     ③ 那一行**还没放满、且这一格还空着**。
    if (src.kind !== 'voucher') return false;
    if (src.dim !== slot.dataset.vdim) return false;
    const vi = Number(slot.dataset.vi);
    const st = vPick()[slot.dataset.vdim];
    if (!Array.isArray(st) || vi < 0 || vi >= st.length) return false;
    // ⚠️ 再拖一次**同一张进同一个空位** ＝ 幂等（放进去），不是"再放一遍"
    if (st[vi] === src.id) return true;
    return st[vi] === '';
  }
  if (d === 'gold') {
    // ⚠️ 2026-10-05：钱格**接金币卡了**（用户裁定「金币也统一为卡牌」）。
    //    ⚠️ 它**不查实体表**（金币不是实体，`view.gold` 只是一个数）——
    //       这一点与人物/物品两支根本不同，别照抄它们的形状。
    //    ⚠️ **手上没金币时不可拖**：拖了也是 0（那次拖拽不会有任何效果），
    //       而一次"点了没反应"的拖拽比"这一格不接受它"更让人困惑。
    //    ⚠️ 「处理中」的回看台同样不收（与 who 那一支同一条纪律）。
    if (slot.dataset.ev) {
      const gev = eventOf(slot.dataset.ev);
      if (gev && gev.status !== '待处理') return false;
    }
    return src.kind === 'gold' && (S.view ? (S.view.gold || 0) : 0) > 0;
  }
  return false;
}

/**
 * **这一格为什么不收这张卡**（2026-10-07 用户报告"有的时候谁都放不上去，很奇怪"）。
 *
 * ⚠️ 病根不是某一个判据错了，是**拒绝发生时一句话都不说**：
 *   `canDropOn` 返回 false ⇒ 槽亮一下红、松手毫无反应 ⇒ 玩家只能把手里每张卡
 *   都试一遍（"一遍遍试"的原话就是它）。⇒ 拒绝的那一下**在槽上闪人话原因**
 *   （`flashSlot`，与金币槽取回同一套视觉）。判据与 `canDropOn` **同源同序**
 *   （第一句命中的就是真正卡住的那条），但不改判据本身 —— 只是把它翻译成人话。
 */
function dropBlockReason(slot, src){
  if (!slot || !src) return '';
  const d = slot.dataset.drop;
  if (d === 'who') {
    const ev = eventOf(slot.dataset.ev);
    if (!ev) return '';
    if (ev.status !== '待处理') return '这件事已经交出去了';
    if (src.kind === 'item') return '带东西给他：先拖回手牌区，再从手牌区的物品卡拖到他身上';
    if (src.kind !== 'person') return '这一格只收人卡';
    const picked = arr(pickOf(slot.dataset.ev).participants);
    if (picked.indexOf(src.id) >= 0) return '';
    if (ev.requiredPerson && slot.dataset.sloti === '0' &&
        picked.indexOf(ev.requiredPerson.id) < 0 && src.id !== ev.requiredPerson.id) {
      return '① 号位是非 ' + ev.requiredPerson.name + ' 不可的位';
    }
    if (picked.length >= 4) return '四个位都满了';
    if (picked.length >= (ev.max_people || 0)) return '这件事至多 ' + ev.max_people + ' 人';
    if (src.id === S.view.me.id) return '这件事只派人去，你亲自去不了';
    const p = arr(S.view.people).find((x) => x.id === src.id);
    if (!p) return '';
    if (!p.affiliated) return p.name + ' 还没站到你这边';
    if (p.hp <= 1) return p.name + ' 只剩一口气';
    if (p.san <= 1) return p.name + ' SAN 见底';
    if (p.away) return p.name + ' 还在办别的事、人没回来';
    return p.name + ' 今天调不动';
  }
  if (d === 'fix') return '他不需要（或今天去不了）' + slot.dataset.fix;
  if (d === 'hand') {
    // ⚠️ 2026-10-08（**无人携带**）：摘下没有携带位上限（手牌区不是槽），
    //   拒绝只剩一种情形 —— 它本来就没在任何人身上（就在手牌区）。
    if (src.kind === 'item') {
      if (!src.holder) return '这件没有装备在任何人身上 —— 它就在手牌区';
      return '';
    }
    return '这张没有被放出去，收不回';
  }
  // ⚠️ 2026-10-08（装备统一口径＋无人携带）：卡级 / 槽级落点（无 `data-drop`）被拒
  //   也要说人话 —— 最常见的误操作就是"把别人身上的东西直接往第三个人身上放"。
  //   "手牌区的物品卡" ＝ 无人携带（`!holder`）；谁身上的（含玩家自己那张卡）
  //   都得先摘回手牌区。
  if (d === undefined && slot.dataset.slotwho !== undefined) {
    if (src.kind !== 'item') return '这一格只收物品卡';
    if (src.holder) return '先拖回手牌区，再从手牌区的物品卡拖进来';
    return '他带不动了（身上已满 / 这不是你的东西）';
  }
  if (d === undefined && slot.dataset.toWhom !== undefined) {
    if (src.kind !== 'item') return '装备物品要从手牌区的物品卡拖起';
    if (src.holder) return '先拖回手牌区，再从手牌区的物品卡拖给要给的人';
    return '他带不动了（身上已满 / 这不是你的东西）';
  }
  return '';
}

/**
 * **金币卡拖到钱格上时，该过去多少枚**（2026-10-05 用户裁定的三条规则）。
 *
 * 规则原文：「默认拖拽出**最小数量的金币**（**0 则无效果，不足则全部拖拽过来**），
 * **再拖拽的话默认 +1**」。
 *
 * ⚠️ 三档的判据：
 *   ① `min_gold === 0`（没标最低投入）⇒ **本次无效果**，钱格不涨。
 *      为什么不是"就 +1"：没要求垫钱时，玩家拖金币是想**看**这件事要多少钱，
 *      不是想**付**钱。自动 +1 会在他想看的时候扣他的钱（下一格就要付了）。
 *   ② `min_gold > 0` 且 `已垫 = 0` ⇒ 过去 `min(min_gold, 手上)`。
 *      **不足则全部**：差额他补不上，让他看见"差多少"比让拖拽静默失败好。
 *   ③ 已垫过 ⇒ **+1**。倍数没有意义（一次只办一件事），而"一枚一枚加"最直白。
 *
 * @returns 本次要过去多少枚（0 = 无效果）
 */
function goldDropAmount(evId){
  const ev = eventOf(evId);
  if (!ev) return 0;
  const sel = pickOf(evId);
  // ⚠️ 2026-10-07（串行金币）：`have` = **手上净额**（总账减掉所有桌上已垫的，
  //   含别的事件）—— 用总账的话，两件事的台面一起开就能垫出超过持有数的钱。
  const have = haveGold();
  const need = Math.max(0, ev.min_gold || 0);
  if (need === 0) return 0;                                  // ① 没标最低 ⇒ 无效果
  if (sel.gold <= 0) return Math.min(need, have);             // ② 第一次 ⇒ 最少（或全部）
  return have > 0 ? 1 : 0;                                    // ③ 之后每次 +1（手上还有才加）
}

/**
 * 造"跟在指针上的那张卡" —— **克隆源卡本身**，不是一条文字标签。
 *
 * ⚠️ 为什么克隆而不是新建一个 div：玩家拖的是**这张卡**，预览就该是这张卡
 *    （2026-09-23 用户：「拖出来的根本不是一个卡牌」）。照抄外形还有个白赚的好处 ——
 *    以后改卡面样式，拖拽预览**自动跟着变**，不必维护第二份样式（本项目最怕的"两处实现"）。
 * ⚠️ 克隆体必须**摘掉 `data-kind` / `data-id` / 所有 `data-act`**：它留在 DOM 里，
 *    带着这些标记就可能被事件处理器当成"真的那张卡"（`pointerdown` 找的正是
 *    `.pcard[data-kind]`）。`pointer-events:none` 是第二道防线 —— 不把"伪卡"的
 *    可识别标记留在页面上，是第一道。
 */
function makeGhost(srcEl){
  const g = srcEl.cloneNode(true);
  g.classList.add('dragghost');
  g.removeAttribute('data-kind');
  g.removeAttribute('data-id');
  const marked = g.querySelectorAll('[data-act]');
  for (let i = 0; i < marked.length; i++) marked[i].removeAttribute('data-act');
  return g;
}

/** 收尾：清高亮 ＋ 摘掉幽灵 ＋ 退出拖拽态。**幂等**（没在拖也能安全调用） */
function dragEnd(){
  if (ghost) { ghost.remove(); ghost = null; }
  const lit = document.querySelectorAll('.slotbox.dropok,.slotbox.dropno');
  for (let i = 0; i < lit.length; i++) lit[i].classList.remove('dropok', 'dropno');
  document.body.classList.remove('dragging');
  // ⚠️ 清单第 1 条：源卡"回到"手牌区（拖放成功时随后而来的 render() 本来就会重画，
  //   它不在了；失败松手时这一行把他还回来）。
  if (dragEl) dragEl.classList.remove('dragsrc');
  dropHit = null;
  dragEl = null;
}

document.addEventListener('pointerdown', (ev) => {
  // ⚠️ 源 ＝ **三种**卡：底部手牌的人卡 / 物卡（`.hcard`，2026-05 布局重构新增），
  //    ＋ 左栏那两种（`.pcard` / `.icard`）。`data-kind` / `data-id` **本来就在卡上**
  //    （点开详情用的）⇒ 没为拖拽加属性。
  // ⚠️ **主角的卡同样在列**（`.hcard.me` 也带 `data-kind`）—— 用户裁定
  //    「主角也应当可以拖拽，待遇其实和其余下属差不多」⇒ 拖拽源**不按身份分**。
  // ⚠️⚠️ 2026-10-07（用户第 1 条）：**事件台槽里已放的那张卡也是源**
  //    （`.scard[data-kind]`，渲染处已补属性）——「拖到事件卡槽里的卡牌，
  //    还是无法直接拖回手牌区」的根因就是它不在源选择器里，抓都抓不起来。
  const card = ev.target.closest('.hcard[data-kind],.pcard[data-kind],.icard[data-kind],.scard[data-kind],.hg[data-kind]');
  if (!card) return;
  if (ev.target.closest('button')) return;                    // 卡里的「医」「祈」不参与拖拽
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;  // 只认左键（触摸上报的是 0）
  // 卡名：手牌用 `.hn`，左栏那两张用 `.nm` —— 幽灵上要印的是**人的名字**。
  const nm = card.querySelector('.hn') || card.querySelector('.nm') || card.querySelector('.sn');
  dragEl = card;
  // ⚠️⚠️ 2026-10-06 清单第 4B.4 条：凭证卡的标识在 **`data-vid`**（不是 `data-id`）——
  //   它是 `v:{dim}:{绑定id}` 这种带前缀的串（`VoucherRecord` 自己没有 id 字段），
  //   而其余卡一律用 `data-id` ⇒ 这里做一次回退，**不新建第二套取 id 的地方**。
  // ⚠️ `dim` 一并带上：`canDropOn` 的 voucher 那一支要判"这一行的类别对不对"。
  const theId = card.dataset.id || card.dataset.vid || '';
  // ⚠️ 2026-10-07：`holder` ＝ 这张物卡**现在在谁身上**（详情页卡槽里的物卡带它，
  //    手牌带上玩家自己的物卡不带 ⇒ 视作 `npc000`）——
  //    槽内换位那一支靠它分"同一个人槽内调顺序"和"交给另一个人"。
  // ⚠️ `ev` ＝ 金币从**哪件事**的金币槽被抓起来的（`data-ev`）——
  //    拖回手牌带时只退这一件事的垫金，不清别家。
  dragSrc = { kind: card.dataset.kind, id: theId, dim: card.dataset.vdim || '',
              // ⚠️ 2026-10-08（无人携带）：缺省改 '' ＝ 没在任何人身上（卡带物卡）——
              //   旧缺省 'npc000' 会把卡带物卡误记成"装备在玩家身上"
              //   （从自己卡上拖回手牌区被"已经在你手上了"顶回来 —— 实测翻车）。
              //   人物/金币拖拽从不读 holder，缺省只影响物卡。
              holder: card.dataset.holder !== undefined ? card.dataset.holder : '',
              ev: card.dataset.ev || '',
              name: (nm && nm.textContent) || card.dataset.name || theId || '',
              x: ev.clientX, y: ev.clientY };
  dragMoved = false;
});

document.addEventListener('pointermove', (ev) => {
  if (!dragSrc) return;
  if (!dragMoved) {
    // ⚠️ 阈值：不设它的话，整张卡的**点击**（点开详情）会被拖拽吃掉 —— 手指/鼠标总会抖一两个像素
    if (Math.abs(ev.clientX - dragSrc.x) < DRAG_MIN && Math.abs(ev.clientY - dragSrc.y) < DRAG_MIN) return;
    dragMoved = true;
    document.body.classList.add('dragging');
    // 幽灵 ＝ **源卡的克隆**（外形、当前勾选状态都跟着走）—— 见 `makeGhost`
    if (dragEl) {
      ghost = makeGhost(dragEl);
      document.body.appendChild(ghost);
      // ⚠️ 清单第 1 条：拖起来的那张卡**从手牌区消失**（`visibility` 保布局不跳）——
      //   卡只有一份：要么在手上，要么跟在指针上，不该两张同时在屏幕上。
      //   ⚠️ 类**加在克隆之后**（克隆体不带它），失败松手时由 `dragEnd` 摘掉。
      dragEl.classList.add('dragsrc');
    }
  }
  if (ghost) {
    ghost.style.left = (ev.clientX + 12) + 'px';
    ghost.style.top = (ev.clientY + 14) + 'px';
  }
  // ⚠️ `elementFromPoint` 命中的是**最上面**那个元素 —— 幽灵必须 `pointer-events:none`（见 CSS），
  //    否则它自己会把每一格都盖住，落点**永远是 null**。
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  // ⚠️ 2026-10-05：落点**优先认 `.pslot`（某一个具体的位）**，其次才退到整个 `[data-drop]` 槽。
  //    为什么：人槽里有 4 个位 ＋ 一堆别的内容，落在"人槽的标题上"也算放下会让人以为
  //    "整格都收"，而实际上收的是**某一个空位**。先找 `.pslot` 语义才准。
  //    ⚠️ 退到 `[data-drop]` 那一支**必须留着**：物格/钱格在某些状态下没有 `.pslot`
  //    （物品池为空时画的是提示块，钱格也可能是），那时整格都要能接。
  // ⚠️⚠️⚠️ 2026-10-06 修用户问题 10（「装备还是不能正常的通过拖拽在人物身上装备和卸下」）：
  //   落点候选**少了 `data-to-whom`（人卡/物卡名下那张）** ⇒ 物卡拖到人卡上时
  //   `under.closest('.pslot')` 与 `closest('[data-drop]')` **都返回 null**
  //   ⇒ `dropHit` 恒为 null ⇒ `pointerup` 里 `if (dropHit && …)` 整条不成立
  //   ⇒ **拖到任何人身上都没反应**（而拖到事件卡的「人」格是好的 —— 那个有 `.pslot`）。
  //   ⇒ 把 `data-to-whom` 补进候选（**第三个**）：它是「交给这张卡的主人」那条路。
  //   ⚠️ 顺序有意放在**最后**：`.pslot` 与 `[data-drop]` 语义更具体，优先认它们；
  //     `data-to-whom` 只是兜底（人物卡本身没有别的槽）。
  // ⚠️⚠️ 2026-10-07（用户裁定）：落点候选**第三位是「卡级 data-to-whom」**、
  //   **第四位才是 `[data-drop]`** —— 顺序不能反：
  //   手牌带整条挂了 `data-drop="hand"`（"拖回手牌区＝收回"），而带上的人卡
  //   自己带着 `data-to-whom`（"拖到他身上＝交给他"）。若先认 `[data-drop]`，
  //   `closest` 会先撞上**外层那条带** ⇒ 拖到 B 卡上会变成"收回自己"（实测翻车）。
  //   ⇒ 卡级语义更具体，先认它；带子只接**卡缝里**的落点。
  //   （事件台的 `.dia` 不受影响：它不是 `.hcard/.pcard/.icard`，认不到上一条。）
  //   ⚠️⚠️ 2026-10-07（用户第 1 条补）：**人卡/金币的拖回被卡"吞"了** ——
  //     从事件台槽里抓起的人卡拖回手牌带，落点常砸在带上**某张人物卡**上，
  //     卡级 `data-to-whom` 先被认走 ⇒ 变成"把人交给某人"（无此语义）⇒ 放不进。
  //     ⇒ 「交给某人」是**物卡专属**语义 ⇒ 只有物卡才走卡级那一档；
  //       人卡/金币直接落带子（整条带都是「取回」）。
  //   ⚠️⚠️ 2026-10-07（用户报告"从皮普身上拖东西收回，却自动装备到艾德里安身上"）：
  //     **卡级「交给」只认"我自己的东西"** —— 别人的东西往带上丢，落点常砸在带上
  //     **某张人物卡**上，卡级 `data-to-whom` 先被认走 ⇒ 变成"转交给那位"（实测翻车：
  //     想收回，东西却无声飞到了艾德里安身上）。⇒ 两半拆开：
  //       · **我持有的东西**（holder = 我）⇒ 卡级 ＝ 送人（原有功能不动）；
  //       · **别人身上的东西** ⇒ 只有落到**我自己的卡**上（data-to-whom = 我）才收，
  //         落到别的 NPC 卡上 = 意图不明 ⇒ 落穿到带子 ＝ **收回**（玩家口径：
  //         「拖到手牌区 ＝ 拿回来」，不许被半路截走）。
  //     直接皮普→艾德里安的转移仍可走事件台人位（.pslot 先认，不受影响）。
  //   ⚠️⚠️ 2026-10-08（用户裁定·**装备统一口径**＋**无人携带**）：
  //     物品卡**从人身上拖下来**（holder 有值，含玩家自己那张卡）时，**无论落到哪**
  //     都不许被任何卡级落点截走 —— 唯一去向是**手牌带（摘下，holder=null）**。
  //     "给出去"只能**从手牌区的物品卡**发起 ＝ **无人携带**（`!holder`）⇒
  //     卡级候选只认它；落到带上任何卡（包括别人的人物卡）都落穿到带子 ＝ 摘下。
  //     装备统一走：手牌区物卡 → 手牌人物卡 / 展开人物卡。
  const cardHit = under && under.closest('.hcard[data-to-whom],.pcard[data-to-whom],.icard[data-to-whom]');
  const t = under
    ? (under.closest('.pslot')
       || under.closest('.islot')
       || (dragSrc && dragSrc.kind === 'item' && !dragSrc.holder && cardHit
           ? cardHit
           : null)
       || under.closest('[data-drop]'))
    : null;
  if (t !== dropHit) {
    dropHit = t;
    const lit = document.querySelectorAll('.slotbox.dropok,.slotbox.dropno');
    for (let i = 0; i < lit.length; i++) lit[i].classList.remove('dropok', 'dropno');
    if (dropHit) dropHit.classList.add(canDropOn(dropHit, dragSrc) ? 'dropok' : 'dropno');
  }
});

// ⚠️ `async`：2026-10-06 起"放下"要**发请求**了（物卡 ⇒ `/api/give` 交给那个人）。
//    它是**整段唯一的异步落点** —— 后面那个物卡分支里 `await api(...)`，所以这个
//    监听器必须 async。⚠️ 不影响另外两条落点（人/钱只是改页面状态），它们在
//    `await` 之前就改完了，行为与从前一致。
document.addEventListener('pointerup', async () => {
  if (!dragSrc) return;
  const src = dragSrc;
  // ⚠️⚠️ 2026-10-07（真机探针抓到）：收尾原来裸放在函数末尾 —— 而 give / 槽位换位
  //   那些分支 `await api(...)` 之后直接 `return` ⇒ **清尾被跳过**，
  //   幽灵小纸片（`.dragghost`）留在屏幕上 —— 用户截图里"奇怪的物品特效 /
  //   特殊物品好像不消失"的元凶就是它（一次 give 留一张，越拖越多）。
  //   ⇒ 整段包进 try/finally：**任何一条路**松手都收得干干净净。
  try {
  if (dragMoved) {
    justDragged = true;   // 松手之后浏览器还会补一次 click ⇒ 那一下**不算点击**（450ms 时间窗，见点击守卫）
    justDraggedAt = Date.now();
    if (dropHit && canDropOn(dropHit, src)) {
      // 落下来做的事 ＝ **点一下那件事**：同一份状态、同一条提交通路（那颗「派人去」）
      const eid = dropHit.dataset.ev;
      const p = pickOf(eid);
      if (dropHit.dataset.drop === 'who') {
        // ⚠️⚠️ 清单第 1 条：**一个人同一时刻只在一件事里** —— 放进这一件之前，
        //   先把他在**别的**事件处理台里的位子撤掉（语义 ＝"他改去办这件了"）。
        //   没有这一步，同一张卡能同时挂在两个事件里（用户实测复现过的账面错乱）。
        //   ⚠️ 不在 `canDropOn` 里拦：拦了会出现"他被 A 占着、B 又放不进"的死局 ——
        //     换事件应当是**转移**，不是撞墙。
        for (const otherId in picks) {
          if (otherId === eid) continue;
          const op = picks[otherId];
          if (op && arr(op.participants).length) {
            op.participants = op.participants.filter((x) => x !== src.id);
          }
        }
        const set = new Set(p.participants);
        set.add(src.id);
        p.participants = [...set];
      } else if (dropHit.dataset.drop === 'fix') {
        // ⚠️⚠️ 2026-10-07：固定功能卡（医馆疗伤 / 神殿净化）—— 只改**页面态**
        //   （与事件台 `picks` 同一条纪律：拖放是"意向"，点「确定」才是事实）。
        //   ⚠️ 一张卡只放一个人 ⇒ 再拖一个进来 = 换人（不是排队）。
        fixPicks[dropHit.dataset.fix] = src.id;
        render();
      } else if (dropHit.dataset.drop === 'fixgold') {
        // ⚠️⚠️ 2026-10-07（用户裁定·第二批）：功能单的定额金币槽 —— 只记页面态。
        fixGold[dropHit.dataset.fix] = true;
        render();
      } else if (dropHit.dataset.drop === 'hand') {
    // ⚠️⚠️ 2026-10-07（用户第 1 条）：拖回手牌带 ＝ **拿回来**，按卡种分流：
    //   · 物卡 ⇒ **摘下**（2026-10-08 起：`/api/give` to='' ＝ 无人携带，不占携带位）；
        //   · 人卡 ⇒ 从事件台/功能单的槽里**取回**（纯页面态：清 `picks` / `fixPicks`）；
        //   · 金币 ⇒ 取回垫金（`src.ev` 指明从哪件事抓的 ⇒ 只退那一件；没指明 ⇒ 全退）。
        if (src.kind === 'item') {
          // ⚠️ 2026-10-08（**无人携带**）：to:'' ＝ 摘下回手牌区（holder=null，
          //   不占携带位）—— 不再发 to=me（那是"装备到艾德里安身上"，是另一个动作：
          //   只有把它拖到他自己那张人物卡上才会发生）。
          await api('/api/give', { to: '', items: [src.id] }, '摘下，放回手牌区…');
          return;
        }
        if (src.kind === 'person') {
          let changed = false;
          for (const id in picks) {
            const op = picks[id];
            if (op && arr(op.participants).indexOf(src.id) >= 0) {
              op.participants = op.participants.filter((x) => x !== src.id);
              changed = true;
            }
          }
          for (const fp in fixPicks) {
            if (fixPicks[fp] === src.id) { fixPicks[fp] = ''; changed = true; }
          }
          if (changed) render();
          return;
        }
        if (src.kind === 'gold') {
          let changed = false;
          if (src.ev && picks[src.ev] && picks[src.ev].gold > 0) {
            picks[src.ev].gold = 0; changed = true;        // 只退抓出来的那一件
          } else {
            for (const id in picks) {
              if (picks[id] && picks[id].gold > 0) { picks[id].gold = 0; changed = true; }
            }
            for (const fp in fixGold) {
              if (fixGold[fp]) { fixGold[fp] = false; changed = true; }
            }
          }
          if (changed) render();
          return;
        }
        return;
      } else if (src.kind === 'item' && (dropHit.dataset.toWhom
        || (dropHit.closest && dropHit.closest('[data-to-whom]')))) {
        // ⚠️⚠️ 2026-10-07：**槽内换位**（详情页四个物品卡槽）—— 落点是 `.islot`
        //   且这件东西**本来就在这个人身上** ⇒ 玩家要的是**调顺序**（生效优先级），
        //   不是"给自己"（`/api/give` 只会 push 到尾，调不出"挪到最前"）。
        //   ⚠️ 目标槽**有人** = 两件换位（用户原话：「应当自然的理解为玩家想要调换顺序」）；
        //     目标槽**空** = 挪到那个位。都走 `/api/items/order`（同集重排，服务端校验）。
        const slotWho = dropHit.dataset.slotwho;
        if (slotWho && src.holder === slotWho) {
          const hostP = slotWho === S.view.me.id ? S.view.me
            : arr(S.view.people).find((x) => x.id === slotWho);
          const cur = arr(hostP && hostP.items).map((x) => x.id);
          const from = cur.indexOf(src.id);
          const toIx = Number(dropHit.dataset.slotix);
          if (from >= 0 && toIx !== from) {
            const order = cur.slice();
            if (toIx < order.length) {
              const t = order[from]; order[from] = order[toIx]; order[toIx] = t;   // 换位
            } else {
              order.splice(from, 1); order.push(src.id);                            // 挪到空位（末位）
            }
            await api('/api/items/order', { who: slotWho, order: order }, '调整携带顺序…');
            return;
          }
          // from === toIx（拖回原位）⇒ 什么都不做，落穿到下面也无害，直接收
          dragEnd(); return;
        }
        const host = dropHit.dataset.toWhom
          ? dropHit
          : dropHit.closest('[data-to-whom]');
        const to = host && host.dataset.toWhom;
        if (to) {
          // ⚠️ 2026-10-08：到这里的手牌物卡必是**装备**（`canDropOn` 只放行无 holder 的）。
          //   旧话术「收回…」是"物卡跟着玩家走"旧模型的残留 —— 现在拖到玩家卡上
          //   = 把这件东西**带在自己身上**（装备），与交给别人同一条通路。
          await api('/api/give', { to: to, items: [src.id] }, (to === S.view.me.id ? '带在身上…' : '交给他…'));
          // ⚠️ 交给他之后卡带上那张物卡要消失 ⇒ `api()` 里的 `render()` 会重画。
          //   ⚠️ 2026-10-07 用户裁定：旧的"缩小插进人卡"演出（markCarried）**已删** ——
          //     「删掉这个奇怪的携带特效」。
          return;
        }
      } else if (dropHit.dataset.drop === 'voucher') {
        // ⚠️⚠️ 2026-10-06 清单第 4B.4 条：凭证卡拖进四行卡位 ⇒ **只改页面态**（`vPicks`）。
        //   ⚠️ **不发请求** —— 放格子在点「确定」那一刻才变成一次真实提交（`/api/finish`）。
        //     这与事件台那个 `picks` 同一条纪律：拖放是"意向"，提交才是"事实"。
        //   ⚠️ **同一张凭证不许占两格** —— 放之前先把别处同一 id 的清掉。
        const dim = dropHit.dataset.vdim, vi = Number(dropHit.dataset.vi);
        const st = vPick();
        for (const k in st) {
          const row = st[k];
          for (let j = 0; j < row.length; j++) if (row[j] === src.id) row[j] = '';
        }
        if (Array.isArray(st[dim]) && vi >= 0 && vi < st[dim].length) st[dim][vi] = src.id;
        vPersistSave();   // ⚠️ 2026-10-07（用户裁定）：放上去就**默认持久化**（刷新不丢）
        render();
      } else if (dropHit.dataset.drop === 'gold') {
        // ⚠️ 2026-10-05：金币卡拖进来 ⇒ 按 `goldDropAmount` 的三条规则加钱。
        //    ⚠️ **加的是 `sel.gold`（"这件事垫多少"），不是动 `view.gold`** ——
        //    真正的扣账在 `arrange` 提交后由规则层做。
        //    这里改的是**玩家的意向**；现在就把 `view.gold` 减掉的话，
        //    玩家还没点「派人去」钱就少了 ⇒ 取消都取消不回来。
        const add = goldDropAmount(eid);
        if (add > 0) { p.gold = Math.min(haveGold(), (p.gold || 0) + add); render(); }
        // ⚠️ `add === 0`（没标最低投入）⇒ **什么都不做，也不报错**：
        //    那一档的语义是"没要求垫钱"，玩家拖它只是想知道要多少。
        //    但**要给一句提示**，否则他会以为卡坏了 —— 槽上写"这件事不用垫钱"。
        else flashSlot(dropHit, '这件事不用垫钱');
      } else {
        // ⚠️⚠️ 2026-10-07：这里原来写的是"落进物格 ⇒ 记下这次用哪件"。
        //   而**物格已撤**（第 5 条：事件台只有 4 个人物槽 ＋ 1 个金币槽）
        //   ⇒ 能走到这儿的落点只剩 who / gold / voucher 三种，**都在上面接掉了**。
        //   ⇒ 什么都不做。留一个"往一个不存在的格子里瞎写状态"的口子，
        //     比留空危险得多（那会让那个字段变成一串人物 id）。
      }
      render();
    } else if (dropHit) {
      // ⚠️⚠️ 2026-10-07（用户报告"放不上去就让玩家一遍遍试"）：**拒绝要说人话**。
      //   此前拒绝 = 槽亮一下红、松手无声 ⇒ 玩家只能把每张卡都试一遍。
      //   ⇒ 松手那一刻在槽上闪一句"为什么不收"（`dropBlockReason` 与 canDropOn
      //     同源同序，只翻译不另判）。
      const why = dropBlockReason(dropHit, src);
      if (why) flashSlot(dropHit, why);
    }
  }
  } finally {
    dragEnd();
    dragSrc = null;
    dragMoved = false;
  }
});

// 手势被系统抢走（触屏滑动 / 右键菜单 / 切窗口）⇒ 同样收尾，别把幽灵小纸片留在屏幕上
document.addEventListener('pointercancel', () => { dragEnd(); dragSrc = null; dragMoved = false; });

