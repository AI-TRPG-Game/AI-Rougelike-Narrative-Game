/* ═══════════════════════════════════════════════════════════════════
   【目录】—— 主脚本约 5270 行 / 127 个顶层函数。**按下面的分区跳，不要通读。**
   ⚠️ 数据流只有**一条**：S（后端信封）→ 各 render*() 拼 HTML 字符串 → 塞进
      #topbar / #colMid / #hand / #footer / #overlay 。没有框架、没有虚拟 DOM。
   ⚠️ 每次动作 = post('/api/xxx') → 用返回的信封**整份替换** S → render() 。
      页面上的临时选择（picks / handled / detailOpen / vPicks）**不属于** S，
      由 resetLocalViewState() 在换局 / 回标题屏时统一清掉。
   ⚠️ 拼 HTML 一律 esc() 转义 ＋ **单引号字符串**；return 后**绝不换行**
      （ASI 会把 return ＋ 换行 ＋ 字符串 变成 return; ⇒ 整块消失，而 node --check 仍 exit 0）。

       1.  状态                 —— S / picks / handled / detailOpen / vPicks …
       2.  工具                 —— $ / esc / post / fmt / attrSigil …
       3.  拖拽                 —— dragSrc / 落点判定 / give
       4.  忙碌态               —— setBusy（串行闸前端那一半）
       5.  渲染总入口           —— render() ＋ renderTop / renderMid / renderHand / renderFooter
       6.  地图                 —— canvasHtml / canvasSlots / 事件块 / 队列徽标
       7.  手牌区               —— handHtml / personCard / handItemCard / 折叠
       8.  事件处理台           —— cardHtml / 菱形卡槽 / 两个处理方式按钮
       9.  详情浮层             —— renderOverlay / sheetPerson / sheetQuest / sheetItem / sheetVoucher
      10.  变化演出             —— spawnFly / 数字滚动 / 卡牌进出
      11.  交互                 —— document 上的**一个**点击委托 ＋ 键盘
      12.  开局 / 标题屏 / 启动 —— pickDesire / 标题屏四槽 / boot()

   ⚠️ 找东西：grep -n "关键字" ui/index.html 。顶层函数**没有重名**（有守卫钉着）。
   ═══════════════════════════════════════════════════════════════════ */
// ── 状态 ────────────────────────────────────────────────────────
let S = null;                      // 后端信封：{view, feed, log}
let picks = {};                    // 每条事件的提交选择：{participants:Set, gold, usedItemId, note}
let popupResults = [];             // 待给玩家看的**结算正文**（正文事件的了结 / 场景收束 / 终局话术 …）
/**
 * 骰子动画弹窗的**当前态**（2026-10-07）—— `entry` 认"现在押的是哪条结果"（对象身份），
 * `rolled` 记"玩家点没点过骰区"，`done` 记"看没看完（看完才放行到普通结果卡）"。
 * ⚠️ 它是**纯页面态**：`resetLocalViewState()` 里与 `popupResults` 一起清。
 */
let diceState = { entry: null, rolled: false, done: false };
/**
 * **刚处理完、还没点「确认」的那一条**（`null` = 没有）—— 2026-09-23 用户裁定的「一次一条」。
 *
 * 形状：`{ id, title, stage, content, options:[文案…], chosen: 索引, result: 结算正文 }`
 * ⚠️ 为什么要**在点选之前**抓一份快照、而不是点完再回头去 `S.view.popups` 里找：
 *    那一条**当场就被结算掉了**（`choosePopup` 落账 ⇒ 它不再是「待处理」）⇒
 *    正文 / 舞台 / 选项列表**全都不在了**。玩家要的那一步
 *    「**保留事件页面 ＋ 玩家处理方式**」只能靠这一份。
 * ⚠️ 它是**页面上的临时状态** ⇒ `resetLocalViewState()` 里必须一起清掉。
 */
let handled = null;
/**
 * 结算弹窗的游标：`S.feed` 里**已经给玩家看过**的条数。
 * ⚠️ 为什么要游标而不是「每次把结果全弹一遍」：`feed` 是**一局从开头累积**的
 *    （读档回来会带着几十条）⇒ 不设游标的话，一读档就把整局结果重播一遍。
 * ⚠️ `feedCursorReady` 区分「刚拿到第一份信封」与「动作产生了新信封」这两种时刻。
 */
