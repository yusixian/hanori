# UI 效率与可靠性持续迭代目标

状态：进行中。建立于 2026-09-22。此文件是跨会话、压缩后恢复工作的持久入口。

## 用户目标与持续授权

优先解决管理面板「杂乱、不高效」，让常用操作更容易找到、完成和确认；同时改善相关关键流程的可靠性。以可独立验收的版本持续迭代，不能把第一版发布视为整个目标完成。

用户已明确授权本目标内的实现、提交、push、审查、PR 合入和自主版本发布：

- 可直接在本仓库 main 提交和 push；若远端保护或权限不允许，改走 PR 并审查合入，不绕过保护。
- 自主决定每轮版本号、内容、tag 和 GitHub Release，无需逐轮重复请求确认。
- 每轮更新都必须仔细 review，解决重要发现后交付；主代理负责产品方向、整合、最终复核和发布。
- 有界实现和简单任务可委派 Sol subagent，明确文件所有权并保留他人修改。
- 重要功能和行为改进更新对应公共指南、文档站与版本说明；合入后复核同步结果。
- 发布授权不自动包含生产部署、生产数据修改或真实 Telegram 消息发送。源码、构建、CI、GitHub 发布和线上运行状态分开记录。

这些是 2026-09-22 本会话的明确授权，在本目标内持续有效；不泛化到其他项目或无关任务。

## 执行和验证规则

1. 续跑先读本文件、根 AGENTS.md、当前差异和最新远端状态，不以旧记录替代验证。
2. 从实际用户旅程和浏览器证据确定优先级，再设计、实现；保留品牌与已有能力，减少查找、跳转和重复操作。
3. 覆盖桌面/手机、键盘操作，以及相关加载、空、错误、重试和未保存状态；测试夹具与真实服务行为分开记录。
4. 本地运行受影响的格式、lint、类型和行为/浏览器检查；全量检查交给 CI。检查失败后先判断原因，不通过弱化断言掩盖问题。用户后续明确要求耐心等待 CI、减少无效检查：同一 run 复用一个 watcher，按实际进度与历史耗时延长查询间隔；工具提前返回不等于 CI 失败，不重复启动检查。
5. 每轮仔细审查最终差异与实际调用路径，修复已证实的重要回归；主代理复核 worker 产物。
6. 按完整 SHA 验证远端提交、CI、tag 与 Release。文档版本正文统一来自 docs/releases/vX.Y.Z.md，不手改生成的 changelog 文件。
7. 保留无关改动和隐私/权限契约，不修改或提交秘密与运行数据。
8. 每个阶段结束更新下方记录，记录证据路径、未验证项和下一步，避免压缩后丢失工作。

## 路线图和验收范围

先建立基线，再按发现调整具体版本内容；下面是工作范围而不是已完成承诺。

| 阶段         | 用户成果                                      | 可观察验收                                                                          |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| 导航与工作区 | 清晰区分全局管理与单个 Bot 工作；常用入口易找 | Bot 内可直达全局入口；菜单按任务分组；当前页面唯一高亮；桌面折叠/手机抽屉和键盘可用 |
| AI 配置      | 更容易找到设置、理解分区和确认保存            | 高频配置可快速定位；修改/保存/错误反馈明确；切换分区保留草稿；手机主要操作可见      |
| 高频管理流程 | 列表筛选、详情和操作形成连贯流程              | 选定高频页面后记录操作路径；验证搜索/筛选/清空/重试和必要批量操作，避免无效跳转     |
| 可靠性       | 取消、超时、续聊和依赖故障有准确状态          | 为具体故障建立复现与行为回归；防止重复发送/副作用重放；健康信息与已验证事实一致     |
| 文档与发布   | 每轮可追溯、可使用、可回滚                    | 对应指南与版本页同步、构建通过；审查和 CI 完成；远端版本/Release 核实               |

完整目标完成需上述已确定旅程的优先问题逐项验收，各轮审查、文档、CI 和发布闭环；未验证或仍有重要问题时保持进行中。用户可随时调整优先级或停止。

## 当前迭代

- v0.14.1 全局日志 Bot 名称查找是当前候选：v0.13.1 已读取全部 Bot 选项，但 125 个合成 Bot 的 390px 菜单一次约显示 8 项，选末项仍需反复滚动。现已在完整选项与错误重试契约上加入弹层内可见名称搜索，保留 `botId` 的日志与清理范围；URL 后退/前进同步也已修复。实现者与独立审查者在最终树分别复跑聚焦 Chromium 18/18，类型、i18n 2441 keys 和局部 lint/format 通过；主代理最终生产构建及 1440px/390px 中英文合成预览通过，文档类型/构建和定向浏览器 4/4 通过。独立 Sol 逐轮复核关闭重要发现，终态无剩余可复现 P1/P2；CI 和发布待完成。Lody 独立基线会话 `8362d16a-7422-41b5-ba70-5868f2072680` 仍在执行。详细证据与限制见 [日志 Bot 名称查找验收](UI_LOG_BOT_SEARCH_AUDIT.md)。

