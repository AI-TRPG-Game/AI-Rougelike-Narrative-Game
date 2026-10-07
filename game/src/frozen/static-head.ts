// 静态头
//
// 前缀缓存被无意破坏是最贵的一类 bug：静态头差一个字符，`compose_day` 与 `resolve`
// 两段缓存同时作废。对策是**把静态头做成冻结常量 + 单测断言其 hash 不变**。
//
// ── 结构：两段，来源不同 ────────────────────────────────────────
//  ① **世界观 ＋ 基调** —— 《装配规范.md》§2.1 的**逐字常量**，永不改动 ⇒ 直接锁 hash。
//  ② **实体表**（人物身份骨架 / 地点 / 物品）—— **由账本渲染**。
//     依据 §1.3：「实体表只增不改、按 id 升序、新实体追加末尾——这是"静态头"能天天全命中的前提」。
//     ⇒ 它不是常量（新实体要能进来），但**前缀字节稳定**：只追加、不重排、不改写既有行。
//
// ⚠️ 因此：「逐字」这条纪律主要落在段 ① 与各行**模板**上，不落在"整段是常量"上。
//    `STATIC_HEAD_PROSE_HASH` 断言的就是段 ① —— 它一变，两段缓存全废。
//
// ⚠️ **2026-09-19 用户裁定：LLM 对新建实体只填「批次内临时编号」（`@p1` / `@it1` / `@loc1`），
//    正式 id 一律由系统分配并回写本批引用。** 因此段 ② **不再向 LLM 报正式 id 的水位**
//    （旧文案"此后新建人物从 npcXXX 起递增"方向相反，且与 `idWatermark` 实际值不符
//    —— 假开局只有 npc000~002，而水位是 npc010，系统实际会发 npc011）。
//    正式 id 仍按 `ledger/ids.ts` 顺位分配，但那是**系统内部的事**，不写进提示词。
//
// ⚠️ Phase 2 的账本仍是**最小假数据**（3 人 / 2 地点 / 1 物品）；真实开局数据
//    （10 人六维 / 9 地点 / 序幕文案）属 Phase 4。渲染逻辑现在就要写对，数据后补。
import type { Ledger } from '../ledger/types.ts';

/**
 * 段 ① —— 《装配规范.md》§2.1 逐字常量。**改一个字就废掉两个主链的缓存。**
 *
 * ⚠️ **2026-09-18 用户定稿（大幅精简）**：原文里的「西幻锚定段」（点名"西方奇幻 / 欧洲中世纪"＋
 *    中式负例「督察院 / 户曹 / 更鼓 / 衙门…」）**按用户裁定删除**。那段当时是为修一条
 *    `--live` 实测缺陷加的（LLM 产出中式官制词）。**风险自担、已知**：
 *    若 `--live` 再现中式词汇，**第一个要加回来的就是那段锚定＋负例**。
 *
 * ⚠️⚠️ **2026-10-07 用户裁定（难度回调）**：实测游戏难度偏高 —— LLM 太"端着"，不顺着玩家来。
 *    ⇒ 基调段加【迎合与荒诞】：允许适当迎合玩家的欲望与文本输入、允许适当的荒诞剧情；
 *      原基调句里的「即使是荒诞也有其原因」**一并摘除**（它逼着 LLM 给每处荒诞找理由，
 *      正是"不允许荒诞"的那道闸 —— 与本裁定直接冲突）。
 */
export const STATIC_HEAD_PROSE = [
  '你是一个肉鸽叙事类游戏的叙事处理器，需要辅助游戏系统和玩家完成游玩。',
  '【世界观】西幻王国：塞兰王国，都城金庭城，王宫坐落城中。魔法、神灵、非人等超自然元素存在但较为少见。',
  '',
  '男女之事在这个国家较为开放，而神殿主张禁欲礼神，但当任国王登位有神殿支持，所以国王本人和最受其公开认可的大王子生活上都非常克制守礼；但许多贵族并不赞同神殿的做法。',
  '',
  '【基调】',
  '在这个真实的世界里，玩家可能做出喜剧化 / 荒诞的行为，人们会对玩家做出回应，但其行事与剧情发展应有逻辑。',
  '【迎合与荒诞】可以适当迎合玩家的欲望和他的文本输入来进行叙事：他想推进的事可以让他推进，他说的每句话都值得认真、有趣的回应；也允许适当的荒诞剧情 —— 荒诞不必处处解释，只要不崩坏世界观。',
].join('\n');

/**
 * 段 ② 的**骨架文本**（行模板与固定说明都是常量，只有实体行是渲染出来的）。
 *
 * ⚠️ **段 ② 的每一句话都是写给 LLM 的**（2026-09-19 用户裁定）：不许出现
 *    「user 段 / system / 规则层 / 字段 / 注入」这类**我们自己的架构词**，也不许出现
 *    只给开发者看的备注。模型不知道我们在说哪一层，只会照字面把那些词当成世界的一部分。
 *    ⇒ 写「它会看到什么 / 它该怎么做」，不写「我们是怎么实现的」。
 */
