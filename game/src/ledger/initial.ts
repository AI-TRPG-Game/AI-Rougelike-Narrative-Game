// 开局账本 —— **P4-B 全局数据**
//
// 这就是「**进入游戏那一刻**」的账本：序幕 day 0。序幕**逐条弹窗、0 行动点、0 调用、
// `delta` 一律留空**⇒ 序幕期间**什么都不落账**，
// 于是本节所有数值都必须是**开局就写好的**，不能指望序幕事件去发。
//
// 三条纪律：
//
//  ① **逐字照录**：《设定.md·预置人物阵容》/《预置地点》两张表是**唯一事实源**——
//     人名 / `basic` / `in_your_eyes` / `openness` / 六维 / 地点描述 一律照抄，
//     不"顺手润色"、不补设定、不删括号里的备注。要改先改设计文档，再回来改这里。
//  ② **id 顺位**：玩家恒 `npc000`；预置 10 人按表**自上而下** `npc001`~`npc010`；
//     地点 `loc001`~`loc009`；物品 `it001`（短匕首）/ `it002`（旧游记）。
//     这组数字与 `ledger/ids.ts·initialWatermark()` **必须一致**，否则第一条新生成的人物
//     会撞上预置 id（`IdAllocator` 从水位 +1 开始发号）。由测试钉住。
//  ③ **enum 一致**：`race` / `identity` 的取值只在 schema 里当**提示词**，服务端**不校验** ⇒
//     这条链上**没有任何东西会拦下非法取值**，只能靠这里写对。2026-09-19 的教训：
//     原稿写 `race:'塞兰人'` ＋ `identity:'王族'/'武人'/'幕僚'`，**四个值全在 enum 之外**，
//     而所有测试照样全绿。取值口径照《设定.md》：王室与受封骑士 = `贵族`，神职 = `其他`，
//     预置阵容**一律人类**（非人种族不入阵容，只作世界的边缘背景）。
import type { Attrs, Rep5 } from '../contract/types.ts';
import { formatId } from '../contract/tempids.ts';
import { emptyRepMarks } from '../rules/checkpoint.ts';
import { BASE_ACTION_POINTS } from '../rules/x.ts';
import { initialWatermark } from './ids.ts';
import { PLAYER_ID, type Ledger, type Person } from './types.ts';

export const EMPTY_REP: Rep5 = { 善名: 0, 恶名: 0, 侠名: 0, 怪名: 0, 权势: 0 };

/** 六维列序 = 《设定.md·六维》表的列序（照抄成元组，便于**逐格核对**） */
export type AttrTuple = [
  争斗: number,
  敏捷: number,
  智慧: number,
  魅力: number,
  社交: number,
  感知: number,
];

export function attrsOf(t: AttrTuple): Attrs {
  return { 争斗: t[0], 敏捷: t[1], 智慧: t[2], 魅力: t[3], 社交: t[4], 感知: t[5] };
}

export function attrs(a: Partial<Attrs>): Attrs {
  return {
    争斗: a.争斗 ?? 8,
    敏捷: a.敏捷 ?? 8,
    智慧: a.智慧 ?? 8,
    魅力: a.魅力 ?? 8,
    社交: a.社交 ?? 8,
    感知: a.感知 ?? 5,
  };
}

/**
 * **玩家的人物描述** —— 硬编码，**唯一一处**（2026-10-06 用户裁定）。
 *
 * ⚠️ **它去过 `desire.past`（由模型在序幕生成）**：用户裁定「既然现在开局不需要通过 LLM
 *    生成玩家欲望和玩家属性，那么玩家的人物简述也不需要生成了」⇒ 那次调用整个删除。
 * ⚠️ **它现在是 `Person.desc`**，与**其余所有人物**同一字段 ⇒ UI 上**同一位置**显示，
 *    且它**照旧进 prompt**（`frozen/static-head.ts:90` 早就把 `desc` 拼进静态头）。
 *
 * ⚠️ **为什么放在这里而不是 `turn/opening.ts`**：它是**开局的常量数据**，不是"落地动作"；
 *    `turn/` 那一层只负责"把玩家的选择落进账本"。⚠️ 同一句话**不许在两处各写一份**。
 */
export const PLAYER_DESC =
  '你自己，塞兰王国的三王子。你的过往并不重要，因为你在乎的是你的现在的欲望和你的将来。';