let feedShown = 0;
let feedCursorReady = false;
// ⚠️ 2026-10-07 用户报告的 bug：「每次进入一个存档，都会重新刷新出序幕假事件的结算结果」。
//    病根：页面首屏的 `/api/view`（feed 还是空的）就把 `feedCursorReady` 置真、游标推到 0；
//    随后「进入存档」的 `/api/save/load` 带着**整段历史 feed** 回来，走的是增量分支
//    `collectResults()` ⇒ 游标从 0 起步，几十条旧结算全被当成"这一次新产生的"重播。
//    （开新局没事：`save/new` 的 feed 是这一次刚生成的，本来就**该**弹。）
//    ⇒ 修法：读档这一次响应**只对齐游标、不重播**（历史里没有任何"新"结果可丢 ——
//      读档动作本身不产生结算）。下一次动作起恢复正常增量语义。
let feedCursorSkipOnce = false;
let banner = [];                   // {kind:'ok'|'err', text}
// ⚠️⚠️ 2026-10-06 清单第 4B 条：**原先那个 `slots = { 成果, 手段, 共鸣 }` 已删** ——
//   它是 P5-B 时代"三格就地选择"的页面态，而现在放格子的唯一入口是**「你的欲望」那一屏**
//   （四行卡槽 ＋ 凭证拖放 ＋ 只有最后一天能确定），状态住在 `vPicks`。
//   ⇒ 两个页面态并存会让"我放进去了，怎么刷新就没了"这种问题无从查起。
// 上帝视角（默认收起）—— 欲念数值 / 危险区 / 闸门 / 系统日志 / 种子 全在这里面
let god = false;
/**
 * **待确认**的一件事（`null` = 没有）—— 「保存并退出」「直接结算」「删档」共用这一个口径。
 * ⚠️ 它住在页面上，而不是每处各弹一个 `window.confirm`：这样确认框与档 A 弹窗同款，
 *    而且 `run` 里放的就是"确认之后那一次请求"，不必把三处逻辑各写一遍。
 */
let confirmAsk = null;
/**
 * 几段**列表**各自展开到什么程度（2026-09-22 起只剩「人手」这一处）。
 * ⚠️ 值是"在默认条数（`HIST_BASE`）之上**额外**再展开几条"（`0` = 只看默认）——
 *    **不是**"一共显示几条"：那样每处都得把默认值再抄一遍，改一处就漏一处。
 * ⚠️ 它只活在页面上（账本里没有）⇒ 回标题屏 / 读档时必须一起清掉（见 `resetLocalViewState`）。
 */
let histMore = { people: 0, peopleOut: 0 };
/**
 * 每段历史**默认**给几条。依据：一屏（约 1000px）里要保证"今天"先被看见，历史只作背景。
 * ⚠️ 这几个数字是**排布参数**，不是内容口径 —— 改它们不该动任何一句话。
 */
// ⚠️⚠️ 2026-06：**`??` 不是 `||`** —— 折叠取条数那两处原来写 `HIST_BASE[k] || 6`，
//   而 `peopleOut` 的默认值是 **0**；`0 || 6 === 6` ⇒ **默认值被自己的兜底吞掉**，
//   名单永远默认展开 6 个（实测就是这么坏的，而且**看不出是哪写错了**）。
//   ⇒ 改成 `??`（只有 `undefined` / `null` 才用默认）—— 0 是**有意义的设置**。
// ⚠️ 2026-06（用户裁定）：`peopleOut` **默认 0 条** —— 那是「尚未入队」那组。
//   它原来默认给 6 条 ⇒ 地图区左上角那块**一打开就是一列人名**，
//   比地图本身（2~4 块事件）还高 ⇒ 左上角那一坨把地图挤没了。
//   ⇒ 默认**只给标题 ＋ 一句提示**，点「展开」才列名单（`histMore` 那个动作仍在）。
//   ⚠️ `people` 那个键**已随「人手」卡撤掉**（卡带里人手横排不折叠），留着是为兼容旧档。
const HIST_BASE = { people: 6, peopleOut: 0 };
/** 点一次「展开」多给几条（一次全给是另一种难读：50 条糊一屏） */
const HIST_STEP = 20;
/**
 * 哪几条**待办**展开着（`true` = 展开）。
 * ⚠️ 只在"还没选过东西"时起决定作用 —— 选过东西的卡**强制展开**
 *    （折叠只许藏"还没开始做的事"，不许把玩家自己的选择藏起来）。
 * ⚠️ 页面上的临时状态 ⇒ `resetLocalViewState()` 里必须一起清。
 */
