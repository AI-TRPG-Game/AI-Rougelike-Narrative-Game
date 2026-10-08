// ═══════════════════════════════════════════════════════════════════
const CANVAS_ZOOM_MIN = 0.6;
const CANVAS_ZOOM_MAX = 2.2;
/** 当前视图 `{scale, x, y}` —— 只活在页面上 */
let cvView = { scale: 1, x: 0, y: 0 };
/** 正在平移吗：`{px, py, ox, oy}`（`px/py` 是指针起点，`ox/oy` 是平移量起点） */
let cvPan = null;
/** 动画抑制的计时器（滚轮连滚时关掉 transition，松手后恢复） */
let cvNoAnimT = null;

/** 把 `cvView` 写进 DOM —— **只写 transform 一条**，别的都不碰。 */
function applyCanvasView(){
  const pan = document.querySelector('.canvas-pan');
  if (!pan) return;
  pan.style.transform = 'translate(' + cvView.x.toFixed(1) + 'px,' + cvView.y.toFixed(1) + 'px) '
    + 'scale(' + cvView.scale.toFixed(3) + ')';
}

/**
 * 钳制平移量 —— **只在放大档位**限制（不许把台面拖出窗口）。
 *
 * ⚠️⚠️ 2026-10-05 踩过一个大坑，第一版写成"上限 = `w*(s-1)/2`，`max(0, …)`"，
 *   探针实测发现：**缩小档位下平移被强行归零**，而缩放锚点公式在缩小档位
 *   **必须**有非零平移量才能维持"指针下那一点不动" ⇒ 两者互相打架，
 *   表现是**一滚轮地图就往一个方向窜**（探针量到锚点漂 169px）。
 *
 *   正确的语义：**`s ≤ 1` 时台面比窗小，压根没有"拖出去"这种可能 ⇒ 不限制**；
 *   `s > 1` 时台面比窗大，最多拖到"刚好露出窗的另一边"为止。
 *   —— 也就是上限只在放大时存在，且上限随放大倍数增长。
 *
 * @param w 窗宽  @param h 窗高
 */
function clampCanvasView(w, h){
  const s = cvView.scale;
  // 缩小 / 原始档位：不限（台面比窗还小，随便拖也不会丢）
  if (s <= 1) return;
  const limX = (w * (s - 1)) / 2;
  const limY = (h * (s - 1)) / 2;
  cvView.x = Math.max(-limX, Math.min(limX, cvView.x));
  cvView.y = Math.max(-limY, Math.min(limY, cvView.y));
}

// ⚠️ 落在**空白**处才起平移（落在卡片上的是"派人的拖拽"，那是另一套手势）。
document.addEventListener('pointerdown', (ev) => {
  const box = ev.target.closest ? ev.target.closest('.canvas') : null;
  if (!box) return;
  // 卡片上不抢：那属于派人的拖拽（下面那段 pointerdown 会接手）
  if (ev.target.closest('.cvchip')) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const r = box.getBoundingClientRect();
  cvPan = { px: ev.clientX, py: ev.clientY, ox: cvView.x, oy: cvView.y, w: r.width, h: r.height };
  if (document.body && document.body.classList) document.body.classList.add('panning');
});

document.addEventListener('pointermove', (ev) => {
  if (!cvPan) return;
  cvView.x = cvPan.ox + (ev.clientX - cvPan.px);
  cvView.y = cvPan.oy + (ev.clientY - cvPan.py);
  clampCanvasView(cvPan.w, cvPan.h);
  applyCanvasView();
});

function endCanvasPan(){
  if (!cvPan) return;
  cvPan = null;
  if (document.body && document.body.classList) document.body.classList.remove('panning');
}
document.addEventListener('pointerup', endCanvasPan);
document.addEventListener('pointercancel', endCanvasPan);

// 滚轮缩放 —— `passive:false` 才拦得住页面滚动。
// ⚠️ 缩放**锚在指针上**：算"指针所指的那个点"平移前后分别落在哪，再平移回去。
document.addEventListener('wheel', (ev) => {
  const box = ev.target.closest ? ev.target.closest('.canvas') : null;
  if (!box) return;
  ev.preventDefault();
  const r = box.getBoundingClientRect();
  // 指针相对窗中心的偏移（缩放的锚点）
  const ax = ev.clientX - (r.left + r.width / 2);
  const ay = ev.clientY - (r.top + r.height / 2);
  const prev = cvView.scale;
  // deltaY 每一格约 100，取 0.0016/px ⇒ 滚一格约 1.16 倍
  let next = prev * (1 - ev.deltaY * 0.0016);
  next = Math.max(CANVAS_ZOOM_MIN, Math.min(CANVAS_ZOOM_MAX, next));
  if (next === prev) return;
  const k = next / prev;
  // ── 锚点不动的推导（照抄这一行，别"顺手简化"）────────────────────────────
  //   台面上一点的屏幕位置：`p' = p*k + t`（p 是它在**未缩放**坐标系里的位置，t 是平移量）。
  //   缩放前后它都在指针 a 处：`a = p*k + t_new` 且 `a = p*prev + t_old`
  //   ⇒ `p = (a - t_old) / prev`，代回得
  //   ⇒ `t_new = a - ((a - t_old)/prev) * next = a - (a - t_old) * k`
  // ⚠️ 这个式子里**旧平移量 `t_old` 必须在算之前就读出来** —— 一边算一边改 `cvView`
  //   会用到新值，得到"缩放时地图往反方向窜"的结果（第一版写错，滚轮一动就跳）。
  const tx = cvView.x, ty = cvView.y;
  cvView.x = ax - (ax - tx) * k;
  cvView.y = ay - (ay - ty) * k;
  cvView.scale = next;
  clampCanvasView(r.width, r.height);
  // 连滚时要跟手 ⇒ 临时关掉 transition
  const pan = document.querySelector('.canvas-pan');
  if (pan) {
    pan.classList.add('noanim');
    if (cvNoAnimT) clearTimeout(cvNoAnimT);
    cvNoAnimT = setTimeout(() => { pan.classList.remove('noanim'); cvNoAnimT = null; }, 260);
  }
  applyCanvasView();
}, { passive: false });