export function makePerson(p: Partial<Person> & { id: string; name: string }): Person {
  return {
    id: p.id,
    etype: 'person',
    name: p.name,
    // ⚠️ 默认值也必须是 enum 成员（`人类`），不要写成"塞兰人"这类归属词
    race: p.race ?? '人类',
    basic: p.basic ?? '',
    identity: p.identity ?? '',
    desc: p.desc ?? '',
    affiliated: p.affiliated ?? true,
    attrs: p.attrs ?? attrs({}),
    attr_bonus: p.attr_bonus ?? [],
    hp: p.hp ?? 3,
    san: p.san ?? 3,
    in_your_eyes: p.in_your_eyes ?? '',
    openness: p.openness ?? 10,
    items: p.items ?? [],
    recognized: p.recognized ?? [],
  };
}

/**
 * 预置阵容。
 *
 * ⚠️「地界」**不是人物卡字段**（它只是序幕与生成侧的舞台提示）⇒ 这张表里**刻意没有它**：
 *    录进来就会有人把它当字段用。（地界：王庭 / 寝殿…见《设定.md》表内那一列。）
 * ⚠️ `hp` / `san` 设计文档**未给逐人取值** ⇒ 一律走 `makePerson` 默认 3/3（上限值）。
 *
 * ⚠️⚠️ `affiliated`（**是否算你的人**）**不在《设定.md》那张表里** —— 它是 2026-09-22
 *     用户裁定补上的一列，原话：「难道国王等也是下属吗？」「**当然只有皮普可以派遣**」。
 *     为什么必须显式写：`makePerson` 的默认值是 `?? true`，而这张表原先谁都没写过这一列
 *     ⇒ 预置 10 人**全部**落进「在册」；而 `ledger/types.ts·isAvailable` 的第一行正是
 *     `if (!p.affiliated) return false` ⇒ **国王真的可以被派去办事**（不只是界面难看）。
 *     口径：**入队 = 真的听你使唤的人**。按开局人设只有皮普（伴当骑士，自幼跟着你长大）；
 *     其余 9 位是父王 / 兄长 / 生母 / 朝臣 / 主教 —— 他们要**开口求、拿身份换**，不是下属。
 *     ⇒ 以后要让谁入队，改的是**这一列**（或走一条新的入队通道），不是去动渲染。
 */