let openCards = {};
/** 「我想做点什么」那个面板开着没有（从页脚打开）—— 同样是页面上的临时状态 */
let composeOpen = false;
/**
 * 面板里那半句原话。
 * ⚠️ 必须有它：`api()` 每次回来都会 `render()` 重画，textarea 是**重新造**的 ——
 *    不把原话存下来，请求一失败，玩家刚写的那句话就在眼前消失了。
 */
let composeText = '';
/**
 * 点开的那张卡（详情浮层）：`null` | `{kind:'quest'}` | `{kind:'person', id}` | `{kind:'item', id}`。
 * ⚠️ 它只是个**阅览层**（不发请求、不碰账本）⇒ 点卡片外面也能收起。
 * ⚠️ 页面上的临时状态 ⇒ `resetLocalViewState()` 里必须一起清。
 */
let detailOpen = null;

/**
 * 「原初欲望觉醒」刚结束 ⇒ 「你的欲望」面板**自动跳出来一次**的待办（2026-10-08 用户第 3 条）。
 * 置位点：`pickCommit`（觉醒三步流程的**唯一收口** —— 自然走完与「直接正式开始游戏」
 *   两条路都在这汇合，天然保证**每局一次**）；消费点：`render()` 里（判据全过才弹，
 *   弹完即清）。
 * ⚠️ 读档不会置位 ⇒ 读回来的旧局不会莫名其妙弹这块 —— 它只在"本局刚觉醒"时出现。
 * ⚠️ `resetLocalViewState()` 里一并清（回标题屏 ⇒ 上一局的待办作废）。
 */
let desireIntroPending = false;
/**
 * 上面那件事的**配套引导 toast**待办 —— `render()` 末尾（面板 DOM 画完、
 * 量得到 `#modal` 真实左缘了）才放。"放在欲望弹窗左侧"（2026-10-08 用户第 3 条原话）。
 */
let desireIntroToastWanted = false;

/**
 * **难度选择弹窗开着没有**（2026-10-08 用户第 5 条）—— 觉醒刚完成、第 1 天还没铺开的那一步。
 * 置位点：`pickCommit`（点掉末条之后、**翻日之前**）；消费点：`pickDifficulty`（三档之一被
 * 点下 ⇒ 落账 `/api/difficulty`，再接上被拦下的那次翻日）。事实住在账本（`ledger.difficulty`，
 * 随存档走），它只是"这一步还没走完"的页面态 ⇒ `resetLocalViewState()` 里一并清。
 */
let difficultyOpen = false;
/**
 * 难度弹窗里**刚点下的那一档**（0 = 还没点）—— 2026-10-08 用户裁定（同批第 4 条）：
 * 「点完一个之后那个框变暗，且不能再点击其他选项」。点下 ⇒ 先置这个值并重画
 * （三颗全 disabled、点中的那颗变暗），请求回来成功才收弹窗；失败 ⇒ 归 0 解锁重选。
 * 与 `difficultyOpen` 同一条纪律：局内一次性页面态，`resetLocalViewState()` 里一并清。
 */
let difficultyPicked = 0;

/**
 * 「你的欲望」四行卡槽的**页面态**（还没点「确定」的那些）——
 * 2026-10-06 清单第 4B 条。⚠️ 与事件台那个 `picks` 是**两套**（不同键、不同数量），
 *   但**同一份纪律**：换一局 / 读档必须清掉。
 */
const vPicks = { slots: null };
/**
 * **被点开的档 A**（2026-10-05 · 序幕铺牌）—— `null` 或那条 event id。
 *
 * ⚠️ 为什么要单独一个状态，而不是复用 `detailOpen`：
 *   两者走**不同的浮层内容**（档 A 是"选项、点一下即结算"；`detailOpen` 是"阅览、不发请求"），
 *   复用会让 `renderOverlay` 里多一个 `kind` 分支 ⇒ 而那一处已经有 5 个分支了，
 *   再加会更难读。⚠️ 两层**互斥**（下面开一层时关掉另一层）—— 与 `composeOpen` 同一条纪律。
 * ⚠️ 它只是**页面上的临时状态** ⇒ `resetLocalViewState()` 里一起清。
 */
let popupOpenId = '';

