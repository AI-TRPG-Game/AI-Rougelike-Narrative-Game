// ── 拖拽（C 轮 · 2026-09-20）────────────────────────────────────
// ⚠️⚠️ **拖拽是"点选的快捷方式"，不是第二条通路**：
//    · 落下来做的事与点一下**完全一样** —— 人 = 勾上那个 checkbox（`pickOf(ev).participants`），
//      物 = 选中那个 `<select>`（`pickOf(ev).usedItemId`）。**它不动账本、不发请求**；
//    · 真正的提交仍是那颗「派人去」（`/api/arrange`）⇒ **不新增路由、不新增校验**；
//    · 落点合法性判据**与点选一字不差** —— 共用 `canDispatchTo`（`available && dispatchable`）：
//      ⚠️ 2026-10-05：这一条**此前是写在注释里的一句假话** —— `who` 那一支只判了
//        `src.kind === 'person'`，没判这个人派不派得动 ⇒ 拖一张未入队的人卡进去照样进
//        `participants`（点选那一支是 `disabled` 的）。现在两条路真的走同一个函数了。
//      ⚠️ 刻意**不**在拖拽里另加判据（例如 `max_people`）：那会变成"同一个口径两处实现"，
//      而两处迟早漂。人数上限 / 金币下限这些**规则层闸门**照旧在提交那一刻说话。
// ⚠️ 只用 Pointer Events：HTML5 的 `dragstart/drop` 在**触屏上是坏的**（见 `UI借鉴-苏丹的游戏.md` §6）。
// ⚠️ **必须"先按下、位移超过阈值才算拖"**：否则整张卡的点击（点开详情）会被拖拽吃掉。
// ⚠️ 这一版**不承诺触屏**：触屏真要拖得给卡加 `touch-action:none`，而那会**禁掉左栏滚动**
//    ⇒ 等真上触屏时再定（别现在假装它是全平台的）。
const DRAG_MIN = 6;
/** 按下时记下的源：`{ kind, id, name, x, y }`（`null` = 没在拖） */
let dragSrc = null;
/** 按下时那张**真的卡**（DOM 元素）—— 幽灵是它的克隆，见 `makeGhost` */
let dragEl = null;
/** 这一次按下**有没有变成拖拽**（没变 ⇒ 那一下仍是普通点击） */
let dragMoved = false;
/** 刚拖完的那一下**不算点击**（否则松手会顺手把详情浮层点开） */
let justDragged = false;
/** 上一次拖放松手的时刻（配合 `justDragged` 做 450ms 时间窗守卫，防旗子滞留吞真点击） */
let justDraggedAt = 0;
/** 跟随指针的那张卡（克隆体） */
let ghost = null;
/** 当前指着的落点（`.slotbox[data-drop]`） */
let dropHit = null;

const $ = (id) => document.getElementById(id);
// ⚠️ 这里**不许用 `??`**（ES2020）：旧浏览器遇到它会整段脚本解析失败 ⇒ 全白且无提示。
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/**
 * **LLM 散文的排版净化**（2026-10-07 用户报告「方框符号旁边有莫名其妙的空格」）：
 * 模型偶尔在「」等全角标点旁夹半角空格、甚至把后引号单独甩到下一行行首——
 * 多数正文容器不是 pre-wrap ⇒ 源文本里的换行塌成空格，读起来就是"凭空多一格"。
 * 规则（**只动空白，不碰一个字**）：
 *  · 行内连续空白归一成一个半角空格（含全角空格 \u3000 —— 模型偶尔垫的那种"看着像缩进
 *    其实哪里都不挨着"的一格）；行首尾清零；
 *  · 全角标点（，。！？；：、」』）】》…— 和弯引号 ’”）**前后不留空格** ——
 *    全角标点字形自带空隙，再垫半角空格就是截图里那种"标点旁边凭空一格"；
 *  · 行以收引号/标点开头（模型把 」 单独甩下来）⇒ **并回上一行**。
 * ⚠️ pre-wrap 容器（结局屏等）的换行保留：只在行内与行界动手术。
 * ⚠️ 2026-10-08 起全站正文另有 `line-break:strict` 兜**浏览器自动折行**的行首禁则
 *    （那半截不归这里管 —— 源文本没换行，是折行把 」 挤下去的）。
 */