- v0.14.0 侧栏账户区已通过当前切片验收并发布：用户提供的 Android Chrome 截图显示 Bot 工作区手机侧栏底部固定语言选择与四个入口，其中大块「退出登录」和其余常驻控件挤占导航高度。现改为单行账户入口，设置、语言、文档、更新说明和退出移入侧栏内菜单；旧生产预览基线 153 CSS px，新构建桌面/390px 为 69px。聚焦浏览器 14/14、类型、i18n、生产构建、文档检查与中英文生产预览通过；Lody 独立初审和两次窄复核无剩余重要发现。CI 35848245960 completed/success，精确 SHA 匹配；main/tag/Release 目标 `cdbc5e902c5340b9fcaad8ced39e399d8b9b0ff6` 已核实。v0.14.0 Release 已公开，正文与版本文件逐字相同。保留未保存草稿确认与退出失败恢复；未执行生产部署或实机新版本复验。详细边界见 [侧栏账户区验收](UI_ACCOUNT_FOOTER_AUDIT.md)。

- v0.13.1 全局日志 Bot 选项完整加载已通过当前切片验收并发布：main/tag/Release 目标 `72909dab037332d7ec5514c879afba78b340d5a2` 已核实；CI 35844684682 completed/success，精确 SHA 匹配，面板与文档浏览器门禁通过。125 Bot 的桌面/手机生产预览、失败重试和版本页定向检查通过，Lody 独立代码与视觉复核均无本轮阻断项。v0.13.1 Release 已公开，正文与版本文件逐字相同。详细证据见 [全局日志 Bot 筛选验收](UI_LOG_BOT_OPTIONS_AUDIT.md)。未部署生产；长期目标继续，大量选项的手机查找成本列为下一轮独立 P2。

- v0.13.0 Bot 名称查找已通过当前切片验收并发布：main/tag/Release 目标 `ed552c5925c722d2f3be023739d74602c8a33f82` 已核实；CI 35841752963 completed/success，精确 SHA 匹配，完整门禁通过。125 Bot 桌面/手机聚焦浏览器和新版本页检查通过；Lody 两个只读会话发现的 4 项 P2 已修复并经原会话复核关闭。v0.13.0 Release 已公开、非预发布，正文与版本文件完全一致。详细证据和环境限制见 [Bot 名称查找验收](UI_BOT_SEARCH_AUDIT.md)。未执行生产部署；长期目标仍进行中。

- v0.12.1 模型用量明细可读性已通过当前切片验收并发布：基线 `476e175090a1c794e5c9e7b96b8591bf21ec6965` 在桌面/手机均复现长模型 ID 裁切。main/tag/Release 目标 `3341a82256cc4919b64a442aa653e8f7db751dde` 已核实；CI 35837676270 completed/success，精确 SHA 匹配。聚焦浏览器、生产构建预览和文档检查通过，独立审查无明确阻断项；v0.12.1 Release 已公开，正文与版本文件一致。完整证据及隔离验收器的环境限制见 [模型明细验收](UI_USAGE_MODEL_AUDIT.md)。未执行生产部署；长期目标仍在进行中。

- v0.12.0 JEV 接话调参与决策诊断已通过 PR #99 合入并发布；合入/tag/Release 目标 `1e9373576f5b6054244b10beee586772eae68b92`，合入树与审查候选一致。PR CI `35692891816` 与合入后 CI `35694686043` 均已核实 completed/success，各自精确 SHA 匹配。两位 Sol 交叉复核配置/runtime/diagnostics，Luna 完成设置面板和文档核对，重要发现已修复。交付独立参与阈值、续聊窗口、显式偏好示例、原始参与判断、分格式评估及配置筛选；默认策略和线上配置未变。没有手动触发生产部署；后续只读核验确认线上 ready 的 version 为发布 SHA，公开版本页/指南及三个新面板字段均已可用。完整证据见 [JEV 交付记录](JEV_TUNING_DELIVERY.md)。

- v0.11.1 生成记录读取与删除恢复已通过 PR #98 合入并发布；main/tag/Release目标 `d69c26541fa157648a8dae49a5e575df2ac2845d`。PR CI `35679788689` 与合入后CI `35680398600` 均已核实 completed/success，各自精确SHA匹配；合入树与审查候选一致。完整证据见 [生成记录验收](UI_GENERATIONS_AUDIT.md)。

- v0.11.0 会话搜索已通过 PR #97 合入并发布；main/tag/Release目标 `29acc69a6a08b882b08883b7e9c06dfe440f8731`。最终PR CI `35673958683` completed/success，合入文件树与已验证候选一致；合入后CI `35674641833` 已核实 completed/success，精确SHA与发布目标一致。完整证据见 [会话管理验收](UI_CONVERSATIONS_AUDIT.md)。

- v0.10.1 对话加载与删除恢复已通过 PR #96 合入并发布；main/tag/Release目标 `ee64f956614ef61d8cf00d984511e601e0958225`，PR CI `35665294298` completed/success。合入后 CI `35665935568` 已核实 completed/success，精确 SHA 与发布目标一致。完整证据见 [会话管理验收](UI_CONVERSATIONS_AUDIT.md)。

