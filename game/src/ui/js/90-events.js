// ── 交互 ────────────────────────────────────────────────────────
document.addEventListener('click', async (ev) => {
  // ⚠️ **必须在最前**（在任何 `return` 之前消费掉）：刚拖完的那一下会补一个 click，
  //    不拦它 ⇒ 松手就顺手把那张卡的详情浮层打开了。
  //    ⚠️⚠️ 2026-10-07（用户实测"✔点不动"的真凶）：这个守卫**只能信一段时间**——
  //      拖放落地后 `render()` 会重画落点下的 DOM，浏览器一看"按下和松开不是同一个元素"
  //      就**不再补发 ghost click** ⇒ 旗子滞留 true ⇒ 下一颗真实按键（✔/简略处理）被白吞。
  //    ⇒ 改成**时间窗**：只在松手后 450ms 内吞（ghost click 都在几十 ms 内补发），
  //      过期的旗子在这里顺手清掉，绝不滞留。
  if (justDragged) {
    if (Date.now() - justDraggedAt < 450) return;
    justDragged = false;
  }
  // ⚠️⚠️ 2026-10-07（用户实测"金币撤不回来"）：点已放上的卡位 ⇒ 取回 ——
  //   这件事**必须走在 data-act 闸门之前**：槽位（.pslot）不带 data-act，
  //   `closest('[data-act]')` 一路找不到就 return ⇒ 原先那个取回分支是**死代码**
  //   （点 ×、点槽都没反应 —— 正是病根）。
  //   三种取回：人（弹 participants 末位）/ 物（清 usedItemId）/ 钱（**清零** =
  //   全撤 —— "拖是垫一点，点是全撤"，与 `goldDropAmount` 的 ① 同一理由）。
  const slotEl = ev.target && ev.target.closest ? ev.target.closest('.pslot.filled') : null;
  if (slotEl) {
    const d = slotEl.dataset.drop, eid2 = slotEl.dataset.ev;
    // 「处理中」的回看台只**展示**当时的输入 —— 点它的卡位不取回（账面不容页面态篡改）
    const evObj = eid2 ? eventOf(eid2) : null;
    if (evObj && evObj.status !== '待处理') return;
    if (d === 'who') {
      const pp = pickOf(eid2);
      if (arr(pp.participants).length) {
        const nm2 = nameOfId(pp.participants[pp.participants.length - 1]);
        pp.participants = pp.participants.slice(0, -1);
        render();
        flashSlot(slotEl, '取回 ' + nm2);
      }
    } else if (d === 'item') { pickOf(eid2).usedItemId = null; render(); }
    else if (d === 'gold') { pickOf(eid2).gold = 0; render(); }
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const evId = el.dataset.ev;
  // ⚠️⚠️ 2026-10-08（用户裁定）：序幕没走完（`S.view.prologue` 非空 = 还有待处理的
  //   序幕档 A）之前，「我想做点什么」/「拨钟」/「进下一天」一律拦下，提示
  //   「请先完成游戏序幕」—— 不发注定被闸门 ④ 拒掉的请求。
  //   ⚠️ pickCommit 内部直调 /api/nextday **不经过这里**（它不是按钮点击）：
  //   觉醒收尾走的正是那条路，不会被误伤。
  if ((act === 'openCompose' || act === 'dial' || act === 'nextday') && S && S.view && S.view.prologue) {
    banner = [{ kind: 'err', text: '请先完成游戏序幕' }];
    render(); return;
  }
  if (act === 'pick') {
    const p = pickOf(evId);
    const set = new Set(p.participants);
    if (el.checked) set.add(el.dataset.who); else set.delete(el.dataset.who);
    p.participants = [...set];
    // ⚠️ 换了随行的人 ⇒ 物格池子跟着变：**原先选好的那件东西可能不在池里了**（比如把"我"取消掉）。
    //    必须当场清掉 —— 否则 `picks` 里留着一个下拉里看不见、也不在场上的 id，
    //    提交时要么被服务端守卫拒，要么静静写进提示词（"他用了一件没带在身上的东西"）。
    if (p.usedItemId && !carrierPoolOf(p).some((x) => x.it.id === p.usedItemId)) p.usedItemId = '';
    render(); return;
  }
  if (act === 'popup') {
    // ⚠️ 2026-10-05：引导①「点开那张牌」在**这一刻**才算玩家学会了 ——
    //    他不是"看到了提示"，是**真的自己点开并处理了**。
    //    ⚠️ 刻意挂在 `popup`（点选）而不是 `popupOpen`（打开浮层）：
    //    打开浮层可能只是好奇点一下、看完就关；处理完才说明他会用了。
    markHint('openPopup');
    // ⚠️ 结果文案**不再在这里单独入队**：它同时也被推给了 `S.feed`（`kind:'弹窗'`）
    //    ⇒ 统一由 `collectResults()` 收。两处都收 = 同一段话弹两遍。
    // ⚠️ **点选之前先抓一张快照**（2026-09-23）：那一条马上就被结算掉、从 `popups` 里消失，
    //    而玩家要的"保留事件页面 ＋ 玩家处理方式"只能靠这份快照（见 `handled` 的说明）。
    //    ⚠️ 必须在 `await` **之前**抓 —— `api()` 回来会 `render()`，那时 `S` 已经换新了。
    const cur = arr(S && S.view && S.view.popups).find((x) => x.id === evId);
    const i = Number(el.dataset.i);
    const snap = cur ? { id: cur.id, title: cur.title, stage: cur.stage, content: cur.content,
                         options: arr(cur.options).map((o) => o.text), chosen: i, result: '' } : null;
    handled = snap;
    // ⚠️ 2026-10-05：把那层「你当场就得拿主意」**收掉** —— 点完之后它就该让位给
    //    `handled`（事件页面 ＋ 处理方式 ＋ 结算结果）。不收的话两条会叠着渲染。
    popupOpenId = '';
    const r = await api('/api/popup', { eventId: evId, optionIndex: i }, '正在结算这一步…');
    // 判"这一下到底落没落账"：看**新信封里那一条还在不在 `popups`**。
    // 还在 ⇒ 没落（被闸门拦下 / 陈旧页面 / 结果被拒）⇒ 快照作废
    // （否则会弹出一张"你做了这一步"、其实什么都没发生的卡）。
    // 不在了 ⇒ 落了 ⇒ 留着给玩家看下半场（**哪怕 `ok:false`** —— 比如点选成功、
    // 但紧随其后的翻牌失败：那一半也是这一下的结果，正该让玩家看见）。
    if (!snap || arr(r && r.view && r.view.popups).some((x) => x.id === evId)) handled = null;
    return;
  }
  // ⚠️⚠️ 2026-10-06 清单第 5.6 条：**选处理方式**（互斥单选，零网络）
  //   「简略处理」／「亲自去且仔细处理」—— 用户原话「**两个按钮必须点且只能点一个**」。
  // ⚠️ **再点一次＝取消选择**（回到"还没选"）—— 那是玩家的后悔药，不做就得重开这个浮层。
  if (act === 'how') {
    const p = pickOf(evId);
    p.handling = p.handling === el.dataset.how ? '' : el.dataset.how;
    render(); return;
  }
  // ⚠️ 5.4 的「×」＝退出当前事件。⚠️ **连本地暂存一起清掉** ——
  //   留着它的话，下次点开同一件事会看到上一次的选择（像是"我没选过"）。
  if (act === 'closeDetail') {
    if (evId) delete picks[evId];   // 带 data-ev 的关闭路（保留）
    discardDeskPicks();             // ⚠️ 2026-10-08：台头那颗 × 不带 data-ev ⇒ 靠 detailOpen 认领
    detailOpen = null;
    render(); return;
  }
  // ⚠️ 5.4 的「✔」＝确定以当前方式处理。**判据与按钮的置灰是同一份**（`okAll`），
  //   而**服务端还会再拒一次**（闸门 ③/⑨）—— 两处同源，不是两处各判一遍。
  if (act === 'commit') {
    const p = pickOf(evId);
    // ⚠️ 按钮灰着时点不到（`disabled`），但**键盘/脚本仍能触发** ⇒ 这里补一道，与 UI 同一个判据。
    if (!p.participants.length || !p.handling) { render(); return; }
    // ⚠️⚠️ 2026-10-07（用户裁定）：点 ✔ ⇒ **先退场** —— 事件台立刻收起，
    //   玩家马上去点开下一个事件；结算请求在后台排队跑（见 `api()` 的队列），
    //   结果回来时照常走揭晓 / 变化演出 / 结算弹窗那一条链。
    //   ⚠️ `picks[evId]` **不清**：排队期间他若再点开同一件事，看到的还是他摆的样子；
    //     结算落地后它转「处理中」，回看态读的是账本，这条页面态自然没人读。
    detailOpen = null;
    render();
    // ⚠️ **场景那路**：先开场景（`/api/scene/open`），不进 `/api/arrange` ——
    //   多轮场景是另一条链（`turn/scene.ts`），"亲自去且仔细处理"＝进那条。
    if (p.handling === 'scene') {
      if (!p.participants.includes(S.view.me.id)) { render(); return; }
      noteDispatched([S.view.me.id]);
      await api('/api/scene/open', {
        eventId: evId, participants: p.participants, goldInput: p.gold, usedItemId: p.usedItemId || null,
      }, '正在开场景…');
      return;
    }
    // 「简略处理」：一次了结 ⇒ 与旧的 arrange / self **同一条**（服务端那条也是一次提交）。
    // ⚠️ 玩家自己**不必亲自在槽里**（第 21 条：「简略处理也包括自己处理但不进多轮」）⇒
    //    玩家不在槽里时，`participants` 就是他的人（若有别人就派别人）。
    const parts = p.participants.length ? p.participants : [S.view.me.id];
    noteDispatched(parts);
    // ⚠️⚠️ 2026-10-08（用户裁定）：点 ✔ ⇒ 这件事**立马**显示「处理中」，不等 LLM 回包；
    //    等待话术也换成「已发送请求，可以继续处理其他事」（不再是"正在…"的等待腔）。
    //    实现＝**乐观挪池**：把事件从 `S.view.todo` 搬进 `S.view.waiting`、status 改「揭晓待办」
    //    ⇒ 画布徽标 / 顶栏「处理中」计数 / 拖拽与点击行为全部自动按"处理中"走。
    //    ⚠️ 只改页面上这份 view，不碰服务端账本：下一次回包（无论哪一件）拿真实信封
    //      整体覆盖 `S`，乐观态自动被事实接管 ⇒ 成功路径零收尾。
    //    ⚠️ 失败要**手动还原**：`r === null` ⇔ 本件没带回包（HTTP 非 200 / 网络异常 / 同动作
    //      去重丢弃）⇒ 那时视图还是乐观版，得把事件搬回 todo 玩家才能重点；
    //      `r` 非 null（哪怕 ok:false）⇒ 真实信封已接管，什么都不用做。
    //    ⚠️ `reveal_at` 服务端排布那一刻才写 ⇒ 乐观事件没有它，徽标由 `statusMark` 的
    //      「正在裁定…」兜底接管（见 20-render-mid.js）。
    const evObj = arr(S.view.todo).find((x) => x.id === evId) || null;
    const evIdx = evObj ? S.view.todo.indexOf(evObj) : -1;
    if (evObj) {
      evObj.status = '揭晓待办';
      S.view.todo.splice(evIdx, 1);
      S.view.waiting.push(evObj);
    }
    render();   // 与「点 ✔ 先退场」同一口气，把「处理中」当场画出来
    const r = await api('/api/arrange', {
      eventId: evId, participants: parts, goldInput: p.gold, usedItemId: p.usedItemId || null, note: p.note,
    }, '已发送请求，可以继续处理其他事');
    if (r === null && evObj) {
      // 失败 ⇒ 视图没被换 ⇒ 还原乐观挪池（报错横幅已由 apiSend 弹过）
      evObj.status = '待处理';
      const wi = S.view.waiting.indexOf(evObj);
      if (wi >= 0) S.view.waiting.splice(wi, 1);
      S.view.todo.splice(Math.min(Math.max(evIdx, 0), S.view.todo.length), 0, evObj);
      render();
    }
    // ⚠️⚠️ 清单第 1 条（**持久化**）：确定成功后**不清** `picks[evId]` ——
    //   事件转成「处理中」之后，玩家再点开它，看到的还是他当时摆下去的样子
    //   （只读回看，`cardHtml(e, true)`）。清掉 ＝ "全部清空仿佛没处理过一样"。
    //   等这件事真正了结（揭晓结算），它离开两池，这条页面态自然再无人读。
    if (r && r.ok) { markHint('openEvent'); markHint('pickWho'); }
    return;
  }
  if (act === 'arrange' || act === 'self') {
    const p = pickOf(evId);
    const parts = act === 'self' ? [S.view.me.id] : p.participants;
    // ⚠️ 2026-10-05：**在他离开卡带之前**记下是谁（`noteDispatched`）。
    //    记在 `await` **之前** —— 回来时 `S` 已经换新，那时才知道就晚了。
    noteDispatched(parts);
    // ⚠️ 2026-10-08（用户裁定）：与 commit·简略处理路同一动作 ⇒ 同一话术（这条直通路
    //    目前没有 UI 入口，纯防将来口径分叉）。
    const r = await api('/api/arrange', { eventId: evId, participants: parts, goldInput: p.gold, usedItemId: p.usedItemId || null, note: p.note }, '已发送请求，可以继续处理其他事');
    // ⚠️ 2026-10-05：两条引导在**派出去成功**这一刻算学会。
    //   `openEvent`（点开散着的事看详情）：走到这儿说明他点开过 —— 派布只能在详情里做。
    //   `openPopup` 不在这里管（那是档 A 的，与派布无关）。
    if (r && r.ok) { markHint('openEvent'); markHint('pickWho'); }
    // ⚠️ 派出去了 ⇒ 那张事件浮层要收掉：它已经不在「摆在你面前的事」里了
    //    （或进了「在办」，或直接了结）⇒ 留着一张点不动、也说不清新的空壳只会误事。
    //    **失败时不收** —— 玩家还得改人选重试。
    if (r && r.ok) {
      // ⚠️⚠️ 2026-10-07（串行金币）：成功 ⇒ 这次垫的钱服务端**真的扣了**。
      //   留着 `picks[evId].gold` 的话，`placedGold()` 会把它再减一次 ⇒ 手牌凭空少钱。
      //   这一手已经交出去了，选择没有保留价值（失败路径不动 —— 玩家还要改了重试）。
      delete picks[evId];
      if (detailOpen && detailOpen.kind === 'event' && detailOpen.id === evId) detailOpen = null;
      render();
    }
    return;
  }
  if (act === 'scene') { await api('/api/scene/open', { eventId: evId, participants: pickOf(evId).participants }, '正在铺开场景…'); return; }
  if (act === 'say') {
    const t = $('sayText');
    const text = t ? t.value : '';
    await sayStream(text);
    return;
  }
  if (act === 'leave') { await api('/api/scene/leave', {}, '正在收束场景…'); return; }
  if (act === 'create') {
    // 原话**原样**交出去（不 trim、不截断）—— 服务端与规则层都不替玩家改字。
    // ⚠️ 先存进 `composeText`：`api()` 回来会 `render()`，textarea 是重新造的
    //    ⇒ 不存就等于"请求一失败，玩家刚写的话就没了"。
    const t = $('createText');
    composeText = t ? t.value : '';
    const r = await api('/api/create', { approach: composeText }, '正在写下这件事…');
    // 成功 ⇒ 收掉面板；**失败留着**（那句话还在，玩家改一改就能再试一次）
    if (r && r.ok) { composeOpen = false; composeText = ''; render(); }
    return;
  }
  // ⚠️ 2026-10-07：「点已放上的卡位 ⇒ 取回」**搬到了本处理器最前**（data-act 闸门之前）——
  //   槽位不带 data-act，走闸门就等于永远走不到（此前这里是死代码，见处理器顶上那段）。
  if (act === 'toggleCard') {
    // 卡面化（第四轮）：只翻这一条的状态，然后重画。**没有别的作用** —— 它不碰账本。
    const id = el.dataset.ev;
    openCards[id] = !openCards[id];
    render(); return;
  }
  // ⚠️ 「自建面板」与「详情浮层」是**互斥的两层**（2026-09-22 修）：
  //    二者共用 `#overlay` / `#modal`，而 `renderOverlay` 里 compose 分支排在 detail 之前
  //    ⇒ 万一两者同时为真，**详情永远打不开**（渲染核查的中盘那趟就这么红了 4 条）。
  //    现实里点得到卡片就点不到页脚那颗按钮（遮罩盖着全屏），但"靠玩家点不到"不是一条判据 ——
  //    所以两个方向都显式关掉对方，状态里不存在"两层同时开着"。
  if (act === 'openCompose') { composeOpen = true; composeText = ''; discardDeskPicks(); detailOpen = null; render(); return; }
  if (act === 'closeCompose') { composeOpen = false; composeText = ''; render(); return; }
  if (act === 'detail') {
    // B 轮：整张卡可点 ⇒ 点开它对应的详情浮层。**不发请求、不碰账本。**
    composeOpen = false;
    // ⚠️ 2026-10-08（用户裁定第 2 条）：从一张开着的事件台直接点开别的卡 ＝
    //    没点 ✔ 就退场 ⇒ 台面全清（人物卡/金币回手牌区）。
    discardDeskPicks();
    // ⚠️⚠️ 2026-10-08（用户第 2 条·凭证详情点不开的根因）：凭证卡**刻意不带** `data-kind`
    //    （防拖拽纪律：拖拽源选择器认 `.hcard[data-kind]`，`ui.test.ts` 钉着不许带）⇒
    //    原来按 `el.dataset.kind` 读出来是 undefined，`renderOverlay` 落到 `sheetItem`
    //    分支 ⇒ 玩家的实感就是"凭证点不开"。改按 class 识别 —— 与「你的欲望」那屏
    //    `enableVoucherDrag` 事后补的 `data-kind='voucher'` 同值，两处判据不打架。
    const dKind = el.classList.contains('voucher') ? 'voucher' : el.dataset.kind;
    // ⚠️ 2026-10-06：凭证卡的标识在 `data-vid`（不是 `data-id`）—— 同 `dragSrc` 那处回退
    detailOpen = { kind: dKind, id: el.dataset.id || el.dataset.vid || '' };
    render(); return;
  }
  // ⚠️⚠️ 2026-10-06 清单第 4B 条：**取回一张凭证**（卡位右上那个 ×）。
  //   纯页面态、不发请求 —— 与放进去那一下完全对称。
  if (act === 'unplaceVoucher') {
    const st = vPick();
    const row = st[el.dataset.vdim];
    const vi = Number(el.dataset.vi);
    if (Array.isArray(row) && vi >= 0 && vi < row.length) row[vi] = '';
    vPersistSave();   // 取回也要落盘（否则刷新后又回来了）
    render(); return;
  }
  // ⚠️⚠️ 2026-10-06 清单第 4B 条：**「确定」＝ 提交放格子**。
  //   ⚠️ **服务端会自己再拒一次**（`Session.finish` 判 `isFinalDay`）——
  //     按钮的 `disabled` 只是让玩家少点一次，不是安全边界。
  //   ⚠️ **失败结局走同一条**：中途暴毙由 `terminateIfOver` 直接判，不经过这一屏。
  if (act === 'finish') {
    // ⚠️ 还没到最后一天 ⇒ **只提示、不提交**。用既有的 `flashSlot`（页面里已有那个提示样式），
    //   不新造一个 toast —— 一处提示样式够了。
    if (!S.view.isFinalDay) {
      const b = document.querySelector('.evd-ops button.primary');
      if (b) flashSlot(b, '还没到最后一天');
      render(); return;
    }
    const p = vPlacementsOf(S.view);
    const r = await api('/api/finish', { placements: p }, '正在收束这一局…');
    if (r && r.ok) { vPicks.slots = null; vPersistSave(); detailOpen = null; }
    render(); return;
  }
  if (act === 'closeDetail') { detailOpen = null; render(); return; }
  // ⚠️⚠️ 2026-10-07 用户第 3 条：「再点其中的人物可以看某个人物的详情，**点其他人物则替换**」
  //   ⇒ 只是换右边显示谁（`outSel` 是页面态），**弹窗不动、不重开**。
  if (act === 'outPick') { outSel = el.dataset.who; render(); return; }
  // ⚠️ 2026-06：手牌区的**高度**折叠（用户裁定：「展开后自然遮挡事件区」）。
  //    ⚠️ 切在 `body` 的 class 上，**不重画页面**（`render()` 会把手牌区重画一遍，
  //    而折叠态下那些卡 `max-height:0` 看不见 ⇒ 点了没反应）。
  //    ⇒ 只切 class ＋ 改那颗拉手自己的字，不走 `render()`。

  // 画布上点那张档 A 大牌（2026-10-05）—— 只是**把那一层打开**，不发请求。
  // ⚠️ 显式关掉 `composeOpen` ＝ 两层互斥（与 `detail` 那条同一条纪律）。
  if (act === 'popupOpen') {
    composeOpen = false; detailOpen = null;
    popupOpenId = evId; render(); return;
  }
  if (act === 'closePopupOpen') { popupOpenId = ''; render(); return; }
  // ── 开局选择（2026-10-05）──────────────────────────────────────────
  // ⚠️ **三个都不直接改账本**：`pickKit` / `pickAdv` 是**页面上的草稿**，
  //    只有「就这样」那一步才发请求（`/api/desire/pick` → `Session.choice`）。
  //    ⇒ 玩家可以来回点、反悔，而**服务端那边只在点了「就这样」时才知道**。
  // ⚠️ 2026-10-06 用户裁定（问题 5）：序幕那一句 → 宣言那一步。
  //   ⚠️ 只切**本地阶段**，**不发请求** —— 真正的提交仍在 `pickCommit`（服务端那份 `Session.choice`
  //   是唯一事实源，玩家来回点不该每次都让后端知道）。
  if (act === 'pickOpen') { pickStage = 'kit'; render(); return; }
  if (act === 'pickBack') {
    pickStage = pickStage === 'adv' ? 'kit' : '';
    // ⚠️ 回第一步时**清掉已选** —— 否则玩家会看到"选好的宣言又在那儿"，
    //   而那一句恰恰是"还没挑"的意思（属性也一并清，与换句同一条口径）。
    if (pickStage === '') { pickKit = -1; pickAdv = {}; }
    render(); return;
  }
  if (act === 'pickKit') {
    const k = Number(el.dataset.k);
    pickKit = k;
    // 换一条欲望 ⇒ **优势项清空**：它们是"为这一句准备的手段"，换句就该重挑。
    // ⚠️ 判据在服务端（越界会拒），这里只防"换了欲望还留着上一句的手段"这种明显不对。
    pickAdv = {};
    // ⚠️ 2026-10-06（问题 6/7）：宣言那一步**选完就去属性那一步** ——
    //   用户原话：「点完后让玩家在4个宣言中选择一个」「玩家再点完后，才进入属性加点的弹窗」。
    //   ⇒ 选完**立即进** `'adv'`（不许停在原地，那会让人以为没反应）。
    pickStage = 'adv';
    render(); return;
  }
  if (act === 'pickAdv') {
    const a = el.dataset.a || '';
    if (pickAdv[a]) { delete pickAdv[a]; render(); return; }
    // ⚠️ 上限 2 在**服务端**也判（`pickDesire` 会拒）；这里只是不让它变成一次失败请求。
    //    提示走 `banner`（与 `api()` 报错同一个出口）—— 别另造一个提示机制。
    if (Object.keys(pickAdv).length >= 2) {
      banner = [{ kind: 'err', text: '最多只能点亮两项 —— 想全都要，就得一样都不专。' }];
      render(); return;
    }
    pickAdv[a] = true;
    render(); return;
  }
  if (act === 'pickCommit') {
    if (pickKit < 0) {
      banner = [{ kind: 'err', text: '先在上面挑一句 —— 那句话 28 天不会变。' }];
      render(); return;
    }
    await api('/api/desire/pick', { kit: pickKit, advantages: Object.keys(pickAdv) }, '正在记下你想要的…');
    pickStage = '';
    // ⚠️⚠️ 2026-10-07 用户裁定：**「确定」之后直通真游戏第 1 天** ——
    //   末条那张「迎接你『真实的自我』」弹窗与其后的结果确认屏都是**残留**，整条删掉。
    //   玩家在属性那一步按下确定，他的觉醒就已经完成了 ⇒ 前端**替他一步走完**：
    //   ① 点掉末条（服务端落账欲望 ＋ 六维）⇒ ② 翻日 ⇒ 落在第 1 天的地图上。
    //   （`renderOverlay` 里那个「已提交」判据补丁因此只剩**读档回来**这一种触场 —— 留着，
    //     读档落在"提交了但末条没点"的档上时照样有出口，不会复现死路。）
    popupOpenId = '';
    handled = null;
    const lastCard = arr(S && S.view && S.view.popups)[0];
    if (lastCard) {
      await api('/api/popup', { eventId: lastCard.id, optionIndex: 0 }, '迎接你『真实的自我』…');
      // ⚠️ 末条的那半句结算下文也是残留的一部分 ⇒ 不进「结果」队列。
      popupResults = [];
    }
    // ⚠️⚠️ 2026-10-08（用户第 5 条）：直通链**中间加一站**—— 点掉末条之后、翻日之前，
    //    弹「游戏难度」让玩家挑叙事风味（决定 LLM 的角色身份基调，落账 `ledger.difficulty`）。
    //    原来那步翻日（连着欲望面板待办）挪进 `pickDifficulty` 分支 —— 玩家不选，第 1 天就不来。
    difficultyOpen = true;
    render();
    return;
  }
  // ⚠️⚠️ 2026-10-08（用户第 5 条）：三档难度之一被点下 —— 落账，再接上被拦下的那步翻日。
  if (act === 'pickDifficulty') {
    const level = Number(el.dataset.level) || 0;
    // ⚠️⚠️ 2026-10-08 用户裁定（第 4 条）：点完一颗 ⇒ **先锁 UI 再发请求** ——
    //    置 `difficultyPicked` 并重画（三颗全 disabled、点中的那颗变暗），
    //    玩家不能在这期间改主意去点别的档；失败才归 0 解锁让他重点。
    difficultyPicked = level;
    render();
    const r = await api('/api/difficulty', { level }, '正在记下你挑的世界…');
    // ⚠️ 落账失败（越界 / 断线）⇒ 弹窗留着让他重点；成功才放行翻日。
    if (r && r.ok) {
      difficultyOpen = false;
      difficultyPicked = 0;
      await api('/api/nextday', {}, '正在铺开第 1 天…');
      // ⚠️⚠️ 2026-10-08（用户第 3 条）：觉醒流程走完 ⇒ 待办一次「欲望面板自动弹出 ＋ 左侧引导」。
      //    放在**最后一个 api 之后**：中间那些响应自带的 render 都不消费（此刻标志还没置），
      //    只有下面这次显式 render 接住它 —— 直通链上"弹"的时机恰好是"落在第 1 天"那一刻。
      desireIntroPending = true;
    } else {
      // 失败 ⇒ 归 0 解锁，弹窗留着让他重点（锁着不放就永远点不了了）。
      difficultyPicked = 0;
    }
    render();
    return;
  }
  if (act === 'dial') { await api('/api/dial', { n: Number(el.dataset.n) }, '正在拨动时间…'); return; }
  // 翻日 ⇒ 画布整片换掉，上一张事件浮层必然失效 ⇒ 先收掉再发请求。
  if (act === 'nextday') { discardDeskPicks(); detailOpen = null; await api('/api/nextday', {}, '正在铺开新的一天…'); return; }
  // ⚠️⚠️ 2026-10-08（用户裁定）：序幕提示旁那颗「直接正式开始游戏」——
  //   掐掉还没读的序幕事件、直接铺出末条「原初欲望的觉醒」（服务端 `skipToOpening`）。
  //   之后玩家点那张卡，觉醒流程与自然走完时**一字不差**。
  if (act === 'skipPrologue') { await api('/api/prologue/skip', {}, '正在翻开「原初欲望的觉醒」…'); return; }
  // ⚠️ 2026-10-07：固定功能事件的「确定」—— 人槽 ＋ 金币槽都就位才能按。
  //    拖放只是意向，这里才是事实：成功才清页面态（服务端拒绝就留着让他改），
  //    并收掉功能单。⚠️ 2026-10-07 用户裁定（第十五批）：恢复**延迟生效** ——
  //    提交＝排布（画布上长出一张「处理中」卡），拨时针到点才回满。
  if (act === 'fixCommit') {
    const place = el.dataset.place;
    const pid = fixPicks[place] || '';
    if (!pid || !fixGold[place]) return;
    const r = await api('/api/restore', { place: place, targets: [pid] }, '正在恢复…');
    if (r && r.ok) {
      fixPicks[place] = ''; fixGold[place] = false;
      if (detailOpen && detailOpen.kind === 'fix') detailOpen = null;
      render();
    }
    return;
  }
  if (act === 'fixClear') { fixPicks[el.dataset.place] = ''; render(); return; }
  if (act === 'fixGoldClear') { fixGold[el.dataset.place] = false; render(); return; }
  // 功能单的开与关（地图上那张 `fix:` 功能卡 → 点开；× → 收掉）
  if (act === 'fixOpen') { detailOpen = { kind: 'fix', place: el.dataset.place }; composeOpen = false; render(); return; }
  if (act === 'fixClose') { if (detailOpen && detailOpen.kind === 'fix') detailOpen = null; render(); return; }
  // 手牌带右端的翻页双箭头：往前 / 往后各翻一页（2026-10-08 用户裁定：一枚改两枚）
  if (act === 'handPrev') {
    const r = document.querySelector('.hand-rail');
    if (r) r.scrollBy({ left: -340, behavior: 'smooth' });
    return;
  }
  if (act === 'handNext') {
    const r = document.querySelector('.hand-rail');
    if (r) r.scrollBy({ left: 340, behavior: 'smooth' });
    return;
  }
  // ── 标题屏：四个槽 ──────────────────────────────────────────────
  if (act === 'newGame') {
    await api('/api/save/new', { slot: Number(el.dataset.slot), seed: seedValue() }, '正在开一局…');
    return;
  }
  if (act === 'loadGame') {
    // ⚠️ 2026-10-07：读档**只对齐游标不重播**（feedCursorSkipOnce，见其声明处的病灶分析）
    //    —— 不设这个的话，页面首屏已把游标推到"空 feed 的 0"，读档带回的整段历史
    //    会被当成新结算逐条弹回（序幕假事件的结果每次进档都重新刷一遍）。
    feedCursorSkipOnce = true;
    await api('/api/save/load', { slot: Number(el.dataset.slot) }, '正在读档…');
    return;
  }
  if (act === 'askDelete') {
    // ⚠️ 删档**不可逆** ⇒ 二次确认，而且话要说透"找不回来"
    const i = Number(el.dataset.slot);
    confirmAsk = {
      title: '删掉存档 ' + (SLOT_NO[i] || (i + 1)) + ' ？',
      text: '这一局的进度会没有 —— 删了就找不回来。',
      yes: '删掉', no: '先不要', danger: true,
      run: () => api('/api/save/delete', { slot: i }, '正在删除…'),
    };
    render(); return;
  }

  // ── 局内两个出口 ───────────────────────────────────────────────
  // 结局画面上的出口（2026-10-07 用户裁定）：看完结局回到标题屏。
  // ⚠️ 走服务端现成的 `/api/title`（与存档出口同一条路）；
  // ⚠️ **必须解开 `endingPlayed` 守卫** —— 下一局是**新的一局**，
  //   守卫不解，新局的结局演出会被"这一局播过了"挡掉（一次不播）。
  if (act === 'endTitle') {
    await api('/api/title', {}, '正在回到开局…');
    endingPlayed = false;
    endingBusy = false;
    hideEnding();
    render();
    return;
  }
  if (act === 'saveQuit' || act === 'giveup') {
    // ⚠️ 2026-10-07（用户裁定「任何时候都可以点」）：局**已经终了** ⇒ 结算动画播过了，
    //   再走 `/api/giveup` 只会被会话守卫拒回来（"这一局已经结束"）——
    //   此时这颗按钮的意义就是它的出口：直接回标题屏。
    if (act === 'giveup' && S.view && S.view.isOver) {
      await api('/api/title', {}, '正在回到开局…');
      endingPlayed = false; endingBusy = false;
      hideEnding();
      render();
      return;
    }
    const cur = (S.slot === null || S.slot === undefined) ? 0 : S.slot;
    confirmAsk = act === 'saveQuit'
      ? { title: '保存并退出？',
          text: '这一局会存在存档 ' + (SLOT_NO[cur] || (cur + 1)) + ' 里 —— 下次从标题屏接着玩。',
          yes: '保存并退出', no: '继续玩',
          run: () => api('/api/save/put', {}, '正在保存…') }
      : { title: '直接结算？',
          text: '这一局到此为止 —— 按"中途暴毙"判（HP 归 0），结局会记在存档里。',
          yes: '就到这里', no: '再想想', danger: true,
          run: () => api('/api/giveup', {}, '正在结算这一局…') };
    render(); return;
  }
  if (act === 'confirmYes') {
    const f = confirmAsk ? confirmAsk.run : null;
    confirmAsk = null;
    if (f) await f(); else render();
    return;
  }
  if (act === 'confirmNo') { confirmAsk = null; render(); return; }
  // 折叠栏上的那一下：`data-rest === '0'` ⇒ 已经全展开了，这一下是「收起」
  if (act === 'moreHist') {
    const k = el.dataset.k;
    if (!(k in histMore)) return;
    histMore[k] = el.dataset.rest === '0' ? 0 : (histMore[k] || 0) + HIST_STEP;
    render(); return;
  }
  // 「知道了」/「确认」＝ **翻篇**：一次只放一条，点掉一条才轮到下一条（2026-09-23 用户裁定
  // 「上一个事件的所有相关内容都不再显示」）。⚠️ 用 `shift()` 而不是清空整队 ——
  // 清空会把后面几条**没读过就丢掉**。
  if (act === 'closeResults') { popupResults.shift(); render(); return; }
  // ── 骰子动画弹窗（2026-10-07）────────────────────────────────
  // 「点击画面进行投掷」—— 动画是**纯展示**：闪一阵之后落到排布时掷好的那份值上。
  if (act === 'diceRoll') {
    if (!diceState.entry || !diceState.entry.roll || diceState.rolled) { render(); return; }
    diceState.rolled = true;
    const d = diceState.entry.roll;
    const sp = diceSplit(d);
    const shapes = document.querySelectorAll('#modal .die');
    shapes.forEach((el) => el.classList.add('rolling'));
    // 数字闪烁：掷骰的"哗啦哗啦"感 —— 80ms 一换，1.15s 后落定
    const flick = setInterval(() => {
      document.querySelectorAll('#modal .die .dnum').forEach((el) => {
        el.textContent = 1 + Math.floor(Math.random() * 20);
      });
    }, 80);
    setTimeout(() => {
      clearInterval(flick);
      document.querySelectorAll('#modal .die').forEach((el) => {
        el.classList.remove('rolling');
        el.classList.add('landed');
        const shape = el.querySelector('.dshape');
        if (!shape) return;
        // 落定值：d20 / 惩罚 i / 奖励 i —— 顺序与 `dicePopupHtml` 的渲染口径一致
        const n = el.classList.contains('d20')
          ? d.raw
          : el.classList.contains('pen')
            ? d.diceRolls[Number(el.dataset.i || 0)]
            : d.diceRolls[sp.pen + Number(el.dataset.i || 0)];
        shape.innerHTML = '<span class="dnum">' + n + '</span>';
      });
      render();   // 重画 ⇒ 结果算式行出现、「查看结算结果」解锁（骰面由 rolled 态直接渲染既定值）
    }, 1150);
    return;
  }
  // 「查看结算结果」—— 处理者卡槽里的卡**飞回手牌区**，然后进入原来的结算弹窗。
  if (act === 'diceGo') {
    if (!diceState.rolled || !diceState.entry) { render(); return; }
    const hand = document.getElementById('hand');
    const hr = hand ? hand.getBoundingClientRect() : null;
    const cards = document.querySelectorAll('#modal .dslotcard[data-pid]');
    cards.forEach((el) => {
      if (!hr) return;
      const cr = el.getBoundingClientRect();
      const dx = hr.left + hr.width / 2 - (cr.left + cr.width / 2);
      const dy = hr.top + hr.height / 2 - (cr.top + cr.height / 2);
      el.style.transition = 'transform .55s cubic-bezier(.5,0,.3,1), opacity .5s linear';
      el.style.transform = 'translate(' + dx.toFixed(0) + 'px,' + dy.toFixed(0) + 'px) scale(.45)';
      el.style.opacity = '0';
    });
    // 飞完（或没有手牌区可飞）才放行到普通结果卡
    setTimeout(() => { diceState.done = true; render(); }, hr ? 580 : 0);
    return;
  }
  // 档 A 那一步看完了 ⇒ 收起这张卡；下一条（若有）由 `renderOverlay` 接着摆出来
  // ⚠️ 2026-10-05：**参与卡归位** —— 关掉结算那一屏，就让"去办事的人"那张卡亮一下。
  //    ⚠️ 不是"搬回卡带"：他的人**本来就在**卡带上（`isAway` 判他归队日当天就回来），
  //      这里演的是"他不见了现在又出现了"这件事，不是一个搬运动画。
  //    ⚠️ `backHome` 在这里被**清空**（它是一次性的）：否则他下一次派出去
  //      再结算一次就会亮，而那一次应该另有触发。
  if (act === 'ackHandled') {
    handled = null;
    const who = backHome; backHome = [];
    render();
    if (who.length) markHomecoming(who);
    return;
  }
  if (act === 'god') { god = !god; render(); return; }
  // 昼夜切换（2026-10-05）—— **不发请求**：`api()` 一次都不调，只换一组 CSS 变量。
  // ⚠️ 必须走 `render()`：按钮文案是 `themeBtnHtml()` 算出来的，不重画就还是旧字。
  if (act === 'theme') { applyTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'); render(); return; }
  // ⚠️ 页面上原先那颗「重开（同种子）」已撤：
  //    它是**开发口径**（玩家要的是"接着玩"），而且现在每个动作都自动存档 ⇒
  //    "重开"会把玩家自己那一档当场盖掉。服务端的 `/api/reset` 留着给冒烟脚本 / 排错用。
  if (act === 'finish') {
    // ⚠️ 交上去的就是玩家**当下选中的那三格**（不预填建议值 ⇒ 这里可能是三个 null）
    await api('/api/finish', { placements: { 成果: slots.成果 || null, 手段: slots.手段 || null, 共鸣: slots.共鸣 || null } }, '正在判定结局…');
    return;
  }
});

// 点遮罩空白处 ＝ 收起**详情浮层**。
// ⚠️ 只管 `detailOpen`：档 A 弹窗 / 确认框 / 自建面板都**不许**点一下就跑掉 ——
//    档 A 是强制的、确认框牵涉删档、自建面板里可能正写着字。
document.addEventListener('click', (ev) => {
  if (!detailOpen) return;
  if (ev.target && ev.target.id === 'overlay') { discardDeskPicks(); detailOpen = null; render(); }
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const p = pickOf(el.dataset.ev);
  if (el.dataset.act === 'gold') p.gold = Math.max(0, Number(el.value) || 0);
  if (el.dataset.act === 'item') p.usedItemId = el.value;
});
document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-act="note"]');
  if (!el) return;
  const p = pickOf(el.dataset.ev);
  p.note = el.value;
  // ⚠️⚠️ 2026-10-07（用户实测第 5 条）：**这里绝不能整轮 render**。
  //    上一版「render() ＋ 还焦点/光标」有两个实打实的恶果：
  //    ① **IME 组合被打断** —— 每个按键都重建输入框 DOM，中文一个词都打不出来；
  //    ② keydown → input → 重建 → 新框又收到残余 key事件 ⇒ **一个字母进三个**。
  //    ⇒ 正解：打字时**其余判据都不可能变**（人/金/方式都是点选的），
  //      只有 noteOk 在变 ⇒ 把「除 note 外的合取」在渲染时存进按钮的 `data-okbase`，
  //      这里**只改那一颗按钮的 disabled** —— 输入框原封不动，IME 安好。
  // ⚠️ 2026-10-07（用户裁定·改）：note 只在**简略处理**那路参与合取 ——
  //    「亲自去」不需要它 ⇒ 打字与否都不动 ✔（能到这一步说明 how 已是 brief，
  //    但判据仍按同一份口径读 `p.handling`，与渲染侧一字不差）。
  const ok = document.querySelector('#modal [data-act="commit"][data-ev="' + el.dataset.ev + '"]');
  if (ok && ok.dataset.okbase !== undefined) {
    ok.disabled = !ok.dataset.okbase || (p.handling === 'brief' && !String(el.value).trim());
  }
});
// ⚠️ 2026-10-07（用户第 2 条）：「我想做点什么」**点空白处（遮罩）也能退出** ——
//    与「先不写」同一个出口（草稿一并清）。⚠️ 只对自建面板生效：
//    确认框／事件台／结算屏不该因为一次误点遮罩就消失。
document.getElementById('overlay').addEventListener('click', (ev) => {
  if (ev.target.id !== 'overlay') return;   // 点到 #modal（或其子元素）不算空白
  if (!composeOpen) return;
  composeOpen = false;
  composeText = '';
  render();
});