const PRESET_PEOPLE: ReadonlyArray<{
  name: string;
  basic: string;
  identity: string;
  /**
   * **形象描述**（50~100 字 · 2026-10-06 用户裁定）——「该人物形象、性格、来历的简要描述」。
   *
   * ⚠️ 它**三处都去**（同一个字段、同一条内容，不许分叉）：
   *   ① `frozen/static-head.ts:90` 把它拼进静态头段 ② ⇒ **真的进 prompt**；
   *   ② `ui/index.html·sheetPerson` 显示它（「他是个什么样的人」那一段）；
   *   ③ LLM 写事件时**看得见这个人是谁**（原来这里是空的 ⇒ 十个人在模型眼里只有名字与身份）。
   *
   * ⚠️ **写给世界，不是写给开发者**（同 `PRESET_PLACES·desc` 那条纪律，2026-09-19 裁定）：
   *   里面**不许**出现机制词与开发术语。✗ "（禁卫统领，可派遣）" ✗ "（openness 12）"
   * ⚠️ **与 `in_your_eyes` 分工**：那一列是「**你**怎么看他」（主观、带刺），
   *   这一列是「**他**是谁」（客观、可给别人看）⇒ 两句不许互相抄。
   */
  desc: string;
  in_your_eyes: string;
  openness: number;
  attrs: AttrTuple;
  /** 是否算你的人（＝可派遣）。开局**只有皮普**为真 —— 见本表上方那段注释 */
  affiliated: boolean;
}> = [
  {
    name: '奥德里克三世',
    basic: '国王，三王子之父',
    identity: '贵族',
    desc:
      '塞兰王国的国王，三位王子之父。少年时南征过两回，此后便很少亲自动手，' +
      '政事多在殿上听完再批。他待人温和有礼，说话总留着三分余地，' +
      '也正因如此，三个儿子各自揣度了多年，谁也没真正摸清过他。',
    in_your_eyes: '一个总在别处的父亲',
    openness: 12,
    attrs: [12, 6, 13, 14, 15, 7],
    affiliated: false,
  },
  {
    name: '瓦伦丁·索雷',
    basic: '丞相（朝中权臣）',
    identity: '贵族',
    desc:
      '官拜丞相，在朝中经营了二十余年。记性极好，各家欠过谁的人情、谁在什么地方站队，' +
      '他都记得一清二楚。惯常面带浅笑，答话之前先停半拍，像是先把秤掂量过一遍。' +
      '金庭城里的事，很多要绕过王座才能办成。',
    in_your_eyes: '你每次都读不出表情的那位',
    openness: 5,
    attrs: [6, 8, 17, 12, 16, 4],
    affiliated: false,
  },
  {
    name: '加雷恩',
    basic: '王储（大王子），三王子长兄',
    identity: '贵族',
    desc:
      '王储，三位王子里的长兄。自幼被当作继承人教养，言行都照着王座该有的样子长，' +
      '挑不出什么错。唯独没人知道他在书房里独自读到深夜的那些书是什么。' +
      '他待弟弟们客气，客气得像在处理一桩公事。',
    in_your_eyes: '挑不出错、也靠不近的长兄',
    openness: 10,
    attrs: [13, 12, 14, 15, 13, 5],
    affiliated: false,
  },
  {
    name: '卢卡',
    basic: '二王子，三王子次兄',
    identity: '贵族',
    desc:
      '二王子，排行在中间。少年时因为夹在长兄与幼弟之间，很早就学会了察言观色，' +
      '也学会了一件事：谁近来得势，就先对谁热络。近来他忽然对你热络起来，' +
      '热心得让你不太习惯。',
    in_your_eyes: '忽然对你热络起来的二哥',
    openness: 11,
    attrs: [11, 13, 13, 12, 11, 5],
    affiliated: false,
  },
  {
    name: '赫尔曼',
    basic: '禁卫统领',
    identity: '贵族',
    desc:
      '禁卫军统领，嗓门大，酒量更好。年轻在边军待过几年，遇事喜欢用最直接的办法解决，' +
      '先动手再说。见了年轻人总要拍肩膀，拍完才想起问是谁。' +
      '殿前宿卫的那些年，他几乎没离开过。',
    in_your_eyes: '嗓门大、酒量好，见面先拍你肩膀的那位',
    openness: 12,
    attrs: [18, 14, 8, 12, 13, 6],
    affiliated: false,
  },
  {
    name: '伊莎尔',
    basic: '王后（正宫）',
    identity: '贵族',
    desc:
      '王后，正宫出身。年轻时就善于料理宫廷里那些不能摆到台面上的事，' +
      '待每一位王子都客气得恰到好处：不会太冷，也不会让人以为亲近。' +
      '她极少在公开场合表态，正因如此，她偶尔的一句话才格外有分量。',
    in_your_eyes: '待你客气得恰到好处的国母',
    openness: 9,
    attrs: [5, 9, 16, 13, 15, 6],
    affiliated: false,
  },
  {
    name: '薇奥拉',
    basic: '二王妃，二王子的生母',
    identity: '贵族',
    desc:
      '二王妃，卢卡的生母。出身不算显赫，却是这宫廷里最先学会看人脸色的一位。' +
      '笑起来总是先看着对方的脸，确认气氛对了才开口说话。' +
      '她对自己的儿子极为了解，也因此总是最先察觉他脸上的倦意。',
    in_your_eyes: '笑起来先看人、后开口的那位',
    openness: 10,
    attrs: [4, 9, 12, 16, 14, 8],
    affiliated: false,
  },
  {
    name: '米蕾娅',
    basic: '三王妃，三王子的生母',
    identity: '贵族',
    desc:
      '三王妃，三王子的生母。身子一向不算强，这些年大半时间都在寝殿里，' +
      '见客的时候居多。见了你来总是先笑起来，笑得比殿上那些事都真。' +
      '她很少问你外面的情形，只问你吃了没有、冷不冷。',
    in_your_eyes: '唯一一个见你就先笑的人',
    openness: 18,
    attrs: [4, 10, 11, 15, 12, 9],
    affiliated: false,
  },
  {
    name: '克莱芒四世',
    basic: '大主教',
    identity: '其他',
    desc:
      '大主教，在这间神殿里已经坐了二十多年。城里的人说，他年轻时能听见神的声音；' +
      '他本人从不否认，只是也从不细说。眼睛比常人敏锐，看人时尤其如此——' +
      '他看你的时候，眼睛明显比看别人更亮。',
    in_your_eyes: '看你时眼睛比看旁人亮的老人',
    openness: 12,
    attrs: [5, 7, 14, 15, 16, 16],
    affiliated: false,
  },
  {
    name: '皮普',
    basic: '伴当骑士，自幼跟着三王子一同长大（平民出身 · 因护主受封）',
    identity: '贵族',
    desc:
      '伴当骑士，平民出身，自幼跟着三王子一同长大。两人一起偷过东西、一起挨过罚，' +
      '后来他因护主受封，身份才算落定。话不多，挡在前面的时候却从不需要人吩咐。' +
      '他从不追问三王子要去哪里，只问要不要他跟着。',
    in_your_eyes: '一起挨过罚、如今替你挨刀的人',
    openness: 17,
    attrs: [13, 13, 9, 11, 8, 6],
    affiliated: true, // ★ 开局**唯一**算你的人
  },
];