- v0.10.0 人物检索与记忆筛选已通过 PR #95 合入并发布；main/tag/Release目标 `2aa07ebe503d90813183c3bc4ac873a6af54bb65`，PR CI `35660728032` completed/success。合入后 CI `35661423268` 已核实 completed/success，精确SHA为发布目标 `2aa07ebe503d90813183c3bc4ac873a6af54bb65`。完整证据见 [管理流程验收](UI_RECORD_MANAGEMENT_AUDIT.md)。

- v0.9.1 档案/记忆错误恢复已通过 PR #94 合入并发布，main/tag/Release目标 `fb5f65469f86dff72005085c4b5d745e7b796949`；PR CI `35654979772` completed/success，合入后 CI `35655824699` 已核实 completed/success，精确SHA为发布目标 `fb5f65469f86dff72005085c4b5d745e7b796949`。完整证据见 [管理流程验收](UI_RECORD_MANAGEMENT_AUDIT.md)。

- v0.9.0 用量页已通过 PR #93 合入并发布，main/tag/Release目标 `e744e658b6237a231084812226b0131f3262077d`；PR CI `35649611905` completed/success，合入后 CI `35650499592` 已核实 completed/success。完整证据见 [用量页复核](UI_USAGE_AUDIT.md)。

- v0.4.0 导航、v0.5.0 AI 设置查找、v0.5.1 日志筛选、v0.6.0 草稿保护、v0.7.0 Bot 列表与管理入口均已完成审查、PR CI、合入、GitHub Release 和合入后 CI。
- 用户指定的后续 Issue #87 已通过 PR #92 合入并核实 CLOSED，发布为 v0.8.0。合入提交与 tag/Release 目标为 `e5b079e29e2b7854b3bc2a68a970c82e26ce8ccd`。
- v0.8.0 PR CI `35644021599` completed/success，合入文件树与已验证 head 一致；合入后 CI `35644859749` 已核实 completed/success，精确 SHA 与发布一致。
- 本轮所有已确认重要审查发现已修复。长期目标和授权继续保留；后续 UI 优先项从真实用户旅程重新验证，历史巡检记录仅作为候选，不把旧问题直接当成当前事实。
- 没有执行生产部署、真实模型调用、真实头像读取或 Telegram 消息发送。文档源码/构建与 GitHub 发布已同步，不据此断言线上实例已经更新。
- 无关 `.claude/`、`HANDOFF.md`、`packages/bot/src/skills/$OUT/` 保持原状。5188、5192验收预览已关闭；Docker 不可用，3100/5173 属于其他项目，勿动。

## 迭代证据

### v0.14.0 — 更紧凑的侧栏账户入口

- 用户 Android Chrome 截图基线、合成浏览器的桌面/390px 验收、键盘与退出路径、独立审查及环境限制见 [侧栏账户区验收](UI_ACCOUNT_FOOTER_AUDIT.md)。
- main/tag/Release 目标 `cdbc5e902c5340b9fcaad8ced39e399d8b9b0ff6`；CI `35848245960` completed/success，精确 SHA 匹配，含完整浏览器和公开文档浏览器门禁。Release 已核实公开、非预发布，正文精确匹配 `docs/releases/v0.14.0.md`。
- 发布后验收记录提交 `1fd4f5ee19feff3f4b66ab9c32203b05fcf8cd1b` 已推送 main，CI 35848823744 completed/success，精确 SHA 匹配；该记录提交不改变 v0.14.0 tag/Release 目标。
- 未部署生产，也未在用户 Android 设备上复验。长期目标继续；全局日志大量 Bot 时的可见名称查找仍是下一独立候选。

### v0.13.1 — 全局日志 Bot 选项完整加载

- 基线、桌面/手机生产预览、聚焦检查、独立审查与环境限制见 [全局日志 Bot 筛选验收](UI_LOG_BOT_OPTIONS_AUDIT.md)。
- main/tag/Release 目标 `72909dab037332d7ec5514c879afba78b340d5a2`；CI `35844684682` completed/success，精确 SHA 匹配，含完整浏览器与公开文档浏览器门禁。Release 已核实公开、非预发布，正文精确匹配 `docs/releases/v0.13.1.md`。
- 发布后记录提交 `c3a94c2fd573653994b4c7ec58c31441b88584d2` 已推送 main，CI 35845393860 completed/success，精确 SHA 匹配；该记录提交不改变 v0.13.1 tag/Release 目标。
- 完整隔离验收器因 Docker daemon 不可用且固定 3100 端口属于其他项目未运行；聚焦生产预览与浏览器回归通过。没有读取真实 Bot/日志或执行生产部署。

### v0.13.0 — Bot 名称查找

- 基线、聚焦测试、桌面/手机截图及验收限制见 [Bot 名称查找验收](UI_BOT_SEARCH_AUDIT.md)。
- main/tag/Release 目标 `ed552c5925c722d2f3be023739d74602c8a33f82`；CI `35841752963` completed/success，含完整浏览器与文档浏览器门禁。Release 已核实公开、非预发布，正文精确匹配 `docs/releases/v0.13.0.md`。
- 发布后记录提交 `3105b94dd07438572815f65a08f11954c12f8792` 已推送 main，CI 35842743625 completed/success，精确 SHA 匹配；该记录提交不改变 v0.13.0 tag/Release 目标。
- 本地完整隔离验收器未运行，原因是 Docker daemon 不可用且其固定 3100 端口属于其他项目；聚焦生产预览和浏览器回归通过。未执行生产部署或读取真实 Bot 数据。

