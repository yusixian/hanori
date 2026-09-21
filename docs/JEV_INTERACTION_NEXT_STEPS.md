# JEV 互动承接下一阶段建议

> 日期：2026-09-21 ｜ 状态：Draft ｜ 调研基线：`d812517`

## 结论

下一步不应把“等下一张图”“先别回”等语义塞进现有 `pending turn`、任务取消或冷却。推荐先在现有一次 JEV 请求中增加独立的短期互动意图分类，并只在 shadow 中记录和人工标注；标注结果可接受后，再增加一个进程内、按群聊话题隔离的短期状态层。它只影响新的被动接话准入，不能取消已经开始的模型调用。

该状态层需要覆盖两类最小状态：

- `awaiting_followup`：某位用户明确说稍后补充内容；同一用户在同一话题发来合格补充时，才作为 `continue` 候选重新评估。再次表示“还在找／再等等”不消费状态，也不延长其有上限的总期限。
- `proactive_pause`：群里明确要求 Bot 暂停参与，或 Bot 主动插话后尚未得到承接；期间阻止新的 `join`，但明确 @、回复 Bot 或重新点名可以恢复。

## 目标与非目标

目标是让 JEV 区分“是否回复”“与 Bot 的关系”和“短期互动意图”，并在 privacy、forum topic、冷却和已有执行协调边界内承接跨消息语义。所有语义质量先经 shadow 样本人工标注，不把模型置信度称为准确率。

本轮明确不做：

- 不做自然语言触发的任务取消；“不用回了”不终止已经运行的 actor/tool 调用。
- 不做模型路由或 actor 模型切换。
- 不引入情绪值、关系分数、亲密度或长期用户画像。
- 不调用真实 JEV/Telegram，不改生产配置。
- 不新增 Telegram reaction 能力；只建议复用现有能力。

## 当前实际能力与缺口