/**
 * **两张固定功能事件的页面态**（2026-10-07 用户裁定：医馆疗伤 / 神殿净化）——
 * `fixPicks['医馆'] / fixPicks['大神殿']` = 人 id 或 `''`（空）；
 * `fixGold[...]` = 金币槽垫没垫（定额：拖金币卡进去即记，点一下取回）。
 * ⚠️ 与事件台 `picks` 同一条纪律：拖放是"意向"，点「确定」（`/api/restore`）才是事实；
 *    提交成功才清空。换一局 / 读档必须清（`resetLocalViewState`）。
 */
const fixPicks = { '医馆': '', '大神殿': '' };
const fixGold = { '医馆': false, '大神殿': false };

/** 两个功能事件的**定额与文案**（与 `turn/restore.ts·RESTORE_SPEC` 同源，改要两头改） */
const FIX_SPECS = {
  '医馆': { cost: 1, pts: 3, field: 'hp', title: '医馆 · 疗伤',
            desc: '受伤了就来这儿躺一躺。郎中手艺不错，就是诊金从不打折。',
            effect: '1 金 · 占 3 点行动力，到点 HP 回满', word: '身体' },
  '大神殿': { cost: 3, pts: 2, field: 'san', title: '神殿 · 净化',
            desc: '神殿的晨钟对心神有奇效。供奉多一点，但主祭说他见惯了惊慌的脸。',
            effect: '3 金 · 占 2 点行动力，到点 SAN 回满', word: '精神' },
};

/**
 * **某个人需不需要这个功能**（hp/san 在 1~2 之间 = 不满但治得了）。
 * ⚠️ = 0 是死亡 / 永久疯狂，治不了 ⇒ 不为它亮卡（亮了也是骗玩家点）。
 * ⚠️⚠️ 2026-10-07 用户裁定（第十五批）：恢复**延迟生效** —— 已有一单同名恢复在「处理中」时
 *   功能卡**整张隐藏**：那张「处理中」的合成事件卡已经代表它在办（服务端也不再收第二单），
 *   两张同时亮 = 同一件事在画布上出现两次。
 */
function fixNeeded(v, place){
  const sp = FIX_SPECS[place];
  if (arr(v.waiting).some((e) => e.title === sp.title)) return false;   // 这一单正在办
  const f = sp.field;
  const pool = [v.me].concat(arr(v.people).filter((p) => p.affiliated));
  return pool.some((p) => { const x = p[f]; return x !== undefined && x > 0 && x < 3; });
}

/**
 * **功能单**（2026-10-07 用户裁定：医馆/神殿点开后的那一屏）——
 * 一个人物槽 ＋ 一个金币槽 ＋ 标题描述 ＋ ×/✔。
 * ⚠️ **没有**处理方式按钮、**没有**叮嘱输入 —— 纯功能出口不经 LLM，
 *    "怎么处理"这个问题在这里根本不存在（用户原话）。
 * ⚠️ 落点：人槽 `data-drop="fix"`、金币槽 `data-drop="fixgold"`（判据在 `canDropOn`）。
 */
function fixSheetHtml(v, place){
  const spec = FIX_SPECS[place];
  const pid = fixPicks[place] || '';
  const p = pid ? (pid === v.me.id ? v.me : arr(v.people).find(function (x) { return x.id === pid; })) : null;
  const paid = !!fixGold[place];
  return sheetHead(spec.title, spec.effect + ' · 不经他人之手，当场见效') +
    '<div class="body">' + esc(spec.desc) + '</div>' +
    '<div class="fxslots">' +
      // 人物槽：只收一个人（换人 = 再拖一张进来）
      '<div class="fxslot' + (p ? ' filled' : '') + '" data-drop="fix" data-fix="' + place + '"' +
        ' title="' + (p ? esc(p.name) + ' —— 点 × 取出来' : '把一个人拖到这里') + '">' +
        (p
          ? '<span class="fx" data-act="fixClear" data-place="' + place + '" title="取出来">×</span>' +
            '<div class="fscard">' + esc(p.name) + '</div>' +
            '<div class="fssub">' + esc(p.identity || p.basic || '') + '</div>'
          : '<span class="flbl">谁去？</span><span class="pdash">＋</span>') +
      '</div>' +
      // 金币槽：定额 —— 空时中间写红色定额数字，垫了显示定额数（与事件钱槽同一套手势）
      '<div class="fxslot' + (paid ? ' filled' : '') + '" data-drop="fixgold" data-fix="' + place + '"' +
        ' title="' + (paid ? '已备好 ' + spec.cost + ' 金 —— 点一下取回' : '把金币卡拖到这里（需 ' + spec.cost + ' 金）') + '">' +
        (paid
          ? '<span class="fx" data-act="fixGoldClear" data-place="' + place + '" title="取回">×</span>' +
            '<span class="hg">' + spec.cost + '</span><span class="flbl">诊金已备</span>'
          : '<span class="flbl">诊金</span><span class="reqnum">' + spec.cost + '</span>') +
      '</div>' +
    '</div>' +
    '<div class="fxbut">' +
      '<button data-act="fixClose" title="先不治了">×</button>' +
      '<button class="primary" data-act="fixCommit" data-place="' + place + '"' +
        ((p && paid) ? '' : ' disabled') +
        ' title="' + ((p && paid) ? '当场见效' : '要放了人、备好了诊金才能定') + '">✔</button>' +
    '</div>';
}