### v0.12.1 — 模型用量明细可读性

- 基线、验收条件、桌面/手机截图、聚焦检查与环境限制见 [模型明细验收](UI_USAGE_MODEL_AUDIT.md)。
- main/tag/Release 目标 `3341a82256cc4919b64a442aa653e8f7db751dde`；CI `35837676270` completed/success，含浏览器与公开文档浏览器门禁。Release 已核实公开、非预发布，正文来自 `docs/releases/v0.12.1.md`。
- 本地完整隔离验收器未运行，原因是 Docker daemon 不可用且其固定 3100 端口属于其他项目；聚焦生产预览和浏览器回归通过。未执行生产部署或读取真实用量。

### v0.4.0 — 更清晰的工作区导航

- 基线：v0.3.0 / `05bb9329dffc3459da57084ff9ee1062c6fd8ace`。
- 范围：Bot 菜单按任务分组；侧栏即时搜索和范围标识；全局管理直达；顶部返回 Bot 列表；紧凑页脚、桌面折叠和手机焦点行为。
- 保留远端并行更新：`4aea68e` 生成素材库教程 #85。最初直接 push 因 main 前进被非快进拒绝，未强推；改走 PR #86，整合后文档构建与测试重跑。
- 审查：独立 Sol + 主代理复核；修复概览双高亮、折叠按钮布局/标签、手机自动弹键盘、返回入口、同页关闭/导航回焦及中间类型错误。终态没有剩余 P1/P2 finding。
- 本地验证：导航浏览器回归 7/7；Panel typecheck、相关 lint/format、i18n 2273 keys；重建旧 shared 产物后 panel 生产构建通过；文档 typecheck/build；整合后文档浏览器 12/12 通过。
- 浏览器证据：桌面 1440×900、手机 390×844，完整应用 + API 夹具的搜索/清空/范围跳转/唯一当前项/折叠搜索/Escape/关闭回焦通过；无页面错误或横向溢出。截图与脚本在 `.acceptance/ui-efficiency/navigation-final/`，文档在 `.acceptance/ui-efficiency/docs-integrated/`。
- PR CI 35628346088：completed/success，head `fe2edb3337088edaad10c559a0aacdde9743618f`，完整仓库门禁通过。合并后文件树与该提交完全一致。
- 合入后 CI 35629273743：completed/success，精确 head 为下述 main/tag SHA。
- 合入：PR #86 已核实 MERGED，main `5c839e567880e4213b29e948a1eb8e329f5e7447`。
- 发布：v0.4.0 已公开，非 draft/预发布；远端 tag 与发布目标均核实为上述 main SHA。正文来自 `docs/releases/v0.4.0.md`。
- 文档：新增公开导航指南、快速开始与 README 入口、版本导航和 v0.4.0 页面；保留旧版本访问。合入后已复核提交文件树与文档同步。
- 部署：未部署生产；不能据 GitHub 发布或模拟浏览器结果声称线上面板/Telegram 已更新。

### v0.5.0 — 更快找到 AI 设置

- 基线：v0.4.0 与后续目标记录 `5ec4ab8007c44979eca41f887a14a3c8b0f25a35`。
- 范围：21 个折叠设置的跨分类搜索、稳定设置 ID / URL 深链、加载后定位与键盘焦点、手机摘要；不改变保存、权限或 API。
- 审查：独立 Sol 与主代理复核。修复延迟加载定位、键盘焦点、IME Enter 误选、重复清空图标和吸顶区域遮挡；终态无剩余 P1/P2。
- 本地验证：AI 页面浏览器 9/9；Panel typecheck/build、相关 lint/format、i18n 2277 keys；文档 typecheck/build、桌面/手机浏览器 12/12。
- 完整应用 API 夹具：1440×900、900×768、390×844 验证深链、新标签页恢复、慢加载、前进后退、焦点、同页草稿保留和目标不被遮挡；无页面错误/横向溢出。证据 `.acceptance/ui-efficiency/ai-final-verified/` 和 `docs-v0.5.0/`。
- PR #88 已核实 MERGED。PR CI 35630934214 completed/success，head `68b2ef62e5afd75b8c48f941b473e4e8feba9a7f`；合入文件树完全相同。
- main/tag/Release 目标均已核实为 `202799c5286dbccd4651f5345e9d0604840f74b1`。v0.5.0 已公开，非 draft/预发布；正文来自 `docs/releases/v0.5.0.md`。
- 合入后 CI 35632627064 completed/success，精确 head 为上述 main/tag SHA。
- 文档：AI 对话与模型指南、版本导航和 v0.5.0 页面已同步；合入后通过文件树一致性复核。未部署生产。

### v0.5.1 — 日志筛选与清理反馈

