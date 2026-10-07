// user ③ 各块的渲染 —— 《装配规范.md》§四 的逐字模板
//
// 三条纪律：
//   · **顺序 = 越不变越靠前、越易变越靠后**；块之间空行分隔；块标题用 `【】`
//   · **不出现的块必须整段不存在**，不要留空标题
//   · 空态一律按 §0.2 的空态总表写**哨兵**（`（暂无）` / `无`）——**不要省略行**
//
// ⚠️ 本文件是**纯函数**：只把账本映成字符串，不碰 Node、不碰 DOM。
//    ⇒ 可单测、可搬进浏览器。
import { ATTR_KEYS, type AttrKey, type Tier } from '../contract/types.ts';
import { PLAYER_ID, derivePersonStatus, emptyPlacements, findPerson, isAway, player, returnToday, type GameEvent, type Ledger, type Person } from '../ledger/types.ts';
import { carriedItems, effectiveAttrsOf, effectiveItems } from '../rules/ability.ts';
import { nowOf, daypartOf } from '../rules/clock.ts';
import { SCENE_ROUND_CAP, type SceneEndReason } from '../rules/scene.ts';
import { cardLabel } from '../rules/tarot.ts';
import { DESIRE_KITS } from '../rules/desire-kits.ts';
import type { ArchivePlan } from '../rules/archive.ts';
import { calcL } from '../rules/x.ts';

// ── 输入类型（不依赖 turn/，保持 prompt/ 的层次干净）──────────────

export interface HandlingRecord {
  /** 处理者 id（派遣 = 参与的下属；亲自 = 玩家本人） */
  participants: string[];
  /** 本次使用物品的 id（无则 null） */
  usedItemId: string | null;
  /** 玩家投入的金币 P（0 = 未投入）。**它是上限，不是已花的钱** */
  goldInput: number;
  /** 玩家的补充原话 */
  note: string;
}

export interface RenderOptions {
  /** 结算半才有的块 */
  tier?: Tier;
  bonuses?: string[];
  landed?: string[];
  /**
   * **忽略形态**（2026-09-18）：事件没人处理、等到过期时走的那一次结算。
   * ⇒ 【玩家的处理】换成固定的那句"玩家选择忽略这件事…"、且**不出现**【处理者能力】
   *   （没有参与者）。其余块与正常处理**完全一致** —— 这是"总体流程与正常处理一致、
   *   只不过 prompt 改变"的字面落地。
   */
  ignored?: boolean;
  /**
   * **多轮收尾**专用：【场景经过】的逐轮记录（`SceneState.turns`）。
   * ⚠️ 只在收尾那一次出现 —— 中途轮是【此刻是】＋【场景背景】，不需要回溯整场。
   */
  turns?: string[];
}

// ── 小工具 ────────────────────────────────────────────────────

const ATTR_ABBR: Record<AttrKey, string> = {
  争斗: '争',
  敏捷: '敏',
  智慧: '智',
  魅力: '魅',
  社交: '社',
  感知: '感',
};

/**
 * 一个人的六维 —— **装备加成已经加进去**（2026-10-05 用户裁定：「相应的属性值要更新」）。
 *
 * ⚠️ `attrsLine` 是**常驻**上下文里每个人物的那一行（【实体状态】块），
 *    它出现得**比任何单次判定都早** ⇒ 模型对"他有多少"的第一印象来自这里。
 *    改前这里给的是 `p.attrs`（纯基础值）⇒ 模型在整个故事里都拿着**偏低的数**在写他。
 *    ⇒ 现在给有效值（与 `calcA` 判定用的口径**同源**，`rules/ability.ts·effectiveAttrsOf`）。
 * ⚠️ 有加成的项写成 `敏18(15+3)`：既给总数（模型写"他敏捷 18"不会错），
 *    又留基础值（模型能写"他本来只有 15，是靠这把刀撑起来的"）。
 *    无加成的项**只写一个数** —— 不给 "+0" 那种噪音。
 */
function attrsLine(p: Person, l?: Ledger): string {
  const eff = l ? effectiveAttrsOf(l, p) : null;
  return ATTR_KEYS.map((k) => {
    const base = p.attrs[k];
    if (!eff) return `${ATTR_ABBR[k]}${base}`;
    const total = eff[k];
    return total === base ? `${ATTR_ABBR[k]}${base}` : `${ATTR_ABBR[k]}${total}(${base}+${total - base})`;
  }).join(' ');
}

/**
 * **逐件携带物**的完整读法（2026-10-07 用户裁定：
 * 「不生效的物品，在届时注入 LLM 上下文时也要有所体现」）。
 *
 * ⚠️ **为什么不能只给物品名**：`effectiveItems` 改纯槽位顺序后，"带着"与"加成生效"
 *    是**两件事**（第 3 件以后的加成物品带着但不算数）—— 只报名字，
 *    模型会以为四件全在起作用，写出的叙事与真实档位漂移。
 * ⇒ 逐件给四元：**名字(id) · 类别 · 加成 · 生效状态**：
 *    · 加成生效 ⇒ `争斗+1·生效`
 *    · 带加成但被 `BONUS_CAP` 挤掉 ⇒ `敏捷+1·未生效（加成名额已满）`
 *    · 无加成（特殊物品/剧情物）⇒ `无加成`（它们**不受名额限制**，默认就是"在起作用"的叙事物）
 * ⚠️ 生效判据与规则层**同源**（`effectiveItems`，同一处截断）—— UI 的绿槽也是它。
 */
function carriedLineOf(l: Ledger, p: Person): string {
  const carried = carriedItems(l, p);
  if (carried.length === 0) return '未携带';
  const eff = new Set(effectiveItems(l, p).map((i) => i.id));
  return carried
    .map((i) => {
      const bs = (i.attr_bonus ?? []).map((b) => `${b.attr}+${b.bonus}`).join('/');
      const state = bs === ''
        ? '无加成'
        : eff.has(i.id)
          ? `${bs}·生效`
          : `${bs}·未生效（加成名额已满）`;
      return `${i.name}(${i.id})·${i.kind}·${state}`;
    })
    .join('；');
}

/** 人物的状态列 —— **一律派生**，不读任何存储字段（避免双事实源） */
function statusCol(l: Ledger, p: Person): string {
  if (p.id !== PLAYER_ID && isAway(p.id, l, l.clock.day)) {
    const back = returnToday(p.id, l, l.clock.day);
    return back?.reveal_at ? `在途 · 第 ${back.reveal_at.day} 天回` : '在途';
  }
  const s = derivePersonStatus(p);
  if (s !== '正常') return s;
  // ⚠️ 「空闲 / 尚未入队」的分流（2026-09-18 用户裁定）：这一列问的是"**我使不使得动他**"，
  //    对外人（`affiliated = false`）问"空闲"没有意义 —— 玩家根本调不动他。
  //    `affiliated` 就是那个"是否三王子的人"的字段（Phase 4 按《设定.md》阵容表录入）。
  return p.affiliated ? '空闲' : '尚未入队';
}

function recognitionCol(p: Person): string {
  return p.recognized.length === 0 ? '无认可' : p.recognized.join('；');
}

// ── 逐块渲染 ──────────────────────────────────────────────────