/**
 * 预置地点。
 *
 * ⚠️ **`desc` 是写给 LLM 的世界知识，不是写给开发者的备注**（2026-09-19 用户裁定）。
 *    它由 `frozen/static-head.ts·renderEntitySkeleton` 直接拼进静态头段 ②，
 *    也就是**真的会进提示词** ⇒ 里面不许出现机制词与开发术语：
 *      ✗ "（同时是恢复 SAN 的功能入口）"　✗ "（国王 · 丞相只在开局朝会露面）"
 *      ✗ "序幕的收尾与「原初欲望的觉醒」都在这儿"　✗ "（××的地界）"
 *    那些是说给我们自己听的；模型读到只会把系统词当世界的一部分写进故事。
 *    ⇒ 文案一律取《设定.md》**本身已有的世界材料**（主要是序幕事件文案里的场面），
 *      只写"这地方是什么样子"，不写"它在系统里做什么"。
 *    ⚠️ 这条适用于**所有**叫 `desc` 的字段（`Place` / `Item` / `Person`）。
 *
 * ⚠️ **医馆**与**大神殿的功能入口部分**不占这九个 id（纯功能入口，不进事件池）。
 *
 * 各处的「地界」（谁常驻在哪）是**开发用的排布信息，不是世界知识** ⇒ 不写进 `desc`，
 * 记在这里备查（源：《设定.md·预置人物阵容》表内那一列）：
 *   loc001 塞兰王庭 = 国王 · 丞相（仅开局朝会）　　loc003 大神殿 = 大主教
 *   loc004 贵族宅邸 = 两位王妃　　　　　　　　　　loc005 莎莉歌剧院 = 王后
 *   loc006 金庭市集 = 皮普　　　　　　　　　　　　loc007 花街 = 二王子
 *   loc008 博德酒馆 = 赫尔曼　　　　　　　　　　　loc009 王家猎场 = 王储
 *   loc002 三王子寝殿 = 玩家本人（序幕收尾与「原初欲望的觉醒」在此发生）
 */
const PRESET_PLACES: ReadonlyArray<{ name: string; desc: string }> = [
  { name: '塞兰王庭', desc: '王宫正殿一带：听政、议事、大典都在这里。晨钟响过三遍，殿上就站满了人。' },
  { name: '三王子寝殿', desc: '三王子在金庭城的住处。夜里很静，内侍照例在殿里候着。' },
  { name: '大神殿', desc: '金庭城的主神殿，神殿势力的中心。王室子弟每月要来这里上炷香。' },
  { name: '贵族宅邸', desc: '上城贵族的宅子与沙龙，惯例的茶话会在此。悠闲的贵族男女在这里消磨下午。' },
  { name: '莎莉歌剧院', desc: '金庭城最大的歌剧院，王室包厢正对舞台。' },
  { name: '金庭市集', desc: '中城的大市集，什么都卖：卖布的、卖腌鱼的、卖不知道从哪儿收来的旧书的。' },
  { name: '花街', desc: '下城的烟花巷：妓馆 · 酒局 · 乐坊。傍晚才醒，灯一盏盏点起来。' },
  { name: '博德酒馆', desc: '下城最大的酒馆，堂子里烟气腾腾，长桌挤得满满当当。' },
  { name: '王家猎场', desc: '城郊山脚的猎场，围栏一眼望不到头。' },
];