- 基线：v0.5.0 `202799c5286dbccd4651f5345e9d0604840f74b1`。
- 范围：DataProvider 转发群聊 ID / 关联 ID；raw/applied 筛选统一，保留负数输入和 IME；响应式筛选布局；准确提示 Bot 清理范围与失败状态。未改服务端权限、数据保留期、SSE 或导出契约。
- 审查：独立 Sol 与主代理复核。两项 P2（空白参数导致 400、DELETE 失败后误清本地状态）已修复并窄复审通过，无剩余重要发现。
- 本地验证：日志页面与 DataProvider 浏览器 9/9；Panel typecheck、相关 lint/format、i18n 2279 keys；文档 typecheck/build、浏览器 12/12。
- 完整应用夹具：全局和单 Bot 页面，1440×900、1280×800、390×844；真实 SSE 解析、历史/实时条件一致、负 ID 中间态、空白参数、取消清理和清理失败保留列表均通过，无非法请求、页面错误或溢出。证据 `.acceptance/ui-efficiency/logs-final/`，文档 `docs-v0.5.1/`。
- PR #89 已核实 MERGED。PR CI 35633203020 completed/success，head `25ec2e36ceb8b67312a58103a2b8f89332497e1b`；合入文件树完全相同。
- main/tag/Release 目标均已核实为 `c17d2ccbbaec643680f0e4dbc49513b0aeb888fd`。v0.5.1 已公开，非 draft/预发布；正文来自 `docs/releases/v0.5.1.md`。
- 合入后 CI 35634304541 completed/success，精确 head 为上述 main/tag SHA。
- 文档：导航指南新增日志检索/清理，故障排查入口和版本页同步；合入后核实文件树一致。未部署生产，也未删除真实日志。

### v0.6.0 — AI 设置保存状态与草稿保护

- 基线：v0.5.1 `c17d2ccbbaec643680f0e4dbc49513b0aeb888fd`。
- 范围：桌面/手机持续保存状态和禁用原因；撤销当前回复选择但保留其他草稿；站内离开和主动退出登录前确认；保留已保存但应用失败的重试恢复。
- 根路由只增加 wildcard data-router 包装，保留原管理路由、Refine 认证和 Mini App 分流。独立限定 Astra 审查与主代理完整应用复验修复了 StrictMode 生命周期、apply 重试、长错误 sticky、退出前确认和真实 HTTP 500 失败恢复。
- 关键证据：Refine 对 resolved `success:false` 仍刷新认证并卸载表单；改为 throw 进入 onError 后，真实 HTTP 500 保留草稿/弹窗且没有额外认证或配置请求。失败有可见提示，Stay 恢复焦点，重试成功才退出；401 仍经原 beforeunload/登录流程处理。
- 本地最终 26 项相关浏览器测试、Panel typecheck/build/Mini App entry、相关 lint/format、i18n 2297 keys 均通过。文档 typecheck/build；12 个桌面/手机场景在修正标题选择器后通过，完整 CI 也已统一通过。
- 生产预览夹具覆盖 1440×900、900×768、390×844，无横向溢出或页面错误。证据 `.acceptance/ui-efficiency/ai-drafts-production/`、`ai-logout-error-production-fixed/`、`ai-expiry-production/`、`ai-long-error-production/`。文档证据 `docs-v0.6.0/` 与 `docs-v0.6.0-guides/`。
- PR #90 已核实 MERGED。PR CI 35637334435 completed/success，head `7c2673de6f5387562b0535c8f5ae49df29a2d99b`；合入文件树完全相同。
- main/tag/Release 目标均已核实为 `4ad9d5bfb03e827468895c1b8fb07172ec2a0089`。v0.6.0 已公开，非 draft/预发布；正文来自 `docs/releases/v0.6.0.md`。
- 合入后 CI 35638264681 completed/success，精确 head 为上述 main/tag SHA。
- AI 操作指南、文档站版本导航和版本页已同步；合入后核实文件树一致。未部署生产，未验证真实 Telegram WebView。

### v0.7.0 — Bot 列表与管理入口

- 基线：v0.6.0 `4ad9d5bfb03e827468895c1b8fb07172ec2a0089`。
- 每页12项、服务端真实总数、创建时间/ID稳定排序，完整浏览超过100个Bot；紧凑卡片、初始错误重试、后台刷新失败保留内容、平台适用概览快捷入口。
- 独立Sol与主代理审查：修复无排序分页和异步切页焦点，终态无剩余P1/P2；offset分页不承诺并发删除时的快照一致性。
- 本地10项相关浏览器回归、SQL排序1项、Panel/Server类型、i18n2311 keys、相关lint/format、Panel构建通过。文档类型/构建与12项浏览器测试通过，最终文案另复验4项。
- 生产预览125 Bot夹具通过1440×900、390×844的跨100边界、总数、键盘/点击翻页、焦点、失败恢复和平台入口，无页面错误/横向溢出；手机常规卡片127px（原约240px）。桌面错误卡片上下32px留白已复验。证据 `.acceptance/ui-efficiency/bot-management-production/`、`bot-management-error-layout/`、`docs-v0.7.0-final/`。
- PR #91 已核实 MERGED。PR CI 35641125157 completed/success，精确 head `8a935c31040719fe68c778148b5c7b6957ea9fe1`；合入文件树一致。
- main/tag/Release 目标为 `b49dcd5994851017cd87f7cd23397d6aec30482e`。v0.7.0 已公开，非 draft/预发布，正文来自 `docs/releases/v0.7.0.md`。
- 合入后 CI `35641965847` 已核实 completed/success，精确 SHA 与发布一致。公开导航指南与版本页已同步，合入后核对文件树。未部署生产，未操作真实Bot或生产数据库。