/**
 * 【他的欲望】—— 常驻首块，两侧可见。**三行：宣言 / 手段 / 目的**。
 *
 * ⚠️⚠️ **2026-10-06：这一块承载两个维度的判据**（用户裁定「我明确了什么是手段什么是目的」）
 *    —— 每一条欲望都是「**通过 X 来 Y**」，两个半句**各管一个维度**：
 *      · `means`（手段 ＝ X）⇒ **`vouchers.the_proper_way`（正当的手段）** 的唯一判据；
 *      · `proposition`（目的 ＝ Y）⇒ **`欲向`**（无关 / 偏离 / 趋近 / 得偿 / 盛宴）的唯一判据。
 *    ⇒ **只给一边就等于废掉另一个维度**，永远一起给。
 *
 * ⚠️ **这里曾经还有一行「手段牌：…」** —— 那是 `the_proper_way` 的**旧判据**（塔罗「手段」牌）。
 *    2026-10-05 牌被整条删掉 ⇒ 那一维**失去判据**（模型只能凭故事自己猜"这算不算正当"）；
 *    2026-10-06 判据换成**玩家亲口写下的那句具象手段** ⇒ 那一维才真正活过来。
 *    ⚠️ 所以**别再把手段那一行删掉**（它看着像展示字段，其实是判据）。
 *
 * ⚠️ **`宣言` 不参与任何判定**（它是玩家自己写下的中二原话，只作气氛与终局收束）——
 *    块里那句「只作气氛，不参与任何判定」是**刻意写进 prompt 的**：
 *    不写，模型很容易把宣言也当成一条判据去凑。
 * ⚠️ 旧存档 `manifesto` / `means` 是 `undefined` ⇒ 那两行**自动省略**
 *    （`String(undefined)` 会写出 "undefined" 字面量，所以必须显式判空，不能靠 `||` 兜）。
 */
export function desireBlock(l: Ledger): string {
  // ⚠️ **不要写成「宣言：X 判据：Y」那种单行形式** —— 三条都可能是长句，
  //    挤在一行里模型会把它们当**同义复述**读过去（而它们恰恰是三个角色：
  //    宣言给语气、手段给路子、目的给标准）。分行 ＋ 各带标签是刻意的。
  const prop = l.desire.proposition || '（未定）';
  // ⚠️⚠️ **2026-10-06：这一块是「目的 ＋ 手段」两个判据**（用户裁定「我明确了什么是手段
  //    什么是目的」）。原来那句「手段牌」的判据随塔罗一起删了，`the_proper_way`
  //    因此**失去判据**；现在判据换成**玩家亲口写下的那句手段** ⇒ 那一维重新可判。
  //    ⚠️ **两个半句各管一个维度，永远一起给**（只给一边就等于废掉另一个维度）：
  //       · 手段 ⇒ `vouchers.the_proper_way`（正当的手段）
  //       · 目的 ⇒ `欲向`（无关 / 偏离 / 趋近 / 得偿 / 盛宴）
  //    ⚠️ 旧存档 `manifesto` / `means` 是 `undefined` ⇒ 那两行**自动省略**
  //      （`String(undefined)` 会写出 "undefined" 字面量，所以必须显式判空）。
  const lines: string[] = [];
  if (l.desire.manifesto) lines.push(`宣言（他自己写下的原话，只作气氛，不参与任何判定）：${l.desire.manifesto}`);
  if (l.desire.means) lines.push(`手段 —— 判【正当的手段】只看这一句：${l.desire.means}`);
  lines.push(`目的 —— 判【欲向】只看这一句：${prop}`);
  return `【他的欲望】\n${lines.join('\n')}`;
}

/**
 * 【本周氛围】—— 每章一次，由 `chapter_shift` 产出，落在 `ledger.divination.ambition`。
 *
 * ⚠️ **2026-09-22 起真的接线**（此前是恒定哨兵）。
 * ⚠️ 「氛围」全局**只有这一个概念**（用户 2026-09-22 裁定）—— 没有第二份「既有氛围」/
 *    「上周氛围」。⇒ `chapter_shift` 自己的 user ③ 也是**复用这一块**：
 *    占卜那一次它显示的是**上一章**的氛围（第 1 天则是哨兵，因为还没有过）。
 *    换句话说，"已有氛围"不是另一个块，就是这一块**在那一时刻的取值**。
 */
export function ambienceBlock(l: Ledger): string {
  return `【本周氛围】${l.divination?.ambition ?? '（未定）'}`;
}

/**
 * 【玩家欲望】—— `chapter_shift` 侧链 system **末段**的 [欲望命题]（《装配规范.md》§4.4：
 * 带欲望命题的四条侧链，system = 静态头 ＋ 任务指令 ＋ 欲望命题）。
 *
 * ⚠️ 它**不在 user ③**（§4.4 表格：`chapter_shift` 的 user ③ 只有「已有氛围」）——
 *    《契约.md》§三「占卜」指令正文里引用的那个【玩家欲望】，物理落位就是这里。
 * ⚠️ 块名照旧叫【**玩家欲望**】（不是别的侧链那个【当前命题】——那条已删）：
 *    占卜问的是"他想要什么"，不是"他现在这一版命题的措辞"。
 *
 * ⚠️ **2026-10-05 改成两行**（用户裁定「双文本」）：欲望改成玩家从 5 条预写原型里挑，
 *    于是它有**两句**——`宣言`（他亲口写下的原话） ＋ `命题`（干燥的判据）。
 *    **两句都进 prompt、都作为评判标准**（用户原话），但它们的**分工**写在这块里：
 *    宣言给语气，命题给标准。⚠️ 旧存档 `manifesto` 是 `undefined` ⇒ 那一行**自动省略**
 *    （`String(undefined)` 会写出 "undefined"，所以这里必须显式判空）。
 */
export function playerDesireBlock(l: Ledger): string {
  // ⚠️ 2026-10-06：与主链同一口径（宣言 / 手段 / 目的 三行）——
  //    占卜问的是"王城在渴望什么、跟他想要的东西有没有干系" ⇒ 他要什么（目的）
  //    与他打算怎么要（手段）都得给，否则模型只能拿半句话猜。
  const lines: string[] = [];
  if (l.desire.manifesto) lines.push(`宣言：${l.desire.manifesto}`);
  if (l.desire.means) lines.push(`手段：${l.desire.means}`);
  lines.push(`目的：${l.desire.proposition || '（未定）'}`);
  return `【玩家欲望】\n${lines.join('\n')}`;
}

/** 【已处理概要】—— 空态见 §0.2：无归档段写「（暂无）」并只列逐条概要 */
export function summaryBlock(l: Ledger): string {
  const archive = l.summaries.archive.length > 0 ? l.summaries.archive.join('\n') : '（暂无）';
  const recent =
    l.summaries.recent.length > 0
      ? l.summaries.recent.map((r) => `· 第 ${r.day} 天 · ${r.text}`).join('\n')
      : '· （暂无）';
  return ['【已处理概要】', `〔归档〕${archive}`, '〔最近一天〕', recent].join('\n');
}

