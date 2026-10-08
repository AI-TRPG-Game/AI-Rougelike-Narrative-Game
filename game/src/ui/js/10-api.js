// ── 忙碌态 ＋ 动作队列（真模型下的必需品，不是装饰）─────────────────
//
// ⚠️ 2026-10-07（用户裁定）：**点 ✔ 之后玩家要能立刻去处理下一个事件** ——
//    延迟缓解的意义就是"结算在后台跑，你继续玩"，不是"整屏锁死等他"。
//    ⇒ 原先「单飞：第二个请求直接丢弃」改为**客户端排队**：结算在飞时点下的
//      动作按顺序排队，前一个落地后逐个执行（客户端串行 ⇒ 服务端那道 409 闸永远打不到）。
//    ⚠️ 去重判据收窄成「**同一个动作**」（同 path ＋ 同 body）不排两次 ——
//      这是原先整域锁的**唯一还要保的功能**（手抖双击不会双落账）；
//      排队期间再点同一颗按钮 ⇒ 丢弃，与旧行为一致。
//    ⚠️ 服务端那道闸（`ui/gate.ts`）仍然保留：它拦的是**两个标签页 / 脚本**那类
//      绕过前端的调用，与本队列互为表里。
let inflight = false;
let busyTimer = null;
const apiQueue = [];          // 待执行的动作 [{path, body, label, key, resolve}]
const apiKeys = new Set();    // 在飞 ＋ 排队中的动作 key（同动作去重）

/** 排队指示（挂在忙碌小签的尾巴上）—— 排了几个一眼可读 */
function apiQueueSuffix(){
  return apiQueue.length > 0 ? '（已排 ' + apiQueue.length + ' 件）' : '';
}

/**
 * 显示 / 关闭忙碌提示。
 * ⚠️ 必须**计时**：玩家需要一个"它还在动"的证据 —— 光一句"正在推演"，在等 40 秒后
 *    和卡死没有区别。
 * ⚠️ 2026-10-07：忙碌**只读不锁** —— `body.busy` 不再禁点（见 CSS 那条的改注），
 *    小签只负责说"后台在跑什么、排了几件"。
 */
function setBusy(on, label){
  const el = $('busy');
  if (document.body && document.body.classList) document.body.classList.toggle('busy', !!on);
  if (el && el.classList) el.classList.toggle('on', !!on);
  if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
  if (!on) return;
  const t = $('busyText');
  const base = (label || '正在推演…');
  const t0 = Date.now();
  if (t) t.textContent = base + apiQueueSuffix();
  busyTimer = setInterval(() => {
    const t2 = $('busyText');
    if (t2) t2.textContent = base + apiQueueSuffix() + ' · 已等待 ' + Math.round((Date.now() - t0) / 1000) + ' 秒';
  }, 1000);
}

/**
 * 把**这一次动作新产生**的结算正文收进弹窗队列 —— 2026-09-22 用户裁定「结算时弹一次」。
 *
 * ⚠️ 为什么挂在 `S.feed` 上、而不是各处理器自己 push：
 *    结果正文本来就**全部**会进 `feed`（`kind` = 弹窗 / 揭晓 / 收场 / 终局 / 占卜），
 *    各处理器再各写一遍就是「同一个口径两处实现」 ⇒ 迟早漏掉一条。
 * ⚠️ 唯一跳过的是 `场景`：那几句叙述有自己的**活卡**（中栏那张「场景」），
 *    再弹一次等于同一句话在屏幕上出现两遍。
 */
function collectResults(){
  const feed = arr(S && S.feed);
  if (feed.length <= feedShown) { feedShown = feed.length; return; }
  const fresh = feed.slice(feedShown);
  feedShown = feed.length;
  for (const f of fresh){
    if (f.kind === '场景') continue;
    if (!f.text) continue;
    // ⚠️ 刚点掉一条档 A ⇒ **它的结果配到那张卡上**（2026-09-23 用户裁定：
    //    「保留事件页面 ＋ 玩家处理方式」再「显示结算结果」——原本就是**同一张卡的两半**，
    //    此前却被拆成"上半场在弹窗里、下半场在一坨长条里"）。
    //    ⚠️ 一条档 A 点选恰好产生**一条** `kind:'弹窗'` 的 feed（见 `session.ts·clickPopup`）
    //    ⇒ 取第一条即可，不必猜、也不必按标题去配对（选项文案可能撞车）。
    if (handled && !handled.result && f.kind === '弹窗') { handled.result = f.text; continue; }
    // ⚠️ 2026-10-07：揭晓那路带出来的骰（简略处理排布时掷的）跟着走 ——
    //   骰子动画弹窗要靠它才知道"该怎么落"。
    popupResults.push({ kind: f.kind, title: f.title || '', text: f.text, roll: f.roll || null });
  }
}