### v0.8.0 — AI 读取缓存头像（Issue #87）

- 基线：v0.7.0 `b49dcd5994851017cd87f7cd23397d6aec30482e`。按用户顺序完成既有 UI 版本后实施本项，没有另开 UI 切片。
- 新增 `get_profile_avatar`，普通回复/续聊均接入；模型只能给目标 Telegram ID，请求者来自可信 ctx/event。每轮最多3次，读取当前 Bot 已缓存头像，不调用 Telegram 下载或提供公共 URL。
- 使用 Bot 级档案可见性：请求者 off 拒绝，目标 off 拒绝，他人 isolated 拒绝，本人 isolated 可读；没有增加当前 Chat 成员查询或私聊仅本人限制。双方隐私锁复用已有重入/逆序保护。
- 读取时授权的图像快照只保留在本轮，后续请求重新检查；角色与绑定编辑权限不变。缓存是 last-known-good，缺失/损坏/不安全路径明确返回状态，不能声称实时头像。
- 图片通过 prepareStep 中的 user image part 进入 OpenAI兼容/Google模型适配器；工具结果、持久历史只含元数据。修复Google provider失败错误对象裸base64落日志的问题，保留MIME/长度和其他有用诊断。
- 缓存读取限制同Bot目录和头像所有者，拒绝目录/文件symlink越界、绝对/穿越路径、非普通文件；O_NONBLOCK/O_NOFOLLOW、最多5MiB、支持格式与像素上限。保留原头像清理对合法绝对路径的兼容。
- 审查：Sol实现与入口测试，主代理整合/复核，独立Astra对隐私/并发/数据泄漏限定审查；Google错误日志P2修复后独立失败probe复验关闭，无剩余重要发现。
- 本地终态11文件110项回归通过，含真实模型适配器模拟HTTP图片请求和Google HTTP400诊断序列化、缓存/隐私/观察器/生命周期、普通回复/续聊持久化。Shared/Bot/Server类型，相关lint/format，Bot/Server生产构建通过。
- 文档类型/构建与14项桌面/手机浏览器场景通过：匿名访问、深链、搜索、版本导航、头像与隐私指南。证据 `.acceptance/ui-efficiency/docs-v0.8.0/`；新图像测试仅使用合成夹具，没有真实头像或外部模型请求。
- PR #92 已核实 MERGED，Issue #87 已核实 CLOSED。PR CI 35644021599 completed/success，精确 head `f67d6731b08a66a605a676bd46758bea542e674f`；合入文件树一致。
- main/tag/Release目标为 `e5b079e29e2b7854b3bc2a68a970c82e26ce8ccd`。v0.8.0 已公开，非draft/预发布；正文来自 `docs/releases/v0.8.0.md`。
- 合入后 CI `35644859749` 已核实 completed/success，精确 SHA 与发布一致。AI对话、隐私、生成素材库指南与版本站同步；合入后已复核文件树。未执行生产部署。

### v0.9.0 — 用量概览与统计范围

- 基线 main `5fca6df071a4bd8e354dfc9193295c4e2d2e7098`，版本差异从 v0.8.0 `e5b079e29e2b7854b3bc2a68a970c82e26ce8ccd` 起；其间仅有v0.8交付记录提交。
- 核心指标与用量趋势前置，模型/Bot明细随后，缓存诊断和365天活跃度在后；明确所选时间/Bot及全局比较、年度图的例外范围。
- Bot选项完整分页与原子提交，total变化失败重试；全局比较独立请求和错误；长名称在选择框截断、范围说明换行。offset API不承诺同总数并发删增的快照。
- 热力图固定前52周+当前周，修复周日到周五不显示本周/今天的问题，保留本地日期与数据前缀分组契约。
- 主代理与独立Sol审查关闭全局卡渲染耦合、total漂移漏项、长名遮挡，无剩余P1/P2。模型图长ID截断为基线候选，另记审计文档，未扩展本轮图表重绘。
- 本地用量22项+热力图6项浏览器回归，Panel类型/生产构建，相关lint/format，i18n2318 keys通过；文档类型/构建和14项浏览器检查通过，最终文案补验4项。
- 生产预览每档49个模拟GET，1440×900、390×844覆盖125 Bot/键盘末项/四种错误恢复/empty；趋势标题由y1093/y1365提前至y295/y473。长名280字符另复验，无溢出/遮挡或页面错误。证据 `usage-production-final/`、`usage-long-name-final/` 与 `docs-v0.9.0-copy-final/`（均在 `.acceptance/ui-efficiency/`）。
- PR #93 已核实MERGED；PR CI 35649611905 completed/success，精确head `b013baba69655faa19ee74a2c8febf5fb7468986`。合入文件树与已验证head完全一致。
- v0.9.0 已公开、非draft/预发布；main/tag/Release目标核实为 `e744e658b6237a231084812226b0131f3262077d`，正文来自 `docs/releases/v0.9.0.md`。
- 合入后CI `35650499592` 已核实 completed/success，精确SHA与发布目标一致。公共管理面板指南、版本导航和v0.9正文同步，合入后已核实文件树一致。没有生产部署、真实数据访问、模型调用或Telegram发送。