/**
 * 【未处理 · 处理中】—— 世界此刻**还没出结果**的那些事件。
 *
 * ⚠️ **「已处理」不在这里** —— 它的内容就是上面那块【已处理概要】（**所有**出过结果的事件都写进那里：
 *    正常处理完的、以及没人管、过期后自动结算的 —— 两者在账本里同为 `已结算`，没有区别）。
 *    三个桶的**归属**因此是清楚的：两块合起来正好覆盖三种状态，而**不重复**任何一条信息。
 *    （2026-09-18 用户裁定：**不要指针行、也不要任何"纪律"式提醒** —— 把归属写清楚就够了。）
 *
 * ⚠️ **本事件不进这两个桶**（它就是上面那条【事件卡】），两个理由：
 *    ① 同一信息两处漂移（"不要重复计入"那类 bug 的温床）；
 *    ② **它在本事件的两段式之间会从「待处理」翻成「揭晓待办」**（`turn/handle.ts` 在发结算半
 *       之前就改了状态）——若把它算进来，裁定半与结算半的这段文本会**字节不同**，
 *       而"结算半 = 裁定半全部块原样保留"正是这条链路的立身之本。
 *
 * ⚠️ 表头那句带上「正在处理的这一条不在其中」，但**不能写出其它块的方括号标题**（比如"见上【事件卡】"）
 *    例：`【事件卡】` 是**排在后面**的块，在这里复述它，会让"按标题找块"的断言与解析**全部指错地方**
 *    （实测：块顺序断言当场红）。**规则：块标题只在它自己那一行出现。**
 */
/**
 * ⚠️ `currentEventId = null` ⇒ **生成侧**：没有"正在处理的这一条" ⇒ 不排除任何事件、
 *    标题也**不带**那个括注（§4.1 的桶标题就是光秃秃的 `【未处理 · 处理中】`）。
 */
export function bucketsBlock(l: Ledger, currentEventId: string | null): string {
  const others =
    currentEventId === null ? l.events.live : l.events.live.filter((e) => e.id !== currentEventId);
  // ⚠️⚠️ 2026-10-07 用户裁定（第十五批）：**生成侧要带着详情看世界** ——
  //    只报名字，模型分不清「书房整理」和「武库长戟比试」谁是谁，也就谈不上
  //    "不要生成与之重复或冲突的事件"。⇒ 生成侧（`currentEventId = null`）每条都带正文：
  //      · 未处理 / 处理中 ⇒ 《标题》＋ LLM 当时自己给的事件描述（`content`）；
  //      · 已处理 ⇒ 《标题》＋ LLM 结算时生成的事件概括（`settled_summary`，最近 8 条）。
  //    结算侧（`currentEventId ≠ null`）维持只报标题 —— 那几次调用眼前就摆着事件卡，
  //    详情重复一遍只烧 token（本事件不进桶的判据也不变）。
  if (currentEventId === null) {
    const todo = others
      .filter((e) => e.status === '待处理')
      .map((e) => `《${e.title}》${e.content}`);
    const doing = others
      .filter((e) => e.status === '揭晓待办')
      .map((e) => {
        const who = e.handler ? (findPerson(l, e.handler)?.name ?? e.handler) : '（未定）';
        const back = e.reveal_at ? `（${who} · 第 ${e.reveal_at.day} 天回）` : `（${who}）`;
        return `《${e.title}》${e.content}${back}`;
      });
    const done = others
      .filter((e) => e.status === '已结算' && e.settled_summary)
      .slice(-8)
      .map((e) => `《${e.title}》${e.settled_summary}`);
    return [
      '【未处理 · 处理中 · 已处理】',
      `未处理：${todo.length > 0 ? todo.join('；') : '无'}`,
      `处理中：${doing.length > 0 ? doing.join('；') : '无'}`,
      `已处理（最近几件，全部经过见【已处理概要】）：${done.length > 0 ? done.join('；') : '无'}`,
    ].join('\n');
  }
  const todo = others.filter((e) => e.status === '待处理').map((e) => e.title);
  const doing = others
    .filter((e) => e.status === '揭晓待办')
    .map((e) => {
      const who = e.handler ? (findPerson(l, e.handler)?.name ?? e.handler) : '（未定）';
      return e.reveal_at ? `${who} · 第 ${e.reveal_at.day} 天回` : who;
    });
  return [
    '【未处理 · 处理中】（正在处理的这一条不在其中）',
    `未处理：${todo.length > 0 ? todo.join('；') : '无'}`,
    `处理中：${doing.length > 0 ? doing.join('；') : '无'}`,
  ].join('\n');
}

/**
 * 【实体状态】—— 下沉到 user 段的那一半（**会变**的字段）。
 * 空态纪律：**全空闲也要列全**，值写哨兵（`空闲` / `未携带` / `无`），不要省略行。
 */
export function entityStateBlock(l: Ledger): string {
  const people = [...l.entities.people].sort((a, b) => a.id.localeCompare(b.id));
  const lines = people.map(
    (p) =>
      `${p.id} ${p.name}：${attrsLine(p, l)} · ${statusCol(l, p)} · ${recognitionCol(p)} · 你眼中的ta「${
        p.in_your_eyes || '（无）'
      }」 · 愿展现的真实 ${p.openness}`,
  );
  const carried = l.entities.items
    .filter((i) => i.holder !== null && !i.consumed)
    .map((i) => `${i.id} ${i.name} → ${i.holder}`);
  const itemsLine = `物品：${carried.length > 0 ? carried.join(' ｜ ') + ' ｜ ' : ''}其余：未携带`;
  return ['【实体状态】', ...lines, itemsLine].join('\n');
}

/** 【当前状态】—— 金币 / 玩家 HP·SAN / 五格声望 */
export function currentStateBlock(l: Ledger): string {
  const me = player(l);
  const r = l.scalars.rep;
  // ⚠️⚠️ 2026-10-06 清单第 25 条：**模糊时间轴注入 LLM**
  //   用户原话：「这个时间也要在 LLM 结算事件时注入给它（**简单告诉它现在是什么时间即可，
  //   **不需要特别提醒**；**LLM 预生成的结算不受影响**）」
  //   ⚠️ **只加在【当前状态】这一行里** —— 那一块本来就是"此刻是什么局面"，
  //     时段属于同一类读数 ⇒ 不另起一块（另起一块会让模型当成一条新设定去强调）。
  //   ⚠️ **纯派生**（`rules/clock.ts·daypartOf`），不加任何存储字段。
  const 时段 = daypartOf(l.clock.usedToday);
  return `【当前状态】现在是 ${时段} · 第 ${l.clock.day} 天 · 金币 ${l.scalars.gold} · HP ${me.hp}/3 · SAN ${me.san}/3 · 声望 善${r.善名} 恶${r.恶名} 侠${r.侠名} 怪${r.怪名} 权${r.权势}`;
}

/** 【事件卡】—— 标题 · 地点 · 正文 · 档位 · 参考属性 · 人数 · 处理花费 · 最低投入 */
export function eventCardBlock(ev: GameEvent): string {
  // ⚠️ 印的是**人物 id**（本函数拿不到账本 ⇒ 拿不到名字）。紧邻的【实体状态】块里每一行都是
  //    「`npcXXX 名字 …`」⇒ 模型认得出他是谁（不为此改函数签名：那会牵动三处装配与文本断言）。
  const req = ev.required_person ? ` · 非 ${ev.required_person} 不可` : '';
  return [
    `【事件卡】${ev.title} · ${ev.stage} · ${ev.content} · 档位 ${ev.tier} · 参考属性 ${
      ev.hint_attr.join('/') || '无'
    } · 人数 ${ev.min_people}~${ev.max_people} · 处理花费 ${ev.cost} · 最低投入 ${ev.min_gold} 金币${req}`,
  ].join('\n');
}