| 主题               | 当前能力                                                                                                                                                                                                                                                                                                                                  | 直接缺口与证据                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JEV 判断           | PR #74 已把 `reply: answer/silent` 与 `participation: addressed/continue/join` 拆开；reply 阈值决定准入，关系只决定冷却语义。见 `packages/bot/src/services/engagement-evaluator.ts:96-116,410-429,454-485`。                                                                                                                              | 没有“等后续输入／结束交流／暂停插话／恢复邀请”这一独立语义轴，无法可靠地产生跨消息状态。                                                                                                                                                                           |
| 上下文与话题       | JEV 文本 buffer 和主动插话 cooldown 都按 `(chatId, message_thread_id)` 隔离，见 `packages/bot/src/handlers/ai-reply.ts:1480-1496,1640-1653,1707,1893-1912`；JEV 上下文硬上限为最近 20 条、5 分钟、6000 字符，见 `packages/bot/src/services/engagement-evaluator.ts:11-18,47-93`。                                                         | `EngagementContextMessage` 保存的是文本，不包含附件类别；裸图片的 `currentText` 为空，active 模式会落到 `shouldEvaluate=false` 并沉默，见 `packages/bot/src/handlers/ai-reply.ts:1763-1775,1865-1867`。因此“等我再发一张图”之后的裸图不能被当前 JEV 承接。         |
| message coalescing | `AiTurnCoalescer` 只把同一 chat/topic、同一 user、相同 privacy mode 的快速后续消息并入一个**尚在排队**的 run；默认上限 10 条/2000 字，见 `packages/bot/src/services/ai-turn-coalescer.ts:19-29,48-66,69-128`。已开始的 run 不再合并。                                                                                                     | handler 仅对纯文本尝试合并，图片、文档和回复媒体走完整新回合，见 `packages/bot/src/handlers/ai-reply.ts:1972-2015`。它不是等待用户下一条消息的计时器，也不能表达“待补图”。                                                                                         |
| 待处理回合         | 群消息可先以 `meta.turnState=pending` 入库，完成时原子标为 `complete`；pending 用来阻止压缩/裁剪越过未完成回合，进程重启时统一恢复为 complete。见 `packages/bot/src/handlers/ai-reply.ts:1928-1963,3350-3389`、`packages/server/src/services/conversation-store.ts:414-492,799-817`、`packages/server/src/services/bot-pool.ts:655-667`。 | 这是历史顺序和压缩安全标记，不代表 Bot 在等用户补充内容；不能复用为交互状态。                                                                                                                                                                                      |
| 取消与重试         | `AiExecutionCoordinator` 可按 runtime/chat/user abort，并以 epoch 防止旧 run 继续提交；等待清理上限为 5 秒，见 `packages/bot/src/services/ai-execution-coordinator.ts:72-88,108-177,180-246,259-275`。`/stop` 会同时清理 coalescer、JEV gate 和 active actor，见 `packages/bot/src/handlers/ai-reply.ts:1025-1042`。                      | 普通群消息没有语义取消入口。JEV 超时/错误不即时重试而回退 legacy trigger，见 `packages/bot/src/handlers/ai-reply.ts:1868-1892`；仅历史 finalization/私聊补存按 `[0,50,150]ms` 做有限 DB 重试，见 `packages/bot/src/handlers/ai-reply.ts:889,3333-3348,3358-3387`。 |
| privacy            | 当前消息、buffer 作者及派生 Bot 回复都携带 contributor IDs；判断前复查 privacy 和 reset 时间，forget 后旧 buffer/迟到派生内容不能重新进入 JEV，见 `packages/bot/src/handlers/ai-reply.ts:1623-1699,1787-1822,3212-3241`、`packages/server/src/services/user-privacy-service.ts:51-94,107-116,128-215`。                                   | 新状态必须携带创建者/贡献者及 capturedAt，沿用同一 fail-closed 复查；不能只按 chatId 保存一段无来源状态。                                                                                                                                                          |
| 明确邀请与冷却     | active 模式下 reply-to-Bot、明确 mention 直接准入；普通 `join` 才提交 cooldown，确认的 `addressed` 或最近 2 分钟 Bot 发言后的 `continue` 可绕过，见 `packages/bot/src/handlers/ai-reply.ts:728-743,1754-1759,1893-1913,3461-3463`。cooldown 按 chat/topic，不限制 JEV 调用。                                                              | 目前“主动插话无人接”只有 cooldown，没有“这次 join 尚未被接住”的状态；冷却结束后仍可再次主动插话。                                                                                                                                                                  |
| 样本与人工标注     | 样本记录建议、实际 trigger、配置版本、上下文、成本和 `answer/silent/uncertain` 人工标签；现有指标按人工标签算 FP/FN，见 `packages/database/src/schema.ts:251-315`、`packages/server/src/services/engagement-sample-service.ts:220-317`。                                                                                                  | 现有 label 只能评价是否回复，不能标注关系类别、短期意图、建议回复载体，也没有“实际发送成功／后续有人承接”的关联结果。`actualTrigger` 只说明准入，不证明 Telegram 已发送。                                                                                          |
| reaction           | 普通消息 actor 已有 `react_to_message`，直接调用 Telegram `setMessageReaction`，见 `packages/bot/src/tools/index.ts:190-209`；该工具已合入每回合工具集合，见 `packages/bot/src/handlers/ai-reply.ts:2169-2179,2622-2636`。                                                                                                                | 这只证明已有 Telegram API 能力。它不保证 actor 一定选 reaction、不会再发文字、不会重复，也不定义 reaction 失败后的行为；不能把“建议 reaction”记成成功 reaction。                                                                                                   |

另外，JEV/coalescing/cooldown 已按 forum topic 隔离，但 actor scheduler 仍以 `chatId` 串行，见 `packages/bot/src/services/ai-reply-scheduler.ts:145-170`。下一阶段不改变这个执行并发边界。

## 推荐切片与依赖

### M1：只做 shadow 语义与标注扩展

在现有一次 JEV 请求中增加独立 `interactionCue` Choice，候选为：

```text
none | await_followup | close_exchange | pause_proactive | resume_invitation
```

它不覆盖 `reply` 和 `participation`：例如“等我再发一张图”可以是 `reply=silent`、`participation=continue`、`interactionCue=await_followup`。样本另存 cue、各自分布及人工标签，并允许人工标注建议载体 `text | reaction | silence | uncertain`。M1 不写运行状态、不改变实际回复，先用 synthetic matrix 和指定测试群 shadow 收集分母。

依赖：沿用现有 bounded request、configVersion、privacy filtering 和 7 天上下文清理；样本展示必须明确三组独立概率，不能合并成一个总分。

### M2：短期互动状态

M1 的分类在人工作业中达到可接受表现后，再增加进程内 `JevInteractionState`。它放在 JEV gate 前后、actor scheduler 之前，不进入 `AiTurnCoalescer` 或 conversation `turnState`。