export function emptyLedger(): Ledger {
  return {
    clock: { day: 0, phase: '序幕', chapter: 1, usedToday: 0 },
    entities: { places: [], people: [], items: [] },
    scalars: { gold: 0, rep: { ...EMPTY_REP } },
    events: { live: [], hidden: [] },
    pending: [],
    summaries: { archive: [], recent: [] },
    seeds: [],
    divination: null,
    vouchers: [],
    /** ⚠️ 终局未到 ⇒ `null`。走 `initialLedger()` 拿到的才是**开局**（那里欲念 = 30） */
    ending: null,
    /** 硬种子 checkpoint：开局一格都没出过（`权势` 开局 5，还没到 10） */
    repMarks: emptyRepMarks(),
    // ⚠️ **每一个键都要显式写出来**（本仓是 strip-only）—— 漏一个键**不会有任何东西报错**，
    //    而消费方读到的就是 `undefined`。`advantages` 是 2026-10-05 加的（玩家点亮的优势属性），
    //    它一度只写在下面那两处赋值里、**漏在这个模板里** —— 于是"开局前的账本"
    //    比"开局后的账本"少一个键（`probe/verify-4.mjs` 的字段清单断言当场逮住了它）。
    desire: { value: 0, proposition: '', means: '', manifesto: '', kit: 0, advantages: [] },
    scene: null,
    roll: null,
    gates: [],
    actionPoints: { byNpc: {} },
    idWatermark: initialWatermark(),
  };
}

/**
 * 开局账本：**玩家 ＋ 预置 10 人 ＋ 9 处地点 ＋ 2 件初始物品**。
 *
 * 数值口径逐条对上《设定.md·序幕占位数值》：
 *   六维全 5 · 金币 5 · 权势 5（其余声望 0）· HP / SAN 3/3 · 欲念 30。
 * 其中**金币写 0** 是**有意**的：那句「金币 5」在文档里自带注解——「即**进入第 1 天时
 * 发的那次周例钱**……不是额外的一笔」⇒ 它由 `turnOver` 在第 1 天发放
 * （`rules/clock.ts·payrollForDay(1) === 5`），开局本身不预置，否则第 1 天会变成 10。
 * 其余各项没有这样的发放机制（序幕 `delta` 一律留空），所以必须在这里写死。
 */