/** 【玩家的处理】—— 处理者 · 使用物品 · 投入金币 P · 补充原话 */
export function handlingBlock(l: Ledger, ev: GameEvent, h: HandlingRecord): string {
  const who = h.participants
    .map((id) => {
      const p = l.entities.people.find((x) => x.id === id);
      return p ? `${p.name}(${p.id})` : `未知(${id})`;
    })
    .join('、');
  const item = h.usedItemId
    ? (() => {
        const it = l.entities.items.find((x) => x.id === h.usedItemId);
        return it ? `${it.name}(${it.id})` : `未知(${h.usedItemId})`;
      })()
    : '无';
  // ⚠️⚠️ 2026-10-07 用户裁定：**不给钱也是一条合法的路**（玩家可以尝试用嘴皮子绕过
  //    开销）—— 前端不再拿 `min_gold` 拦 ✔。⇒ 事件标了最低投入、玩家却一枚没给时，
  //    这里要**如实点破**，让 LLM 裁定对方买不买账（拒绝 / 抬价 / 被说服皆可），
  //    而不是让 LLM 以为钱已经照付了、顺着白嫖写出"双方谈妥"。
  const goldBypass =
    ev.min_gold > 0 && h.goldInput <= 0
      ? `。玩家尝试不直接支付金币（事件最低 ${ev.min_gold}，他一枚没给，想靠口头方案把事办成 —— 对方是否接受，由你裁定）`
      : '';
  return `【玩家的处理】处理者 ${who} · 使用物品 ${item} · 投入金币 ${h.goldInput}（事件最低 ${
    ev.min_gold
  }；0 = 未投入） · 补充 "${h.note}"${goldBypass}`;
}

/**
 * 【玩家的处理】的**忽略形态**（事件没人处理、等到过期）—— 文案**逐字**来自用户 2026-09-18 裁定。
 * ⚠️ 这一句同时承担了两件事：交代处境（玩家选择忽略）＋ 交代任务（按重要程度生成结果与概要）。
 *    ⇒ 因此 `system` 里的**结算指令逐字不变**：忽略结算与正常结算**共用同一段前缀缓存**。
 */
export const IGNORE_NOTE =
  '玩家选择忽略这件事，根据这件事的重要程度，请你直接生成相应的结算结果与概要。';

export function ignoredHandlingBlock(): string {
  return `【玩家的处理】${IGNORE_NOTE}`;
}

/** 【处理者能力】—— 参与者逐人六维 ＋ 携带物品（逐件：类别 · 加成 · 是否生效） */
export function abilityBlock(l: Ledger, participantIds: readonly string[]): string {
  const lines = participantIds.map((id) => {
    const p = l.entities.people.find((x) => x.id === id);
    if (!p) return `未知(${id})`;
    // ⚠️⚠️ 2026-10-05（用户裁定：「要检查给 LLM 的提示词，相应人物要有词条表示携带了哪些物品，
    //    相应的属性值要更新，要告诉大模型装备的数值已经生效了」）：
    //    **给的是有效值**（基础 + 他身上装备的加成），**不是基础值**。
    //    理由：判定用的 `A` 是规则层拿 `effectiveAttrsOf` 算的（`rules/ability.ts`），
    //    而它**不是**这里给的数字。改前这里只给 `p.attrs` ＋ 一句"携带加成 +3"，
    //    等于**要模型自己做加法** —— 它加错了，叙事就会与真正的档位不符，
    //    而这种错**不会报错**（prompt 照发、模型照答），只会在结算时读出"他明明 18 怎么写成 15"。
    //    ⇒ 数字口径与规则层**同源**（同一份 `effectiveAttrsOf`，两处不许各算一份）。
    //    ⚠️ 括号里**同时保留基础值**（`18=15+3`）：模型要能引用"他本来只有 15"这类说法，
    //    而这也让它知道哪几项是被装备抬上去的（"靠装备撑起来的那一项"是叙事素材）。
    const eff = effectiveAttrsOf(l, p);
    return `${p.name} ` + ATTR_KEYS.map((k) => {
      const base = p.attrs[k];
      const total = eff[k];
      return total === base
        ? `${ATTR_ABBR[k]}${base}`
        : `${ATTR_ABBR[k]}${total}(${base}+${total - base})`;
    }).join(' ');
  });
  // ⚠️ 2026-10-07（用户裁定）：携带物**逐件**给全 —— 名字(id) · 类别 · 加成 · 生效状态。
  //    旧的「携带加成 短匕首(i001)、药(i002)」只报名字：模型分不清"带着"与"算数"，
  //    而纯槽位顺序下这两件事**经常不一样**（第 3 件以后的加成不生效）。
  const carrying = participantIds.map((id) => {
    const p = l.entities.people.find((x) => x.id === id);
    return p ? `${p.name}：${carriedLineOf(l, p)}` : null;
  }).filter((s) => s !== null);
  return `【处理者能力】${lines.join(' · ')} · 携带 ${carrying.length > 0 ? carrying.join('；') : '无'}`;
}

/** 【判定结果】—— **只回填 `{档位, 加成}`**：`d20` / `A` / `R` 永不外泄（防剧透 + 防复述数字） */
export function rollResultBlock(tier: Tier, bonuses: readonly string[]): string {
  return `【判定结果】${tier} · 加成 ${bonuses.length > 0 ? bonuses.join('、') : '无'}`;
}

/**
 * 【系统已落账】—— 规则层**已经记过**的那些变化，摊开给模型看，免得它重复写进 `delta`。
 *
 * ⚠️ 块名**不带命令语气**（2026-09-18 用户裁定）：原名「【已落账 · 不要重复计入】」，
 *    那句"不要重复计入"是在**指控模型会犯错**，属误导性话语。防重复靠的是**把已记过的摊开给它看**
 *    ＋ Delta 的「只写这张清单之外的新变化」，不靠训话。
 * ⚠️ **`P`（托管投入）不进这张清单** —— 它是**上限**不是"已花的钱"。
 *    写进去会让模型以为金币已扣 ⇒ **全额退款**式 bug。这是设计里最直接的一个坑。
 */
export function landedBlock(items: readonly string[]): string {
  return `【系统已落账】${items.length > 0 ? items.join(' / ') : '无'}`;
}

// ── 组装 ──────────────────────────────────────────────────────

/**
 * `resolve` 的 user ③。
 * 顺序 = 《装配规范.md》§四.2 的裁定半块 + §四.3 的结算半增量块（【判定结果】【已落账】）。
 */