| 状态                               | 作用域                                                             | 建立时机                                                       | 消耗／失效                                                                                                                                                                     | 恢复原则                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `awaiting_followup`                | `(bot runtime, chatId, threadId, ownerUserId)`                     | 当前消息 privacy 可验证，cue 经已校准门槛判为 `await_followup` | 同一用户同一 topic 的后续消息只有在被判为合格补充时才消费；“等下／还在找”等未完成补充保留状态但不刷新总期限。明确取消、privacy off/forget、总期限到期、Bot stop/destroy 时失效 | 首版不跨进程恢复；重启后回到普通 JEV。需要超出当前 JEV 上下文窗口时，必须另做持久化设计，不能静默延长。 |
| `proactive_pause(explicit)`        | `(bot runtime, chatId, threadId)`，记录发出 cue 的 contributor     | cue 为 `pause_proactive`                                       | 明确 @、reply-to-Bot、重新点名邀请清除；privacy reset、超时、stop/destroy 失效                                                                                                 | 首版不跨进程恢复；状态存在时只拦 `join`，不得拦明确邀请。                                               |
| `proactive_pause(unanswered_join)` | `(bot runtime, chatId, threadId)`，关联已成功发送的 Bot message id | `engagement_join` **实际成功发送后**建立                       | 有人直接或隐式承接该 Bot 消息时清除；重新邀请也清除；到期/stop/destroy 失效                                                                                                    | 不从“准入成功”推断“发送成功”；没有 delivery id 不建立。                                                 |

状态 TTL 不新增拍脑袋常数：首版上限复用当前 JEV 可见上下文时限，实际值必须由 M1 标注分布决定并受该上限约束。任何要跨越现有上下文窗口或跨重启的等待，都升级为 durable state 设计并单独评审。

准入顺序应固定为：权限/AI enable → privacy → 确定性 mention/reply → 读取短期状态作为分类上下文 → JEV reply/participation/passive cue → 分类后应用状态约束 → cooldown → usage/scheduler。明确 mention/reply 可提前恢复 pause；仅靠“重新邀请／你来聊吧”等自然语言恢复时，在 privacy 允许下仍要完成分类，不能被前置 pause 直接挡掉。pending pause 可以在分类前读取，但只在分类后拦截 `join`。

状态通常只缩小主动插话范围；`awaiting_followup` 唯一可扩大的是同一用户、同一 topic 的**合格补充**，包括无 caption 的图片。后续消息若仍表达等待、与承诺内容无关或语义不确定，不强制标为 `continue`，也不无限延长等待。若来源不可验证或 privacy 复查失败，直接丢弃状态并按普通路径处理。

### M3：回复载体与结果关联

依赖 M2 的状态和实际 delivery 关联，M3 需要单独设计受限载体路径来执行 `brief_text | reaction | normal_text | silence`：一次决策只能选择一种载体，明确控制是否允许文字、是否允许 reaction、去重以及 reaction 失败后保持沉默还是退回文字。不能只给现有自由 actor 增加 `styleHint`，就声称能够保证不发文字、不重复或失败后沉默。

reaction 复用现有 `react_to_message`/`setMessageReaction` 能力，不新增 Telegram API/tool；但受限载体路径必须负责上述执行契约。保存“建议载体、实际工具/文字投递、Telegram delivery id、后续是否有人工判定的承接”，用于区分 gate、actor、Telegram 三层结果。

## 合成场景矩阵

以下是人工可复核的契约，不是让 mocked JEV 自己证明语义正确。mock tests 只能证明给定分类结果后，程序路由、状态和失效边界正确；中文语义准确率必须来自真实 shadow 样本和人工标注。