### v0.9.1 — 档案与记忆管理错误恢复

- 基线 main `ce8a93c77925751d8b4939b6e26a72f366e9961f`。面板列表/CRUD校验HTTP与业务结果，失败保留草稿和已知记录；单独提示写入成功与后续刷新失败，隐藏过时空结果的0条/空文案。
- 当前Bot/查询隔离与旧请求保护，提交及失败确认刷新期间锁定相关操作。档案角色绑定在卸载时清活跃引用，阻止旧Bot写入完成后继续发读取请求。
- 独立Sol与主代理审查关闭3个P2：人物确认刷新中重复写、旧Bot绑定跟随请求、记忆确认刷新被查询切换绕过。空结果矛盾文案由截图复核发现并修复；终态无剩余重要发现。
- 本地人物24项+记忆11项浏览器回归，Panel类型/生产构建、相关lint/format、i18n2329 keys通过；文档类型/构建和14项桌面手机检查通过。
- 生产预览1440×900、390×844各36次模拟请求，覆盖完整CRUD错误/恢复/保稿、成功后刷新失败与空状态，无页面错误或横向溢出。证据 `.acceptance/ui-efficiency/record-management-final/`，文档 `docs-v0.9.1/`。没有真实数据库读写、模型调用或Telegram发送，5192预览已关闭。
- PR #94 已核实MERGED；PR CI 35654979772 completed/success，head `31ce57ec8e32bbf6d22c795796de8ebe79b58f7e`。合入文件树完全一致。
- v0.9.1 已公开、非draft/预发布；main/tag/Release目标核实为 `fb5f65469f86dff72005085c4b5d745e7b796949`，正文核实与 `docs/releases/v0.9.1.md` 一致。
- 合入后CI `35655824699` 已核实 completed/success，精确SHA为发布目标 `fb5f65469f86dff72005085c4b5d745e7b796949`。公共隐私/记忆指南、导航入口与版本站同步，合入后已核实文件树；没有生产部署。

### v0.10.0 — 人物检索与记忆筛选

- 基线main `60d90dc08437eb2554d81f88a81f2df86f6dc666`；管理人物搜索真实分页/总数，AI搜索仍10条；人物直达用户记忆，紧凑组合筛选、URL、无效ID明确报错。
- 原范围写入确认、可见编辑草稿、latest history保护和普通read重试分别处理；Sol独立审查与真实浏览器发现已修复，具体触发与证据见 [管理流程验收](UI_RECORD_MANAGEMENT_AUDIT.md)。
- 本地两页50项浏览器回归、后端43项、相关类型/lint/format/i18n2345、Panel构建通过；临时PG真实SQL25条20＋5/隔离/字段/稳定排序通过；桌面手机生产夹具通过，文档类型/构建和14项检查及最终文案4项复验通过。
- PR #95 已核实MERGED；PR CI 35660728032 completed/success，head `9032321d2a63cb43907036599d60f5ef58fb26fa`。合入文件树与该head完全一致。
- v0.10.0 已公开、非draft/预发布；main/tag/Release目标 `2aa07ebe503d90813183c3bc4ac873a6af54bb65`，远端tag及正文与 `docs/releases/v0.10.0.md` 一致。
- 合入后CI `35661423268` 已核实 completed/success，精确SHA为发布目标 `2aa07ebe503d90813183c3bc4ac873a6af54bb65`；公共指南、版本导航与发布正文来源一致，合入后已核实文件树。证据 `record-search-final/`、`profile-search-database-final.json` 和 `docs-v0.10.0/` 均在 `.acceptance/ui-efficiency/`。5192预览及55491临时PG已关闭，没有生产部署。

### v0.10.1 — 对话加载与删除恢复

- 基线main `acd7b4a41396820c65e202eefe6d1359172e4274`；三种分页读取错误/重试与陈旧结果标识，跨Bot/chat/page请求隔离，失败页返回第一页。
- 删除未确认和已确认成功后的刷新失败分别提示；同步锁防重复，只读核对当前与原删除范围，活动摘要冲突恢复，最后页缩页。服务端接口与授权未变。
- 独立Sol与主代理代码/文档复审关闭原目标核对及新页错误退路问题，无剩余P1/P2。21项聚焦Chromium回归通过；相关类型/lint/format、i18n2359、Panel生产构建通过。
- 1440×900/390×844各24次模拟API完整流程无页面错误或横向溢出；文档类型/构建、14项浏览器检查和终稿4项复验通过。证据 `conversation-recovery-final/`、`docs-v0.10.1/` 和 `conversations-browser-final.log` 均在 `.acceptance/ui-efficiency/`。
- PR #96 已核实MERGED；PR CI 35665294298 completed/success，head `f0deda61c548ce2ada06627ec9f1ba6209cbe69f`；合入树完全一致。
- v0.10.1 已公开、非draft/预发布；main/tag/Release目标 `ee64f956614ef61d8cf00d984511e601e0958225`，远端tag与共享Markdown正文均核对。
- 合入后CI `35665935568` 已核实 completed/success，精确SHA `ee64f956614ef61d8cf00d984511e601e0958225` 与发布目标一致。公共指南和版本站源码/构建同步；未部署生产，未操作真实会话，5192预览已关闭。