/* ═══════════════════════════════════════════════════════════════════
   开局选择（2026-10-05 · 用户裁定「欲望与六维都改成玩家自己选」）
   ─────────────────────────────────────────────────────────────────
   ⚠️ **它不是一层浮层，是序幕末条那个弹窗里的内容** —— 玩家点下「迎接你『真实的
      自我』」之前就得选好；`v.desirePick.needsChoice` 是"该选"的唯一判据
      （`ui/session.ts` 那边算，UI 不自己判，见那条注释）。
   ⚠️ **本地这一份只是"还没发出去的那次编辑"**：真正的选择落在**服务端会话**上
      （`Session.choice`，由 `/api/desire/pick` 改）⇒ 这几个变量每次进这一层时
      **从 `v.desirePick.choice` 重新灌**，别让它变成第二份事实源。
   ⚠️ 优势属性上限 2 —— 上限那个数**不在这儿写死**（`ATTR_ADV_MAX` 在规则层），
      UI 靠"点第三个时提示上限"体现；判据仍在服务端（`pickDesire` 会拒）。
*/
let pickKit = -1;
let pickAdv = {};
/**
 * **选欲望的哪一步**（2026-10-06 用户裁定 · 问题 5/6/7：拆成三步）。
 * `''` ＝ 序幕那一句（带「选择你的欲望宣言」按钮）· `'kit'` ＝ 宣言（6 条）· `'adv'` ＝ 优势属性
 * ⚠️ **切回标题屏/换局时必须清空**（与 `pickKit`/`pickAdv` 同一处重置，见 `resetLocalViewState`）。
 */
let pickStage = '';

/* ═══════════════════════════════════════════════════════════════════
   就地引导（2026-10-05 · 用户裁定「做点背景铺垫与新手指引」）
   ─────────────────────────────────────────────────────────────────
   用户的原话是「把开局的事件变成非弹窗、但玩家没点完之前不许进下一天」，
   另一半是「**新手指引**」—— 玩家进了游戏还是不知道该干什么。

   关键决定：**教在动手的现场，不做开局教程面板**。理由很实在：
     · 教程面板要玩家**先读后做**，而他此刻还不知道"读这个有什么用" ⇒ 跳过的概率极高；
     · 写在现场的提示是**上下文相关**的：他正看着那张事件卡，
       "把下面的人拖到'人'那一格"这句话此刻才有意义；
     · 一行淡提示的成本 ≈ 0，而一个教程面板是一整屏他不想看的东西。

   四条纪律：
     ① **一处一个事实**：一条提示只说一件事，不做"操作手册"。
     ② **做过就消失**：做完那个动作，提示永久不再出现（`localStorage`）——
        反复出现的提示会从"帮助"变成"噪音"，而噪音会让人无视它。
     ③ **不拦截**：提示从不挡住任何操作，也不需要"我知道了"那颗按钮。
     ④ **跨会话**：它记在 `localStorage`（这是"玩家会不会用这个界面"的偏好，
        不是这一局的状态）⇒ 换一局不该重新教一遍。
   ═══════════════════════════════════════════════════════════════════ */