| 场景                                         | 是否应回复               | 关系/意图                                           | 建议载体                                                        | 确定性程序边界                                                                                                                |
| -------------------------------------------- | ------------------------ | --------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Bot 刚问“可以发图”，用户说“等我再发一张图”   | 新策略不追加实质文字     | `continue + await_followup`                         | M1/M2 默认 silence；M3 可在受限载体路径中选 reaction 或极短确认 | 只为该用户、该 topic 建立有总期限的等待；不启动任务取消，M1 shadow 不改变 legacy 实际行为。                                   |
| 上述用户随后发裸图片                         | 应承接                   | 合格补充时为 `continue`，并消费 `awaiting_followup` | 正常文字                                                        | 即使图片无 caption，也可进入现有媒体 actor pipeline；其他用户的图片不能消费该状态。                                           |
| 上述用户随后又说“等下，我还在找”             | 暂不回复                 | `await_followup` 未完成                             | silence                                                         | 不消费状态、不强制 `continue`、不刷新总期限。                                                                                 |
| 等待期间另一位用户在同 topic 发言            | 通常不因等待而回复       | 由 JEV 判定                                         | silence                                                         | 不跨用户消费，不把两人的隐私来源合并成无来源状态。                                                                            |
| Bot 解答后用户说“哦懂了谢谢”                 | 新策略不再发实质文字     | `continue + close_exchange`                         | M1/M2 默认 silence；M3 可在受限载体路径中选 reaction            | M1/M2 不为 closure 额外启动载体执行；M3 才定义 reaction 单独执行、去重及失败后沉默。是否属于 closure 是模型语义，需人工标注。 |
| 用户对 Bot 说“不用回了”                      | 不回复                   | `close_exchange/pause_proactive`                    | silence                                                         | 只拦后续新准入，不取消已开始 run；明确重新邀请可恢复。                                                                        |
| 群友说“我们先聊”                             | 不主动插话               | `pause_proactive`                                   | silence                                                         | 拦同 topic 的 `join`；不影响其他 topic，不覆盖权限/隐私规则。                                                                 |
| 暂停后有人明确 @ Bot：“助手你怎么看？”       | 应回复                   | `addressed + resume_invitation`                     | 正常文字                                                        | 现有 mention 直达；清除同 topic pause，仍受 AI enable、权限、privacy、usage。                                                 |
| 暂停后有人 reply-to-Bot 继续追问             | 应回复                   | `addressed` 或 `continue + resume_invitation`       | 正常文字                                                        | 现有 reply-to-Bot 直达；清除 pause。                                                                                          |
| Bot 主动 `join` 后无人回应，群友继续彼此聊天 | 不再次主动插话           | `unanswered_join`                                   | silence                                                         | 只有成功 delivery 后才建立；阻止新的 `join`，不把沉默当成负面关系分。                                                         |
| Bot 主动 `join` 后有人回复其内容             | 可继续                   | `continue`                                          | 简短或正常文字                                                  | 关联 Bot message/reply 或人工可见上下文后清除 unanswered 状态。                                                               |
| 同样文本出现在另一个 forum topic             | 独立判断                 | 独立关系                                            | 由该 topic 决定                                                 | `(chatId, threadId)` 隔离，不能继承等待、pause 或 unanswered。                                                                |
| 用户 `/privacy off` 后普通发言               | 不做被动判断/建状态      | 无                                                  | silence                                                         | fail closed；清除含该用户来源的短期状态。明确 @/reply 仍沿用现有直达语义。                                                    |
| JEV 超时、无效或过载                         | 沿用现有 legacy fallback | 未知                                                | 由旧规则决定                                                    | 不即时重试；不得从失败响应建立互动状态。                                                                                      |
| Bot 重启后用户才发后续图片                   | 首版按普通路径           | 无已恢复状态                                        | 普通 JEV/trigger 决定                                           | M2 状态不持久化；不能假装仍记得等待承诺。                                                                                     |

## shadow 对照评估

所有指标按 `configVersion + group + style + relation class` 分层展示，同时列出总样本数、可人工判定数、`uncertain`、JEV error/timeout 数；不能把错误样本静默排除后只报一个百分比。

| 产品问题         | 分母                                                                             | 分子/报告方式                                                                         | 人工标签要求                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **叫它接得住**   | 人工标为应回复，且关系为 `addressed / continue / fulfilled_followup` 的样本      | JEV 建议 answer 且关系类别与人工一致；分别报告 reply recall 与 relation agreement     | 标注者看完整脱敏上下文，独立选择是否应回复、关系和 cue；JEV 不参与打标。                                                                                                                                                                                 |
| **无人叫不打扰** | 人工标为 silent 的 ambient、closure、pause、unanswered-join 样本                 | JEV silent 或确定性 pause 拦截的比例；同时报告其补集“误插话率”                        | 必须抽查“模型与旧逻辑都沉默”的样本，避免只标冲突样本造成偏差。                                                                                                                                                                                           |
| **接后聊得下去** | shadow 阶段仅能使用人工标为“若按新 cue 建议回应，具备自然承接空间”的 answer 样本 | 只报告 relation/style agreement，明确标为代理指标；观察到的 legacy 实际回复可单列分析 | shadow 不会按新 cue 建议额外生成或投递回复；它保留 legacy 行为，因此可能观察到旧触发路径的实际回复，但这不能证明新策略的反事实效果。真实指标要在受控 active pilot 中，以**按新策略实际成功投递**且人工确认相关的回复为分母，再人工标注后续是否自然承接。 |