export function renderResolveUser(
  l: Ledger,
  ev: GameEvent,
  h: HandlingRecord | null,
  o: RenderOptions = {},
): string {
  const blocks = [
    desireBlock(l),
    ambienceBlock(l),
    summaryBlock(l),
    bucketsBlock(l, ev.id),
    entityStateBlock(l),
    currentStateBlock(l),
    eventCardBlock(ev),
  ];
  if (o.ignored) {
    // 忽略形态：没有参与者 ⇒ 只有【玩家的处理】，**没有**【处理者能力】（块整段不存在）
    blocks.push(ignoredHandlingBlock());
  } else {
    blocks.push(handlingBlock(l, ev, h!), abilityBlock(l, h!.participants));
  }
  if (o.tier) blocks.push(rollResultBlock(o.tier, o.bonuses ?? []));
  if (o.landed) blocks.push(landedBlock(o.landed));
  blocks.push(
    o.ignored
      ? '按【结算】指令输出结算结果。'
      : '按【' + (o.tier ? '结算' : '裁定') + '】指令输出' + (o.tier ? '结算结果' : '裁定结果') + '。',
  );
  return blocks.join('\n\n');
}

/**
 * 【本日调度】。
 *
 * ⚠️ 它不是《契约.md》§三 里那块【生成调度参数】：那边还带「自由事件条数上限 <N>」，
 *    而条数铁律（≤5）已经写死在**指令正文**的【硬约束】里 ⇒ 这里**不再复述一遍数字**。
 *    （2026-09-18 用户裁定：**以《装配规范.md》为主** ⇒ 两份冲突处照 §4.1 走。）
 * ⚠️ `L` 取自 `rules/x.ts` 的 `calcL().cap` —— **不在这里另算一个公式**（那会立刻漂成两份事实源）。
 *
 * ⚠️ **`[硬]` 前缀**（2026-09-19 · P4-E）：硬种子（checkpoint）与软钩子**必须能分辨** ——
 *    `INSTRUCTION_COMPOSE` 明写「**硬种子必须被承接**，没被承接的软种子当天作废」，
 *    而两者在列表里若长得一样，那句指令就**没有指称对象**（模型不知道哪条是硬种子），
 *    硬种子还会被误当成"可弃的钩子"。
 *    ⚠️ 这是**照既定判据实现**，不是新规矩。判据原文：「系统在 prompt 里以
 *      「**必须承接的硬种子** `s1 / s2`…」列出约束」（原出处文档已删，故在此内联）。
 *    ⚠️ 硬种子那三句提示语本身（`rules/checkpoint.ts`）**逐字不动** —— 前缀是规则层加的
 *      结构标记，不是改写提示语。
 */
export function dispatchBlock(l: Ledger): string {
  const seeds =
    l.seeds.length > 0
      ? l.seeds.map((s) => `${s.source === '硬种子' ? '[硬] ' : ''}${s.code} ${s.title} —— ${s.content}`).join('；')
      : '无';
  return [
    '【本日调度】',
    `种子：${seeds}`,
    `行动点上限：L ≤ ${calcL(l, l.clock.day).cap}（本日自由事件的行动点预算上限：**只数今天新生成自由事件的 \`cost\` 之和**；跨天事件（\`cost > 4\`）按它在今天占的 ≤ 4 点计）`,
  ].join('\n');
}

/**
 * `compose_day`（生成）的 user ③ —— 《装配规范.md》§4.1 的逐字顺序。
 *
 * ⚠️ 与 `resolve` 侧的**顺序不同，且是有意的**：这边【未处理 · 处理中】排在**最后**（§4.1），
 *    `resolve` 那侧排在【已处理概要】之后（§4.2）。**照抄各自的小节，别顺手"统一"**。
 * ⚠️ 生成侧没有"正在处理的这一条" ⇒ 桶标题**不带**那个括注（`bucketsBlock(l, null)`）。
 */
export function renderComposeUser(l: Ledger): string {
  const blocks = [
    desireBlock(l),
    ambienceBlock(l),
    summaryBlock(l),
    entityStateBlock(l),
    currentStateBlock(l),
    dispatchBlock(l),
    bucketsBlock(l, null),
    '按【生成】指令输出本日事件。',
  ];
  return blocks.join('\n\n');
}

/**
 * 【玩家的处理方式】—— 玩家自建事件时**这一次输入的原话**。
 *
 * ⚠️ 名字是**处理方式**、不是"愿望"（2026-09-19 用户裁定）：他给的是**打算怎么做**，
 *    不是一句抽象的许愿 —— 这直接决定 LLM 能不能把它落成一件"要投入才有结果"的事。
 *
 * ⚠️ **它不是【他的欲望】**，两块都要在：
 *    · 【他的欲望】= 开局塔罗定下的**欲望命题**（常驻、每份 user ③ 的首块）⇒ 给的是**底色**；
 *    · 【玩家的处理方式】= 他**这次具体打算做什么** ⇒ 给的是**题目**（指令拿它做成一条事件）。
 *    《契约.md》§三 创建事件那条【边界】写的是「**若他写成**"我做到了 XX"」—— 句子是玩家敲进去的，
 *    这正说明它是**这一次的输入**，不是开局那张牌。
 */
export function approachBlock(approach: string): string {
  return `【玩家的处理方式】"${approach}"`;
}

/**
 * `compose_day`（玩家自建 · 「我想做点什么」）的 user ③。
 *
 * ⚠️ **《装配规范.md》§四 没有这一份**（只定了 4.1 生成 / 4.2·4.3 resolve / 4.4 侧链）⇒
 *    块清单由这里定：**取 §4.1 的骨架，把【本日调度】换成【玩家的处理方式】**。理由具体 ——
 *    自建**豁免全部额度检测**（不占条数、不进 `L`，见《规则.md》）⇒ 调度块对它**没有意义**；
 *    其余块（概要 / 实体状态 / 当前状态）都是指令里"接着世界现在的样子写""不承认既成事实"所必需的。
 *    顺序照样守「越不变越靠前」：处理方式紧挨末行（它是最易变的那一段）。
 */
export function renderCreateUser(l: Ledger, approach: string): string {
  const blocks = [
    desireBlock(l),
    ambienceBlock(l),
    summaryBlock(l),
    entityStateBlock(l),
    currentStateBlock(l),
    approachBlock(approach),
    '按【创建事件】指令输出这条事件。',
  ];
  return blocks.join('\n\n');
}

// ── 多轮「穿越」专用（Phase 3 · 《规则.md》§二 路径 ⑤）────────────
//
// ⚠️ 这一族的块**只出现在多轮**，与单轮那族名字不同：
//    【本场景已落账】≠【系统已落账】—— 前者的口径是"整场累计"，后者是"这一次事件"。
//    ⚠️ 原"本轮判定"那块（掷骰回填）已随"场景不掷骰"的裁定整条退休（2026-10-07）。

/** 人物 id → `名字(id)`（与 `handlingBlock` 同形；找不到也不静默） */
function nameId(l: Ledger, id: string): string {
  const p = l.entities.people.find((x) => x.id === id);
  return p ? `${p.name}(${p.id})` : `未知(${id})`;
}

/**
 * 【此刻是】—— 多轮专用：把视野收进场景，并交代**第几轮 / 上限几轮**。
 * ⚠️ 上限取自 `SCENE_ROUND_CAP`，与 `turn/scene.ts` 的强制截断**共用一份**（别写死 7）。
 */
export function sceneNowBlock(ev: GameEvent, round: number): string {
  return `【此刻是】「${ev.title}」场景内，第 ${round} 轮（上限 ${SCENE_ROUND_CAP}）`;
}

/**
 * 【场景背景】—— 地点 · 在场人物 · 事件卡要点。
 * ⚠️ 它**不是**【事件卡】的复述（那张已在上面）：这里是"**这一场戏**的取景框"。
 *    多轮的判定依据是「本轮描述 ＋ 场景背景」⇒ 这块就是那个"场景背景"。
 */