const HINT_KEY = 'wz.hints';
/** 看过哪些提示。存成一个对象，读一次。 */
function seenHints(){
  try {
    const v = JSON.parse(localStorage.getItem(HINT_KEY) || '{}');
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}
/** 标记"这条提示玩家已经会了" —— 在玩家**做成那件事**的那一刻调，不是在点提示时。 */
function markHint(k){
  try {
    const all = seenHints();
    if (all[k]) return;
    all[k] = 1;
    localStorage.setItem(HINT_KEY, JSON.stringify(all));
  } catch (e) { /* 存不进去只是"下次还教一遍"，不是错误 */ }
}
function hintSeen(k){ return !!seenHints()[k]; }

/** 一行淡提示 —— 贴在它**该被看见的那个东西**的上面/旁边，不是浮在屏幕中央。 */
function hintHtml(k, text){
  if (hintSeen(k)) return '';
  return '<div class="hint" role="note">' + esc(text) + '</div>';
}



/* ═══════════════════════════════════════════════════════════════════
   昼夜主题（2026-10-05 · 用户裁定「区分白天/黑夜，玩家可实时更换」）
   ─────────────────────────────────────────────────────────────────
   三档状态，落在 `<html data-theme>` 上：
     · 不写 `data-theme`  ⇒ **跟随系统**（`prefers-color-scheme`，见 CSS）
     · `data-theme="dark"`  ⇒ 玩家锁夜间
     · `data-theme="light"` ⇒ 玩家锁昼间

   ⚠️ **刻意只有两档按钮而不是三档**：第三档「跟随系统」在按钮上就是"再点一次回到默认"，
      而那需要玩家知道"现在是跟随的"。所以按钮显示的是**当前实际生效的那一档**
      （见 `resolvedTheme()`），点它 = 切到另一档。
   ⚠️ 存在 `localStorage` 里，**跨会话保留** —— 这是"偏好"不是"状态"。
   ⚠️ 切主题**不发请求、不碰账本**：它只是换一组 CSS 变量。
      但必须重新 `render()` —— 顶栏那颗切换按钮的文案依赖当前档位。
   ═══════════════════════════════════════════════════════════════════ */
const THEME_KEY = 'wz.theme';

/** 玩家**显式**选过的那一档（`null` = 没选过 ⇒ 跟随系统）。只从 localStorage 读一次。 */
function savedTheme(){
  try {
    const v = localStorage.getItem(THEME_KEY);
    return (v === 'dark' || v === 'light') ? v : null;
  } catch (e) {
    // 隐私模式 / 存储被禁：退回"跟随系统"，**不许因此报错**（主题不是必需功能）
    return null;
  }
}

/**
 * **当前实际生效**的那一档 —— 用来给按钮写对文案。
 * ⚠️ 不读 `document.documentElement.dataset` 就答不出来：那是"玩家选了什么"，
 *    这一档才是"屏幕上是什么"。没选过时它取决于系统。
 */
function resolvedTheme(){
  const saved = savedTheme();
  if (saved) return saved;
  // matchMedia 是唯一可靠的判据（CSS 里那两半 media 与它必须一致）
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches) return 'dark';
  return 'light';
}

/** 把某一档写进 `<html>`（`null` = 撤掉，回到跟随系统） */
function applyTheme(t){
  const el = document.documentElement;
  if (t) el.setAttribute('data-theme', t);
  else el.removeAttribute('data-theme');
  try {
    if (t) localStorage.setItem(THEME_KEY, t);
    else localStorage.removeItem(THEME_KEY);
  } catch (e) { /* 存不进去也只是"下次不记得"，不是错误 */ }
}

/**
 * 页脚那颗切换按钮的文案 ＋ 图标。
 * ⚠️ 用**当前档**的字（"切到昼间" / "切到夜间"），不是"当前是昼/夜"——
 *    按钮说的是**按下去会发生什么**（业界惯例：动作标签，不是状态标签）。
 * ⚠️ 图标是纯 CSS 画的（一个圆＝日，一个被遮住的圆＝夜），不引图片（离线要能跑）。
 */
function themeBtnHtml(){
  const now = resolvedTheme();
  const to = now === 'dark' ? 'light' : 'dark';
  return '<button data-act="theme" title="当前：'
    + (now === 'dark' ? '夜间（跟随/锁定）' : '昼间（跟随/锁定）')
    + ' — 点一下切到' + (to === 'dark' ? '夜间' : '昼间') + '">'
    + '<span class="tsw ' + now + '" aria-hidden="true"></span>'
    + (to === 'dark' ? '切到夜间' : '切到昼间') + '</button>';
}