“主动插话无人接”另报：分母为成功投递的 `engagement_join`，分子为在同一 topic、同一有界观察窗口内没有人工确认承接的样本。观察窗口沿用互动状态生命周期，不另造第二套阈值；沉默只触发 pause，不形成情绪值或关系分数。

抽样要同时包含正例、负例、边界例和 JEV/legacy 不一致例。人工标注前隐藏模型答案；争议样本记 `uncertain`，不强行多数表决成准确答案。现有 `label=answer/silent/uncertain` 可继续用于 reply 指标，但关系、cue、载体和后续承接需要独立字段，不能复用一个 label。

## 文字、表情与沉默

M1 只记录建议，不改变 legacy 行为；M2 只实施短期状态，等待确认、closure 和 pause 默认不额外执行 reaction。M3 才引入独立受限载体路径，并保证一次只选一种：

- **正常文字**：明确邀请、实质问题、合格补充已经到达、或承接 Bot 上一条内容时使用。
- **reaction**：可用于低信息量确认或自然收尾，例如“等我发图”“懂了谢谢”；复用现有 `react_to_message` 能力。受限载体路径必须禁止同一决策再补同义文字，并明确失败时是否保持沉默。
- **沉默**：明确“不用回／我们先聊”、主动插话无人承接、重复内容、JEV 判断 silent 时使用。

现有 reaction 工具只证明 Telegram 调用可用，不证明上述互斥、去重和失败策略。载体执行也不能覆盖确定性边界：privacy、权限、AI disable、usage、取消状态先决定能否执行；Telegram 实际发送结果必须单独记录。

## 备选方案与权衡

| 方案                                | 优点                                                            | 代价/风险                                                       | 结论                                                           |
| ----------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| 只改 JEV prompt，不存状态           | 改动最小                                                        | 裸图片无文本时仍无从承接；“先别插话”不能跨消息生效              | 不采用                                                         |
| 独立 cue + shadow 标注 + 短期状态   | 能复用当前 JEV、privacy、topic 和 cooldown 边界；状态用途可审计 | 增加一组概率和标注字段；进程重启会丢状态                        | 推荐                                                           |
| 直接做持久化会话/关系状态           | 可跨重启、支持长等待                                            | 需要迁移、恢复、跨版本语义和清理策略，容易滑向关系分数/任务系统 | 后置，只有真实样本证明需要长等待时再评审                       |
| 用关键词/正则识别“谢谢／别回／等图” | 延迟低、确定性强                                                | 中文表达变体多，误伤高，无法可靠区分对 Bot 说还是群友互聊       | 不采用为主路径；只保留明确 Telegram mention/reply 等结构化信号 |

## 测试、上线与回滚

M1 先做纯函数 payload/解析、privacy 清理、样本 schema/API/UI 定向测试；mock 响应只断言路由，不宣称语义准确。M2 再覆盖同 user/异 user、同 topic/异 topic、合格补充/继续等待、总期限不刷新、裸图、结构化与自然语言重邀、privacy reset、timeout、stop/destroy、JEV error fallback、delivery 失败不建立 unanswered state。M3 覆盖受限载体互斥、reaction 成功/失败策略、文字与 reaction 不重复、实际 delivery 关联。

上线仍沿用 `off → 单群 shadow → 人工标注 → 单群 active`。回滚只需关闭新 cue/state feature 并清空进程内状态；原有 JEV reply/participation、legacy fallback 和数据表继续工作。若新增样本列，保留为可空字段，不要求回滚迁移。

## 待决问题

- M1 人工标注量达到多少才允许 M2 active，应由测试群样本分布和可接受误插话/漏接成本决定，本文件不臆造数字。
- `awaiting_followup` 超出现有 JEV 上下文时限是否有真实需求；若有，需要另行决定持久化、重启恢复和用户可见取消方式。
- “我们先聊”由一个成员发出时是否代表整个 topic；首版建议只拦主动 `join`，任何明确邀请均可恢复，避免永久静音。
- shadow 是否值得生成但不发送 actor 候选回复以评价文案质量；这会增加模型成本和隐私处理面，默认不做。