export function sceneContextBlock(l: Ledger, ev: GameEvent, presentIds: readonly string[]): string {
  const who = presentIds.length > 0 ? presentIds.map((id) => nameId(l, id)).join('、') : '无';
  return `【场景背景】${ev.stage} · 在场 ${who} · 要点 ${ev.content}`;
}

/**
 * 【本场景已落账】—— 多轮的"已记过的"清单（`SceneState.ledgered`，**整场累计**）。
 * ⚠️ 块名不带命令语气，理由同 `landedBlock`（2026-09-18 用户裁定：不写"不要重复计入"式训话）。
 * ⚠️ **托管投入 `P` 同样不进这张清单** —— 它是上限不是已花的钱；写进去会得到"全额退款"式 bug。
 */
export function sceneLandedBlock(items: readonly string[]): string {
  return `【本场景已落账】${items.length > 0 ? items.join(' / ') : '无'}`;
}

/**
 * 【场景经过】—— 收尾专用：逐轮摊开（玩家说了什么 / 判定 / 关键回应）。
 * ⚠️ 收尾的产物 `summary` 会**覆盖**这份逐轮记录 ⇒ 这是逐轮细节**最后一次**出现在 prompt 里。
 */
export function sceneTrailBlock(turns: readonly string[]): string {
  if (turns.length === 0) return '【场景经过】（本场景尚未产生可记录的轮次）';
  return `【场景经过】\n${turns.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
}

/** 【结束原因】—— 只认 `SCENE_END_REASONS` 三种（枚举由 `rules/scene.ts` 独占） */
export function sceneEndReasonBlock(reason: SceneEndReason): string {
  return `【结束原因】${reason}`;
}

/**
 * `resolve` · **多轮每一轮**的 user ③。
 *
 * 顺序照样守「越不变越靠前」：欲望 → 氛围 → 概要 → 桶 → 实体状态 → 当前状态 → 事件卡
 *   →【此刻是】→【场景背景】→【玩家的处理】→【处理者能力】→【本场景已落账】。
 *
 * ⚠️⚠️ **2026-10-07 用户裁定：场景内不做投掷判定** ⇒ 每轮只有**一次**叙事调用，
 *    "本轮判定"那块（掷骰回填）随两段式一起退休 —— 没有档位、没有加成可回填。
 * ⚠️ **中途轮就是玩家的一句话**：【玩家的处理】块的 `note` 装的就是他那句话。
 */
export function renderNarrateUser(
  l: Ledger,
  ev: GameEvent,
  h: HandlingRecord,
  round: number,
  presentIds: readonly string[],
  o: RenderOptions = {},
): string {
  const blocks = [
    desireBlock(l),
    ambienceBlock(l),
    summaryBlock(l),
    bucketsBlock(l, ev.id),
    entityStateBlock(l),
    currentStateBlock(l),
    eventCardBlock(ev),
    sceneNowBlock(ev, round),
    sceneContextBlock(l, ev, presentIds),
    handlingBlock(l, ev, h),
    abilityBlock(l, h.participants),
  ];
  blocks.push(sceneLandedBlock(o.landed ?? []));
  blocks.push('按【叙事】指令推进这一轮。');
  return blocks.join('\n\n');
}

/**
 * `resolve` · **多轮收尾**的 user ③。
 *
 * ⚠️ 收尾**没有**【玩家的处理】【处理者能力】：这一场已经在进行中，
 *    要交代的是"整场经过 + 为什么结束"，而不是"谁带着什么去做"。
 * ⚠️ 【场景经过】之后紧跟【结束原因】—— 模型据此决定 `summary` 写成什么样
 *    （`轮数用尽` 的半截话，只能靠它记下来）。
 */
export function renderWrapUser(
  l: Ledger,
  ev: GameEvent,
  reason: SceneEndReason,
  o: RenderOptions = {},
): string {
  const blocks = [
    desireBlock(l),
    ambienceBlock(l),
    summaryBlock(l),
    bucketsBlock(l, ev.id),
    entityStateBlock(l),
    currentStateBlock(l),
    eventCardBlock(ev),
    sceneTrailBlock(o.turns ?? []),
    sceneEndReasonBlock(reason),
    sceneLandedBlock(o.landed ?? []),
  ];
  blocks.push('按【收尾】指令输出收尾结算。');
  return blocks.join('\n\n');
}

// ── 低频侧链（Phase 4）────────────────────────────────
//
// ⚠️ 侧链与主链在「欲望命题」上**落位不同**：主链住 user ③ 首块【他的欲望】；
//    侧链把它拼在 **system 末段**（[静态头]＋[任务指令]＋[欲望命题]，把会变的那一小段压在
//    最末，静态头与任务指令两段的字节前缀都保住）。`archive` 例外地不带欲望命题。
// ⚠️ `opening` 是**唯一不消费命题**的一条（2026-10-05）—— 命题正是它这一次要产出的东西，
//    把它照抄过来等于注入一个空哨兵（`（未定）`），把"产出命题的那一次"和"消费命题的那一次"混成一件事。

/**
 * 【本局到目前为止】—— 给**全量**概要的那条（`ending` 侧链）。
 * ⚠️ 与主链【已处理概要】（`summaryBlock`）的口径差：那边是"归档 ＋ 最近一天"，
 *    这边**给全**——"全局只调一次，索性给全"。
 */
export function fullSummaryBlock(l: Ledger): string {
  const archive = l.summaries.archive.length > 0 ? l.summaries.archive.join('\n') : '（暂无）';
  const recent =
    l.summaries.recent.length > 0
      ? l.summaries.recent.map((r) => `· 第 ${r.day} 天 · ${r.text}`).join('\n')
      : '· （暂无）';
  return ['【本局到目前为止】', `〔归档〕${archive}`, '〔逐条〕', recent].join('\n');
}

/**
 * 【要归并的几天】—— `archive` 侧链 user ③ 的**第一块**：待归并的逐条概要原文，按时间序。
 *
 * ⚠️ 与【本局到目前为止】（`fullSummaryBlock`）的差别：那边**给全**，这边**只给要并的那几天** ——
 *    《契约.md》§5.7 明写调用输入是「待归并段 ≈2000 字」，不是全量。给全会让模型
 *    把不该并的那几天也一起并进去（而数组被搬走之后**没人看得出**）。
 * ⚠️ 每行 `· 第 N 天 · <原文>` 与其它概要块**同形** —— 同一个读者读起来才不别扭。
 * ⚠️ 顺序 = `recent` 原顺序 = **时间序**（§6.10 指令正文要求"按时间序"）⇒ 这里**不许再排序**：
 *    `plan.items` 是 `recent.filter(...)` 的产物，本来就保序。
 */
export function archiveSourceBlock(plan: ArchivePlan): string {
  const body =
    plan.items.length > 0 ? plan.items.map((r) => `· 第 ${r.day} 天 · ${r.text}`).join('\n') : '· （暂无）';
  return ['【要归并的几天】', body].join('\n');
}

/**
 * 【已有的归档段】—— `archive` 侧链 user ③ 的**第二块**：前几次归并出来的段，**原样**给出。
 *
 * ⚠️ 空态哨兵是「**无**」、**不是**「（暂无）」——判据原文：「前几次归并出来的段，原样给出；
 *    **还没有则写「无」**」（原出处文档已删，故在此内联）。§0.2 空态总表里两者分工不同：
 *    `无` 用于"本来就没有这类东西"（归档区一开始就是空的），`（暂无）` 用于"这一格暂时空着"。
 * ⚠️ 给它的目的是"不要重写、不要抄进来"（§6.10）⇒ **必须原样**：不许摘要、不许截断、
 *    不许只给最后一段（模型看不见旧段就可能把旧内容重新写一遍）。
 */
export function existingArchiveBlock(l: Ledger): string {
  const archive = l.summaries.archive.length > 0 ? l.summaries.archive.join('\n') : '无';
  return ['【已有的归档段】', archive].join('\n');
}

/** `archive` 的 user ③ —— 两块 ＋ 末行（system 里**没有**欲望命题，它与主链和另外四条侧链都不同） */
export function renderArchiveUser(l: Ledger, plan: ArchivePlan): string {
  return [archiveSourceBlock(plan), existingArchiveBlock(l), '按【归并】指令输出新的一段归档。'].join('\n\n');
}

// ── 终局（`ending` 侧链 · 《契约.md》§5.8「终局注入」）──────────────
//
// ⚠️ 它与日常**相反**：日常给"最近一天"，终局**给全部**（§5.8 原文「注入粒度与日常相反」）。
//    四个块里**只有【玩家的欲望命题】不在 user 段** —— 它按四条带欲望命题侧链的统一拼法
//    压在 **system 末段**（`assembleEnding`）。⇒ 同一句命题**不许**在两处各出现一次。
//    该块**沿用** `ending` 自己的名字，
//    与 `chapter_shift` 的【玩家欲望】**不是同一个串** —— 别顺手统一。

/**
 * 【玩家的欲望命题】—— `ending` 侧链 system **末段**的 [欲望命题]。
 *
 * ⚠️ 它与 `playerDesireBlock`（`chapter_shift` 用的【玩家欲望】）是**同一件事、两个块名** ——
 *    各自照《契约.md》§三 自己那一节的正文：占卜写【玩家欲望】、结局写带"命题"的那个名字。
 *    ⇒ 实现上**不共用**块名，也**别"顺手统一"**；真要统一，先改《契约.md》§三 那两处正文。
 * ⚠️ 用户裁定（2026-09-18）：结局这一块定名【**玩家的欲望命题**】。它与《契约.md》§三「结局」
 *    正文的【他的欲望命题】、§5.8 的【欲望命题】**都不同** —— 文档同步尚未做（留待用户裁定），
 *    **不要**回头照文档把它改回去。
 *
 * ⚠️ **2026-10-05 加了宣言那一行**（用户裁定「双文本」，两句都进 prompt）：
 *    结局话术是**回顾他这一生**的那一段 ⇒ **宣言正是它的收束对象**
 *    （"他当初喊的是这句话"）。所以这里两句都给，宣言在前、命题在后。
 *    ⚠️ 旧存档 `manifesto` 为 `undefined` ⇒ 那一行自动省略（不靠 `||` 兜，见 `desireBlock`）。
 */
export function endingDesireBlock(l: Ledger): string {
  // ⚠️ 2026-10-06：三行都给。结局要回顾"他这一生走的是哪条路、要的是什么"——
  //    **手段那一行在结局反而更要紧**（「正当的手段」正是终局两把钥匙之一）。
  const lines = [
    ...(l.desire.manifesto ? [`宣言：${l.desire.manifesto}`] : []),
    ...(l.desire.means ? [`手段：${l.desire.means}`] : []),
    `目的：${l.desire.proposition || '（未定）'}`,
  ];
  return `【玩家的欲望命题】\n${lines.join('\n')}`;
}

/**
 * 【玩家的 28 天】—— `ending` 侧链 user ③ 的**第一块**：已处理概要**全量**。
 *
 * ⚠️ 与【本局到目前为止】（`fullSummaryBlock`）**内容同源、标题不同**
 *    —— 两边都是逐字正文（占卜/归并那边写【本局到目前为止】、ending 写【玩家的 28 天】）
 *    ⇒ **照各自的正文走，不许"顺手统一"**。
 * ⚠️ 第三行是〔逐条〕、**不是**主链那个〔最近一天〕：终局给的是全量，不是某一天的切片。
 */
export function endingSummariesBlock(l: Ledger): string {
  const archive = l.summaries.archive.length > 0 ? l.summaries.archive.join('\n') : '（暂无）';
  const recent =
    l.summaries.recent.length > 0
      ? l.summaries.recent.map((r) => `· 第 ${r.day} 天 · ${r.text}`).join('\n')
      : '· （暂无）';
  return ['【玩家的 28 天】', `〔归档〕${archive}`, '〔逐条〕', recent].join('\n');
}

/**
 * 三格里的 id → 写给人看的名字（**不带 id** —— 与 summary 同一条纪律）
 *
 * ⚠️⚠️ **2026-10-06 用户裁定：要带上凭证的 `desc`。**
 *   原话：「结局评价的核心标准：**"你的欲望"块全文，而且卡槽中的卡的描述也要呈现**」
 *   ⇒ 三格各读**那条凭证的 `desc`** 并附在名字后面 —— 那是玩家亲手放进去的东西，
 *   **结局判词要看得见它**。
 * ⚠️ 凭证按 `ledger.vouchers` 找（`recalled_day === null` 的那条），**不按 placements 反推** ——
 *   凭证是**判定的输入**（`flavorOf` 读它），从 id 反查是同一份数据的另一个方向。
 * ⚠️ **找不到凭证时不编一句** —— 只给名字（旧行为），`desc` 那一截整个不出现。
 */
function endingNameOf(l: Ledger, id: string | null, kind: '成果' | '手段' | '共鸣'): string {
  if (id === null) return '空';
  // ⚠️ 凭证的 `desc`（**三类都有**：物品 / 事件 / 人物情感）
  const vou = l.vouchers.find(
    (v) =>
      v.recalled_day === null &&
      (kind === '成果' ? v.item === id : kind === '共鸣' ? v.person === id : v.event === id),
  );
  const withDesc = (name: string): string => (vou && vou.desc ? `${name} —— ${vou.desc}` : name);
  if (kind === '成果') return withDesc(l.entities.items.find((x) => x.id === id)?.name ?? `未知(${id})`);
  if (kind === '共鸣') {
    // §三 正文写的是「把认可交给他的人 ＋ 那句话」⇒ 名字后面把人给过的认可原样带上
    const p = findPerson(l, id);
    if (!p) return `未知(${id})`;
    const base = p.recognized.length > 0 ? `${p.name} —— ${p.recognized.join('；')}` : p.name;
    // ⚠️ 两段拼接时用「｜」分隔（原来只有一段，不分隔会读成一句话）
    return vou && vou.desc ? `${base}｜凭证：${vou.desc}` : base;
  }
  const e = l.events.live.find((x) => x.id === id);
  return e ? withDesc(`「${e.title}」`) : `未知(${id})`;
}

/**
 * 【最后一天放的格子】—— 三格各放了什么（§5.8 user ③ 第 ② 项 / §三「结局」正文）。
 *
 * ⚠️ **空格子写「空」**（§三正文那个 `｜ **空**`）—— 成功结局里成果格可能为空，
 *    手段 / 共鸣也各自可能空着（那正是档 B 的来源）。
 * ⚠️ 内容取自 **`ledger.ending.placements`**（= 判定时放的那一次）—— **不是**调用侧另给一份，
 *    否则"模型看到的格子"与"判定用的格子"会分成两份（同 `applyArchive` 那条"读同一份 plan"）。
 * ⚠️ 每格后面**带那条凭证的 `desc`**（2026-10-06 用户裁定：「卡槽中的卡的描述也要呈现」）。
 */
export function placementsBlock(l: Ledger): string {
  const p = l.ending?.placements ?? emptyPlacements();
  return [
    '【最后一天放的格子】',
    `  成果格：${endingNameOf(l, p.成果, '成果')}`,
    `  手段格：${endingNameOf(l, p.手段, '手段')}`,
    `  共鸣格：${endingNameOf(l, p.共鸣, '共鸣')}`,
  ].join('\n');
}

/** 众数（并列时取**先出现的**那个）；空数组 ⇒ `''`。只在 `portraitBlock` 里用。 */
function modeOf(xs: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * 【他这一局的样子】—— §5.8 的「这一局的画像」：六维**终值** · 常出没的地方 · 常打交道的人 · 声望五格。
 *
 * ⚠️ **常出没的地方 / 常打交道的人没有现成的落账字段** ⇒ 从【已结算的事件】里取**众数**：
 *    地点取 `GameEvent.stage`、人物取 `participants`（排除玩家自己）。
 *    **判据只在这一处**（`modeOf` 的调用点）—— 要换口径只改这一个函数。
 * ⚠️ 只数**已结算**的：没出结果的事还没"发生过"。
 * ⚠️ 空态哨兵写「无」—— §0.2：`无` 用于"本来就没有这类东西"，`（暂无）` 用于"这一格暂时空着"。
 * ⚠️ 它与【当前状态】（`currentStateBlock`）**不是一回事**：那边是"此刻的金币 / HP / SAN / 声望"，
 *    这边是**整局的收束画像**（六维是终值）。两块各有各的落点，不要合并。
 */
export function portraitBlock(l: Ledger): string {
  const me = player(l);
  const attrs = ATTR_KEYS.map((k) => `${k}${me.attrs[k]}`).join(' · ');
  const settled = l.events.live.filter((e) => e.status === '已结算');
  const stage = modeOf(settled.map((e) => e.stage));
  const who = modeOf(
    settled
      .flatMap((e) => e.participants.filter((id) => id !== PLAYER_ID))
      .map((id) => findPerson(l, id)?.name ?? id),
  );
  const r = l.scalars.rep;
  return (
    `【他这一局的样子】六维 ${attrs} · 常出没的地方 ${stage || '无'} · 常打交道的人 ${who || '无'} · ` +
    `声望五格 善${r.善名} 恶${r.恶名} 侠${r.侠名} 怪${r.怪名} 权${r.权势}`
  );
}

/**
 * `ending` 的 user ③ —— **2026-10-06 起：直接复用 `renderComposeUser` ＋ 两块追加**。
 *
 * ⚠️⚠️ **用户裁定**：「在生成结局时，我们要注入给 LLM 足够的上下文
 *    （**其实就是最后一件事结算完后，假设还要生成新一天事件时的上下文**）」
 *    ⇒ **不重写一套**：user ③ = `renderComposeUser(l)`（**逐字**同一段）
 *    ＋ 追加【你的欲望】＋【四行卡槽（含凭证描述）】。
 *    理由与 `renderCreateUser` 同族：同一份上下文给两个任务用，**比写两份更不会漂**。
 *
 * ⚠️ 追加的两块都是**评价的核心标准**（用户原话），不是"补充材料"：
 *    · 【你的欲望】—— 宣言 / 手段 / 目的**全文**（`endingDesireBlock` 已在 system 末段给过
 *      命题那三行；这里给的是**面板上那四行**，含"如一的初衷"那格 ⇒ **两处内容不同，不算重复**）；
 *    · 【四行卡槽】—— **带每条凭证的 `desc`**（`placementsBlock` 已改造）。
 * ⚠️【他这一局的样子】（`portraitBlock`）**保留**：它是结局独有的（生成侧没有），
 *    且"他这一局的样子"正是判词的收束依据。
 * ⚠️ 末行的存在理由与另外四条侧链一致：对端不吃空 `content`，且这是"这一次要做的事"的指路。
 */
export function renderEndingUser(l: Ledger): string {
  return [
    renderComposeUser(l),
    endingDesirePanelBlock(l),
    placementsBlock(l),
    portraitBlock(l),
    '按【结局】指令输出这一局的结局判词（**不要写标题**，标题由系统给定）。',
  ].join('\n\n');
}

/**
 * 【你的欲望】—— 结局 user ③ 的追加块：**面板上那四行**的全文。
 *
 * ⚠️ 与 system 末段的 `endingDesireBlock`（【玩家的欲望命题】）**内容不同、不算重复**：
 *    · 那一条给的是**判据用的三行**（宣言 / 手段 / 目的）；
 *    · 这一条给的是**玩家在「你的欲望」面板上看到的四行**（多了"如一的初衷"那格的欲念值）。
 * ⚠️ 欲念值是**数字** —— 它在 system ② 与主链里都被判为"不写数值"，但**这里必须给**：
 *    用户把它列为结局评价的核心标准之一（"这一局离他想要的到底有多近"）。
 */
export function endingDesirePanelBlock(l: Ledger): string {
  return [
    '【你的欲望】',
    `宣言：${l.desire.manifesto || '（未定）'}`,
    `你的手段：${l.desire.means || '（未定）'}`,
    `你的目的：${l.desire.proposition || '（未定）'}`,
    `如一的初衷（欲念）：${l.desire.value}`,
  ].join('\n');
}

/**
 * 【已见过的事】—— `opening` 侧链 user ③ 的**第二块**：玩家已经点完的那 9 条序幕概要。
 * ⚠️ 直接复用 `summaries.recent`（`day = 0`）—— **不做"第几天"那一层**（序幕期它恒为 0，
 *    印出来全是「第 0 天」反而误导）。与主链【已处理概要】是**同一个数据源**、不同呈现。
 */
export function prologueSummaryBlock(l: Ledger): string {
  const body =
    l.summaries.recent.length > 0
      ? l.summaries.recent.map((r) => `· ${r.text}`).join('\n')
      : '· （暂无）';
  return ['【已见过的事】', body].join('\n');
}

/** 安全断言：任何块都不该把「预计算结果」写出去（`pending` 必须永不入 prompt） */
export function assertNoSpoiler(userText: string, l: Ledger): void {
  for (const p of l.pending) {
    if (p.narration && p.narration.length > 8 && userText.includes(p.narration)) {
      throw new Error(`⚠️ 防剧透底线被破：user 段里出现了 pending 的叙事（事件 ${p.eventId}）`);
    }
  }
}

/** 当前时间读数（供日志/调试） */
export function nowLabel(l: Ledger): string {
  const t = nowOf(l);
  return `第 ${t.day} 天第 ${t.used} 点`;
}