### v0.11.0 — 按 Chat ID 或参与者查找会话

- 基线main `c78fa2b3a2fe7421b63d4523f5744a7ecfcebb57`；按完整Chat ID/历史参与者名称搜索当前Bot全部会话，完整聚合、字面特殊字符、稳定分页，保留读取错误恢复和原删除范围核对。
- 独立Sol与主代理审查关闭筛选空结果隐藏全Bot清除入口的问题，实际中文手机截图发现的类型标签换行也已修复；没有剩余重要审查发现。
- 本地27项会话浏览器回归、17项路由、45项存储回归及3项实际PG集成通过；主代理另在新临时PG17.11实例独立复跑3项通过。相关类型/lint/format、i18n2367、Panel构建、文档类型/构建及14项文档浏览器检查通过。
- 1440×900、390×844两档各17次模拟GET，中英文主要流程无页面异常或溢出；61条夹具目标从3次Next/4次列表GET减少为1次搜索提交/初次加载加搜索共2次GET。这不是线上性能结论。证据 `conversation-search-final/` 与 `docs-v0.11.0/` 均在 `.acceptance/ui-efficiency/`。
- 首轮CI `35671437170` 因既有App StrictMode用例失败；修复一次性认证延迟夹具的释放，并保留原断言、补充目的地断言。聚焦原版也能通过，故不把修复与原失败的因果当作已证实；主代理终态聚焦1/1通过。后续完整CI通过，详细诊断已留档。
- PR #97 已核实MERGED；最终PR CI 35673958683 completed/success，head `cc3074ac96c656850615976a71771af48dc50e44`；合入文件树完全一致。
- v0.11.0 已公开、非draft/预发布；main/tag/Release目标 `29acc69a6a08b882b08883b7e9c06dfe440f8731`，远端tag和共享Markdown正文已核对。
- 合入后CI `35674641833` 已核实 completed/success，精确SHA为发布目标 `29acc69a6a08b882b08883b7e9c06dfe440f8731`。公共指南与版本站源码/构建同步；5192预览和55491临时PG均已关闭，没有生产部署或真实会话操作。

### v0.11.1 — 生成记录读取与删除恢复

- 基线main `bbe56087e59cf7d2dccd363e4fc2c3f5423d9b7d`；列表/详情读取错误恢复、范围与旧响应隔离、删除结果核对、跨路由进行中请求去重、缩页与键盘焦点恢复。
- 主代理实际浏览器与独立Sol审查关闭重要发现；详情背景Retry遗漏恢复分流也已补齐，终态无剩余P1/P2。服务端权限、任务生命周期和数据库未变。
- 本地13项Chromium回归、相关类型/lint/format、i18n2376 keys和Panel构建通过；中英文分别在1440×900、390×844通过48次合成API请求、7次合成DELETE、12检查点，无未知请求、页面异常或横向溢出。旧响应竞态另以每档7个GET复验。
- 文档类型/构建与16项桌面手机检查通过，最终指南/版本页4项复验通过。证据 `generation-recovery-final/`、`generation-recovery-zh-final/`、`generation-records-race-fixed/`、`docs-v0.11.1-final/` 均在 `.acceptance/ui-efficiency/`。
- PR #98 已核实MERGED；PR CI 35679788689 completed/success，head `466a9698bb5cb9adf7b346a21dc38bd27834c916`。合入文件树与此候选完全一致。
- v0.11.1 已公开，非draft/预发布；main/tag/Release目标 `d69c26541fa157648a8dae49a5e575df2ac2845d`，远端tag和正文与共享Markdown已核对。
- 合入后CI 35680398600 已核实 completed/success，精确SHA为上述发布目标；单一watcher以90秒间隔等待。公共指南、版本导航与源码构建同步，合入后核实一致。5192预览已关闭，没有生产部署或真实生成记录操作。

## 后续工作

持续目标保持 active。v0.14.0 手机侧栏底部占用已完成当前切片；大量 Bot 时的可见名称查找正在进行：

- 用量图长模型 ID 裁切已在当前版本复现并随 v0.12.1 修复交付，见 [模型明细验收](UI_USAGE_MODEL_AUDIT.md)。
- 大量 Bot 中查找已知名称的问题已随 v0.13.0 修复，见 [Bot 名称查找验收](UI_BOT_SEARCH_AUDIT.md)。状态筛选未纳入该轮；如有新的证据再单独评估。
- 全局 `/logs` 原先只显示前 100 个 Bot 的问题已随 v0.13.1 修复，基线与终态证据在 [全局日志 Bot 筛选验收](UI_LOG_BOT_OPTIONS_AUDIT.md)。
- 完整选项修复后，125 Bot 的日志页菜单在手机上仍需较多滚动才能找到 Bot 125。Lody 视觉复核建议下一独立切片加入可见名称查找；保留已选 Bot、分页完整性与错误重试，先用桌面/手机真实浏览器确认操作成本。

生成记录服务端全量读后筛选仍是未测量的源码规模风险，不据此展开性能改造。保持会话角色开关当前页语义和已说明的offset分页限制，不扩成未经证实的新任务。