/**
 * 发一个动作。
 * ⚠️ 空闲 ⇒ 直接发；在飞 ⇒ **排队**（落地后按点击顺序逐个执行 —— 2026-10-07 用户裁定：
 *    点 ✔ 之后玩家要能立刻去处理下一个事件，结算在后台跑）。
 * ⚠️ 同一个动作（同 path ＋ 同 body）在飞 / 已排队 ⇒ 丢弃（双击保护，返回 null 与旧单飞一致）。
 */
function api(path, body, label){
  const key = path + '|' + JSON.stringify(body || {});
  if (apiKeys.has(key)) return Promise.resolve(null);
  if (!inflight) return apiSend(path, body, label, key);
  apiKeys.add(key);
  return new Promise((resolve) => {
    apiQueue.push({ path: path, body: body, label: label, key: key, resolve: resolve });
    // 排上了 ⇒ 刷新小签上的"已排 N 件"（busyBase 是在飞那一件的标签，不换丢）
    setBusy(true, busyBase || '正在推演…');
  });
}

/** 在飞那一件的标签（排队刷新小签时要复用，不能把标签换丢） */
let busyBase = '';

async function apiSend(path, body, label, key){
  inflight = true;
  apiKeys.add(key);
  busyBase = label || '正在推演…';
  setBusy(true, busyBase);
  try{
    const r = await fetch(path, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(body || {}), cache:'no-store',
    });
    // ⚠️ **非 200 只贴话术、绝不碰视图**：409 = 服务端正在跑另一个动作（`ui/gate.ts`），
    //    404 / 500 同理。此前不判 `r.ok` 就直接 `S = payload` ——
    //    那一份错误体里**没有 `screen`**，`render()` 于是拿着一个"不是信封的对象"去画，
    //    页面上什么都刷不出来：玩家看到的是"点了没反应"，而不是"服务器说它忙"。
    if(!r.ok){
      let why = '';
      try{ why = (await r.json()).error || ''; }catch(e){}
      banner = [{kind:'err', text: why || ('服务器拒绝了这条请求（HTTP ' + r.status + '）')}];
      render(); return null;
    }
    const payload = await r.json();
    return adoptPayload(payload);
  }catch(e){
    banner = [{kind:'err', text:'请求失败：' + e.message}];
    render(); return null;
  }finally{
    apiKeys.delete(key);
    // ⚠️ 队列里还有 ⇒ **继续忙下一件**（inflight 保持 true，apiSend 自己会刷新小签）
    const next = apiQueue.shift();
    if (next) next.resolve(apiSend(next.path, next.body, next.label, next.key));
    else { inflight = false; setBusy(false); }
  }
}

/**
 * ⚠️⚠️ 2026-10-07（用户裁定）：场景那一句**不走 api()** —— 三件事它要现做：
 *   ① **玩家的话立马上屏**（不等 LLM 回应才一起显示）—— 回应还没影，他说的那句话
 *      就已经挂在右边了；
 *   ② **LLM 的回应流式打字** —— `/api/scene/say` 是 SSE（服务端边吐 `{"t":…}` 边推），
 *      左边那个气泡的字是一点点长出来的；
 *   ③ 结束时拿到 `{"done":信封}` —— 交给 `adoptPayload`，与别的动作**同一个口**进视图。
 * ⚠️ 守卫与 api() 同一套：`apiKeys` 双击保护、`inflight` 互斥（在飞 ⇒ 直接忽略 ——
 *   服务端串行闸本来也会 409，这里提前挡掉省一趟）。
 * ⚠️ 流式期间**不调 render()**：整棵对话树是 renderOverlay 重造的，中途重画会把
 *   打字气泡冲掉 —— 只动那一个节点的 textContent。等 done 一到，adoptPayload → render()
 *   从 `sc.turns` 全量重建，与流过的字自然衔接。
 */