export function initialLedger(): Ledger {
  const l = emptyLedger();
  l.clock = { day: 0, phase: '序幕', chapter: 1, usedToday: 0 };

  const dagger = formatId('it', 1);
  const travelogue = formatId('it', 2);

  // ── 玩家 `npc000`（固定身份：塞兰王国三王子 · 默认名 艾德里安，开局可改）──
  l.entities.people = [
    makePerson({
      id: PLAYER_ID,
      name: '艾德里安',
      basic: '塞兰王第三子',
      identity: '贵族',
      // ⚠️⚠️ **2026-10-06 用户裁定**：玩家的人物描述**不再由模型生成** —— 那句固定文本
      //    就是 `Person.desc`，与**其余所有人物**同一字段、同一显示位置。
      //    原话：「你自己，塞兰王国的三王子。你的过往并不重要，
      //    因为你在乎的是你的现在的欲望和你的将来」。
      //    ⇒ 序幕**零 LLM 调用**（`desire.past` 字段与 `applyOpening` 一起删除）。
      desc: PLAYER_DESC,
      // 两个关系字段在玩家身上填哨兵」）
      in_your_eyes: '',
      openness: 0,
      // ⚠️ **序幕占位：六维全 5**。真实数值由 `turn/opening.ts·applyPlayerChoice`
      //    按玩家点亮的优势属性算（2026-10-05 起玩家自己挑，不再抽塔罗）。
      //    ⇒ 无头驱动与 UI 都由 `turn/prologue.ts·driveOpening` **真的落一次账**。
      attrs: attrsOf([5, 5, 5, 5, 5, 5]),
      // 「两样东西」由规则层直发（物品得失是重型变化，不进档 A 的 `Delta`）。
      // ⚠️⚠️ 2026-10-08（用户裁定·**无人携带**）：开局物品**不装备给任何人** ——
      //    包括玩家自己这张卡（艾德里安）。它们躺在手牌区（`holder=null`），
      //    玩家想给谁带，从手牌区拖到谁身上；此前默认挂在玩家名下，
      //    玩家把它们从自己卡上拖回手牌区会被"已经在你手上了"顶回来（实测翻车）。
      items: [],
    }),
    ...PRESET_PEOPLE.map((p, i) =>
      makePerson({
        id: formatId('npc', i + 1),
        name: p.name,
        basic: p.basic,
        identity: p.identity,
        // ⚠️ 2026-10-06 用户裁定：形象描述（50~100 字）—— 与玩家那句同一个字段
        desc: p.desc,
        in_your_eyes: p.in_your_eyes,
        openness: p.openness,
        attrs: attrsOf(p.attrs),
        // ⚠️ 必须显式透传：`makePerson` 的默认值是 `?? true`，漏了这一行就前功尽弃
        affiliated: p.affiliated,
      }),
    ),
  ];

  l.entities.places = PRESET_PLACES.map((p, i) => ({
    id: formatId('loc', i + 1),
    etype: 'place' as const,
    name: p.name,
    desc: p.desc,
  }));

  // ── 2 件初始物品──
  //    两件都刻意"日常"——不夹带任务、也不夹带秘密。
  l.entities.items = [
    {
      id: dagger,
      etype: 'item',
      kind: '装备',
      name: '短匕首',
      desc: '一柄柄上缠了旧布的短匕首，王室子弟的日常佩物',
      // 「有数值 · 争斗 +1」⇒ 档值 1 ⇒ 品级派生为「粗制」（品级不进 schema）
      attr_bonus: [{ attr: '争斗', bonus: 1 }],
      // ⚠️ 2026-10-08（用户裁定·无人携带）：默认不装备给任何人（含玩家自己那张卡）
      holder: null,
      consumed: false,
    },
    {
      id: travelogue,
      etype: 'item',
      // 「无数值 · 剧情钩子」⇒ `attr_bonus` 空数组 ⇒ 品级 = 其他
      kind: '特殊物品',
      name: '旧游记',
      desc: '一本边角翻得起毛的旧游记，讲海外诸邦风物',
      attr_bonus: [],
      holder: null,   // ⚠️ 2026-10-08（用户裁定·无人携带）：同上
      consumed: false,
    },
  ];

  // 权势 5（其余声望 0）—— 序幕占位；权势是唯一参与判定的声望（作门槛 / 捷径）
  l.scalars = { gold: 0, rep: { ...EMPTY_REP, 权势: 5 } };

  // 下属容量：预置 10 人各自满额（**玩家不在 `byNpc` 里** —— 他的预算是 `clock.usedToday`）
  l.actionPoints.byNpc = Object.fromEntries(
    l.entities.people.filter((p) => p.id !== PLAYER_ID).map((p) => [p.id, BASE_ACTION_POINTS]),
  );

  // ⚠️ **欲念 30**。
  //    这里曾写成 **0**（2026-09-19 修正），后果不是"不好看"而是**判定错**：
  //    档 A 点一个「偏离」（−3）就当场归零 ⇒ 按《设定.md·结局总表》第 3 行，
  //    那一局应当在**第 1 天**就判「失败 · 迷失」并立即终结，而模拟器当时会继续跑满 28 天
  //    （因为逐次终结检查那时还没实现）—— 所有 28 天级标定都建立在这个错基线上。
  //    ⚠️ 目的 / 手段 / 宣言 / 人物描述 / 六维**都是开局的产物**（`applyPlayerChoice` 一次落）
  //       ⇒ 开局一律留空，由 `turn/simulate.ts·driveOpening` 在"序幕末条"那一刻补上
  //       （UI 与无头驱动同一个入口）。
  //    ⚠️ `kit: 0` 是**占位**：玩家还没挑。`turn/opening.ts` 读到 `manifesto === ''`
  //       就知道"这是没开局过的账本"，而 UI 侧靠它判"要不要先让玩家挑一条"。
  l.desire = { value: 30, proposition: '', means: '', manifesto: '', kit: 0, advantages: [] };
  return l;
}
