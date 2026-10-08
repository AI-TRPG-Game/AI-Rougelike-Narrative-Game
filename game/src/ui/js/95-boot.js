// ── 启动 ────────────────────────────────────────────────────────
/**
 * **调试口**：`#theme=light` / `#theme=dark` 强制指定主题，`#theme=auto` 撤掉锁定。
 * ⚠️ 它**会写进 localStorage**（与点那颗按钮完全同一条路径）—— 这不是"预览"，
 *    是真的切。用它做两件事：① 截两套主题的对照图；② 在别的机器上复现某个配色问题。
 * ⚠️ 读 URL 只在这一处；解析失败（`#theme=xxx` 之外的东西）**静默忽略** ——
 *    页面 URL 上可能带别的 hash（`#probe` 那种调试用法），不该因此报错。
 */
(function () {
  const m = /(?:^|[#&])theme=(light|dark|auto)(?:&|$)/.exec(String(location.hash || ''));
  if (!m) { applyTheme(savedTheme()); return; }
  applyTheme(m[1] === 'auto' ? null : m[1]);
})();

/**
 * **调试口**：`#open=<事件 id>` ⇒ 首次渲染后自动点开那件事（截图/复现用）。
 *
 * ⚠️⚠️ **位置很要紧**（2026-10-06 踩过三次 TDZ）：它必须在**顶层**、
 *   在启动序列里（`render()` 跑完**之后**）执行。
 *   ⚠️ 我先前把它插进 `render()` 中段 ⇒ 读 `v` / `isTitle` 全部撞
 *   `Cannot access … before initialization` ⇒ **整页白**。
 *   ⇒ 与上面那个 `#theme=` 同一个位置/同一个模式：顶层 IIFE，一次跑完。
 */
(async () => {
  const m = /(?:^|[#&])open=([^&]+)(?:&|$)/.exec(String(location.hash || ''));
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  // ⚠️ 等一拍再点：得让启动序列先把 view 拉回来（那时才真有事件可点）。
  for (let i = 0; i < 60; i++) {
    const vv = S && S.view;
    if (vv && Array.isArray(vv.todo) && vv.todo.some((e) => e.id === id)) {
      detailOpen = { kind: 'event', id: id };
      render();
      return;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  console.warn('[debug] #open=' + id + ' 没等到那个事件（view 里没有这个 id）');
})();

/**
 * **调试口**：`#popup=1` ⇒ 把当前那档 A 弹窗**顶到最前**（截图用）。
 *
 * ⚠️ 同一个坑（2026-10-06 踩过三次 TDZ）：**必须在顶层**、在启动序列里跑。
 * ⚠️ 它只做"重排"（把已存在的弹窗元素重新 append，让它盖住画面）——
 *   **不造数据**、不跳过任何流程，所以截图里看到的就是玩家真正会看到的那一屏。
 */
(async () => {
  const m = /(?:^|[#&])popup=1(?:&|$)/.exec(String(location.hash || ''));
  if (!m) return;
  for (let i = 0; i < 60; i++) {
    const ov = document.getElementById('overlay');
    if (ov && !ov.classList.contains('hidden') && document.getElementById('modal').innerHTML.trim()) {
      document.body.appendChild(ov);
      return;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  console.warn('[debug] #popup=1 没等到弹窗');
})();

(async () => {
  // 离线快照（`ui-snapshot.html`）：数据内联在 `window.__SNAPSHOT__` 里，直接拿它渲染一遍，不去碰后端。
  if (window.__SNAPSHOT__) {
    S = window.__SNAPSHOT__;
    banner = [{ kind: 'ok', text: S.__note || '离线快照（只读）' }];
    render();
    return;
  }
  try {
    const r = await fetch('/api/view', { cache: 'no-store' });
    const j = await r.json();
    // ⚠️ 后端没起来时，静态服务器常常回一份 HTML 404 ⇒ `r.json()` 抛错、或返回一个不带信封的对象。
    //    判据是**带不带 `screen`**，不是"带不带 `view`"：停在标题屏时 `view` 本来就是 `null`，
    //    拿 `j.view` 当真值去判，会把"标题屏"错判成"后端没起来"。
    if (!j || !j.screen) throw new Error('拿到的不是一份信封（HTTP ' + r.status + '）');
    S = j;
    // ⚠️ 首屏**不弹结算**：这一局此前发生过的事都在这份 `feed` 里，
    //    把游标推到位 ＝ 「只看从此刻起新出现的」。
    feedCursorReady = true;
    feedShown = arr(S.feed).length;
    render();
  } catch (e) {
    // ⚠️ 必须**直接**调 renderBanner()：此刻 `S` 还是 null，`render()` 会在第一行就 return。
    // ⚠️⚠️ 2026-10-06 订正：原来这条提示让你起 `python .workbuddy/serve-ui.py`
    //   —— **那个文件已经不存在了**（它早被 `.workbuddy/` 清理掉了），
    //   于是照着做的人只会得到"找不到文件"，**比不提示更糟**。
    // ⇒ 改成**唯一那条真实可用的命令**（`node --watch` ＋ `--dev`，后者让页面自己刷新）。
    // ⚠️ 顺带：真正的启动方式一直是 `node src/ui/server.ts`（端口 5188 是默认值），
    //   旧的 `serve-ui.py` 只是当年的一层壳。
    banner = [{ kind: 'err', text: '没拿到数据 —— 页面本身没问题，是后端没在跑。在 game 目录执行：'
      + 'node --watch src/ui/server.ts --dev --live，再打开 http://127.0.0.1:5188 （' + e.message + '）' }];
    renderBanner();
  }
})();