async function sayStream(text){
  const key = '/api/scene/say|' + JSON.stringify({ text: text || '' });
  if (apiKeys.has(key) || inflight) return;
  apiKeys.add(key); inflight = true;
  busyBase = '正在推进这一轮…'; setBusy(true, busyBase);
  let llm = null;
  const cb = document.getElementById('chatbox');
  try{
    // ① 玩家的话**立刻**上屏（原文原样；空串不画 —— 让服务端的校验去报错）
    if (cb && String(text).trim() !== '') {
      const me = document.createElement('div');
      me.className = 'bub me';
      me.textContent = String(text);
      cb.appendChild(me);
    }
    // ② LLM 占位气泡：一个"…"，字到一行行换上去
    llm = document.createElement('div');
    llm.className = 'bub llm';
    llm.textContent = '…';
    if (cb) { cb.appendChild(llm); cb.scrollTop = cb.scrollHeight; }

    const res = await fetch('/api/scene/say', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ text: text || '' }), cache:'no-store',
    });
    // 非 200：SSE 还没开头 ⇒ 普通错误体（409 忙 / 404 / 500），与 api() 同一套话术
    if (!res.ok || !res.body) {
      let why = '';
      try{ why = (await res.json()).error || ''; }catch(e){}
      banner = [{kind:'err', text: why || ('服务器拒绝了这条请求（HTTP ' + res.status + '）')}];
      render(); return;
    }
    // ③ 读 SSE：`data: {"t":…}` 打字、`data: {"err":…}` 报错、`data: {"done":…}` 收官
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', doneEnv = null, errMsg = null, typed = false;
    for(;;){
      const step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream:true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let j; try{ j = JSON.parse(line.slice(5)); }catch(e){ continue; }
        if (typeof j.t === 'string' && j.t !== '') {
          typed = true; llm.textContent = j.t;
          if (cb) cb.scrollTop = cb.scrollHeight;
        }
        else if (j.err) errMsg = j.err;
        else if (j.done) doneEnv = j.done;
      }
    }
    // ④ 收官：信封进视图（render 全量重建对话树，含这一轮的玩家话与完整回应）
    if (doneEnv) { adoptPayload(doneEnv); return; }
    llm.remove(); llm = null;
    banner = [{kind:'err', text: errMsg || (typed ? '连接中断——这一轮的回应没有走完' : '这一轮没有等到回应')}];
    render();
  }catch(e){
    if (llm) llm.remove();
    banner = [{kind:'err', text:'请求失败：' + e.message}];
    render();
  }finally{
    apiKeys.delete(key);
    inflight = false; setBusy(false);
  }
}

/**
 * 把一份**成功**的信封接进页面 —— 原 `api()` 的后半段拆出来（队列化后发送与接收分家，
 * 但"信封 → 视图"的口径必须只有这一份）。
 */
function adoptPayload(payload){
  // ⚠️⚠️ 2026-10-06 用户裁定：「有很多类似的多余的文字弹窗都不需要」
  //   ⇒ **成功的 notice 不再占横幅**（"新的一局开始了（种子 3）—— 先从序幕读起"
  //     "时间走了 2 点" 这类：每一步都有一条，横幅就成了常驻噪音）。
  //   ⚠️ **错误必须留**（`payload.error`）—— 那是玩家有权知道"服务器拒绝了我"，
  //     静默掉就变成"点了没反应"，那是本项目明确要消灭的那种体验。
  //   ⇒ 所以这里**只留错误**，notice 一律不弹；真正要告诉玩家的事
  //     走**变化演出**（`chgtoasts` 那种，一次性、1.6 秒、说完就走）。
  banner = [];
  if (payload.error) banner.push({kind: 'err', text: payload.error});
  // ⚠️ 2026-10-05：**资源增减的演出**（纯 UI 侧 · 零请求）。
  //    ⚠️ 必须在 `S = payload` **之前**把旧 view 的读数抄下来 —— 之后 `S` 就是新的了。
  //    ⚠️ 只在**有旧 view** 时才记（首次加载 / 读档后那次没有"上一步"可比）。
  //    ⚠️ 抄的是**读数**（`readMeters` 那几个数），不是整个 view：
  //    整个 view 有几十 KB，抄一份纯属浪费，而且它随时会被换掉。
  const prevMeters = readMeters(S && S.view);
  // ⚠️ 2026-10-06：**全量快照**（不只是那 5 个读数）—— 变化清单要比的是
  //    "谁进来了、谁出去了、哪件东西换了主人、每个人的 HP/SAN"。
  //    ⚠️ 必须在 `S = payload` **之前**抄（旧的那份就还没被换掉）。
  const prevFull = S && S.view ? S.view : null;
  S = payload;
  if (prevMeters) beforeMeters = prevMeters;
  // ⚠️ 变化清单在**旧 view 与新 view 之间**算一次，结果挂在 `pendingChanges` 上
  //    —— 演出要等 `render()` 之后才能做（那时 DOM 才是新的、落点才找得到）。
  pendingChanges = buildChanges(prevFull, (S && S.view) || null);
  // ⚠️ 属性变化走**文字**那条路（动画不好做，用户裁定）—— 同一时点算好，结算弹窗里写小字。
  pendingAttrLines = attrChangeLines(prevFull, (S && S.view) || null);
  // ⚠️ 一旦回到标题屏，就把**局内**的临时选择清干净（勾了谁 / 三格放了什么 / 弹窗结果）：
  //    它们只活在页面上、账本里没有 ⇒ 不清的话，读另一局回来还留着上一局的勾选与结果文案。
  if (S && S.screen === 'title') resetLocalViewState();
  // ── 结算弹窗的收口（见 `collectResults`）──────────────────────
  //    读档 / 开新局那一下只把游标推到当前长度（**历史不重播**）。
  else if (S) {
    if (feedCursorSkipOnce) { feedCursorSkipOnce = false; feedShown = arr(S.feed).length; }
    else if (!feedCursorReady) { feedCursorReady = true; feedShown = arr(S.feed).length; }
    else collectResults();
  }
  render();
  // 数字滚动**必须在 render 之后**：那时 `.mdb[data-from]` 才在 DOM 里。
  if (S && S.view) rollMeters();
  return payload;
}