function tidyProse(s){
  const lines = String(s || '').replace(/\r/g, '').split('\n')
    .map(function (line) {
      let t = line.replace(/[ \t\u3000]+/g, ' ').trim();
      t = t.replace(/ ([，。！？；：、」』）】》…—’”])/g, '$1')
           .replace(/([「『（《【“‘]) /g, '$1')
           .replace(/([，。！？；：、」』）】》…—’”]) /g, '$1');
      return t;
    })
    .filter(Boolean);
  const out = [];
  for (const t of lines) {
    if (out.length && /^[」』）】》，。！？；：、…—]/.test(t)) out[out.length - 1] += t;
    else out.push(t);
  }
  return out.join('\n');
}
/** esc ＋ 净化一步到位（LLM 散文的渲染口都用这个，名字/titre 别用——那两类不需要动文本） */
const escProse = (s) => esc(tidyProse(s));
const arr = (x) => (Array.isArray(x) ? x : []);
const cap = (a) => a.slice(0, 1).toUpperCase() + a.slice(1);

/**
 * 一次事件的**本地暂存**（还没提交的那些选择）。
 *
 * ⚠️⚠️ 2026-10-06 清单第 5.6 条新增 **`handling`**（「两个按钮必须点且只能点一个」）
 *   —— 它是**互斥单选**：`''`（还没选）／ `'brief'`（简略处理）／ `'scene'`（亲自去且仔细处理）。
 *   ⚠️ **初始是空** ⇒ 那一刻 ✔ 是灰的（5.4：「是否已经选择了一种处理方式」不然则按键变灰）。
 *   ⚠️ 它**只存在于页面**（不进账本）—— 处理方式在点 ✔ 的那一刻才变成一次真实的提交动作。
 */
function pickOf(id){
  if(!picks[id]) picks[id] = { participants: [], gold: 0, usedItemId: '', note: '', handling: '' };
  // ⚠️ 旧存档/旧代码路径可能没有 `handling` ⇒ **补上**（读作"还没选"），
  //    少了这一步下面 `sel.handling` 会是 undefined，而 `!!undefined` 也是 false ⇒ 判据恰好对，
  //    但 `.modes` 按钮的高亮会读到 undefined ⇒ 统一在此补齐，一处解决。
  if (picks[id].handling === undefined) picks[id].handling = '';
  return picks[id];
}

/**
 * **事件台没点 ✔ 就退场 ⇒ 台面全清**（2026-10-08 用户裁定第 2 条）。
 *
 * 「×」「点遮罩」「直接点开别的卡」「去自建 / 去下一天」——只要**不是**点 ✔
 * 离开的，摆上去的人物卡和垫的金币**全部回到手牌区**（`delete picks[id]`，
 * 卡带靠 `deskUsedIds()` 立刻把他们画回来）。
 * ⚠️ 只清**待处理**的事件台：「处理中」的回看台读的是账本，没有可清的页面态；
 * ⚠️ 点 ✔ 的两条路（`commit` / `arrange`）**不经过这里** —— ✔ 之后的选择要么
 *   已被服务端扣账（金币）、要么刻意留作回看（见 commit 那段注释），不能删。
 */
function discardDeskPicks(){
  if (!detailOpen || detailOpen.kind !== 'event') return;
  const e = eventOf(detailOpen.id);
  if (e && e.status === '待处理') delete picks[detailOpen.id];
}
/**
 * **物格能选的东西 ＝ 这次已勾选的参与者身上带着的**（2026-09-20 用户裁定「收窄到这次去的人身上带的」）。
 *
 * ⚠️ 为什么不是"全库任选"：`usedItemId` 是**叙事指定**（不进任何算术 —— `rules/ability.ts·bonusesOf`
 *    只加 `carriedItems`），但"选了就必然在场"这条得成立；否则玩家会以为选了匕首就 +1
 *    （真正吃加成的是**主事者**身上那几件）。
 * ⚠️ 一个人都还没勾 ⇒ 池子为空 ⇒ 下拉只剩「（不用物件）」：这**正确** —— 谁去都没定，谈不上带什么。
 * ⚠️ 它是**唯一判据**：下拉选项源（`cardHtml`）／拖拽落点（`canDropOn`）／换人清理（`pick` 处理器）
 *    三处共用 ⇒ 两条路仍然**一字不差**。
 */
function carrierPoolOf(p){
  const meId = S.view.me.id;
  const out = [];
  for (const id of arr(p && p.participants)) {
    const src = (id === meId) ? S.view.me : arr(S.view.people).find((x) => x.id === id);
    const who = (id === meId) ? '我' : ((src && src.name) || id);
    for (const it of arr(src && src.items)) {
      if (!out.some((x) => x.it.id === it.id)) out.push({ it: it, by: who, mine: id === meId });
    }
  }
  return out;
}