const PERSON_SECTION_TITLE = '【人物】（此处只列身份骨架；六维与状态随每日上下文另给）';
const PERSON_FIELD_ORDER = '字段顺序：id ｜ 姓名 · 种族 · 基础信息 · 身份';

const ENTITY_SECTION_TITLE =
  '【实体表】（按 id 升序；新实体只追加在末尾。此处只列固定信息——状态、认可与携带的变化随每日上下文另给）';

/** 2026-09-19 用户裁定：删去「新地点限金庭城内与城郊；」半句（用户手改《PROMPT清单》原文） */
const PLACE_TAIL = '（已在上面列出的，固定用同一个名字）';

const ITEM_TAIL_NOTE =
  '（括号里是**物品大类**：装备 / 消耗品 / 特殊物品。物品随玩家的获得与消耗增删；' +
  '**新物品填批次内临时编号**（`@it1` 起），正式 id 由系统分配。' +
  // ⚠️ 2026-10-06（用户裁定）：**允许产出"只有特殊效果"的消耗品**，且那种**不占携带生效名额**。
  //    字段说明一字未动（`attr_bonus` 本来就是可空数组，LLM 已经能产出），
  //    这里只把"两种消耗品"的差别讲清，否则它会以为每个消耗品都必须给点数。
  ' **消耗品有两种**：给人物加数的（写 `attr_bonus`），与只在情节里管一次性的' +
  '（护符、解药、钥匙、一次性卷轴 —— **`attr_bonus` 留空**，它照样用得掉））';

/**
 * 实体表的 id 纪律 —— **2026-09-19 用户裁定**：LLM 只填临时编号，系统映射为正式 id。
 * 旧文案"此后新建人物从 npcXXX 起递增"方向相反（等于叫 LLM 自己算正式 id），已删。
 */
const ID_DISCIPLINE_NOTE =
  '说明：**新建人物 / 物品 / 地点一律填批次内临时编号**（`@p1` / `@it1` / `@loc1`，本批唯一）；系统落地时分配正式 id，并把本批所有对该编号的引用一并改写。**既有条目请直接引用上面列出的正式 id**，不要自己推算或顺延编号。';

/**
 * 渲染段 ②：实体表（身份骨架）。
 * ⚠️ 三条纪律，破了静态头就失效：
 *   ① **按 id 升序**；② **只追加、不重排**；③ **既有行永远改写同一个样子**（模板固定）。
 */
export function renderEntitySkeleton(ledger: Ledger): string {
  const { people, places, items } = ledger.entities;

  const personRows = [...people]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id} ｜ ${p.name} · ${p.race} · ${p.basic} · ${p.identity}`);

  const placeRows = [...places]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id} ${p.name} —— ${p.desc}`);

  const itemRows = [...items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((i) => `${i.id} ${i.name}（${i.kind}）—— ${i.desc}`);

  const personRange =
    people.length === 0
      ? '（暂无）'
      : `${people.map((p) => p.id).sort((a, b) => a.localeCompare(b))[0]} ~ ${
          [...people].sort((a, b) => a.id.localeCompare(b.id))[people.length - 1].id
        }`;

  return [
    PERSON_SECTION_TITLE,
    PERSON_FIELD_ORDER,
    '',
    ...(personRows.length > 0 ? personRows : ['（暂无）']),
    '',
    ID_DISCIPLINE_NOTE,
    '',
    ENTITY_SECTION_TITLE,
    '',
    '· 地点',
    ...(placeRows.length > 0 ? placeRows : ['（暂无）']),
    PLACE_TAIL,
    '',
    '· 人物',
    `${personRange} —— 见上方人物表（此处不重复，避免同一信息两处漂移）`,
    '',
    '· 物品',
    ...(itemRows.length > 0 ? itemRows : ['（暂无）']),
    ITEM_TAIL_NOTE,
  ].join('\n');
}

/** 完整的静态头 = 段 ① ＋ 段 ②（空行分隔，逐字与《装配规范.md》§二 的三段切分一致） */
export function renderStaticHead(ledger: Ledger): string {
  return STATIC_HEAD_PROSE + '\n\n' + renderEntitySkeleton(ledger);
}

/** FNV-1a 32 位 —— 够用来做"变没变"的断言，不必引入依赖 */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 段 ① 的 hash —— **锁死**。它变了 ⇒ `compose_day` 与 `resolve` 的缓存同时作废。
 * 单测断言这个值（见 test/prompt.test.ts）。**要改就必须是有意为之，并同步更新这里的值。**
 */
export const STATIC_HEAD_PROSE_HASH = hash(STATIC_HEAD_PROSE);
