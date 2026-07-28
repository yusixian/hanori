# 自动模型路由与回答决策研究报告

> 研究日期：2026-07-24
> 来源：vLLM Semantic Router、RouteLLM、LiteLLM、Portkey、OpenRouter / Not Diamond、LobeHub
> 关联 Epic：GitHub Issue #28

## 项目概述

本报告调研同时覆盖以下能力的现有实现：

1. 根据任务复杂度、领域和所需能力选择模型；
2. 在群聊中决定回答、拒绝或沉默；
3. 在模型或服务商失败时安全降级；
4. 按用户、角色和预算调整路由策略；
5. 记录路由原因、成本与故障恢复收益。

结论是：目前没有一个现成项目完整覆盖这五项。最接近目标架构的是 **vLLM Semantic Router**；执行期的重试、熔断、预算和服务商降级则以 **LiteLLM / Portkey** 最成熟；“是否出场”可以参考 **LobeHub Agent Group Supervisor**。对 cos-tool-bot 最合适的方式不是整体引入其中一个网关，而是借鉴它们的边界，在现有 TypeScript 运行时内增加一个可审计的决策层。

## 核心概念

### 1. vLLM Semantic Router：最接近目标的控制平面

vLLM Semantic Router v0.3 使用五层模型：

```text
Signal → Projection → Decision → Algorithm → Model
```

- `Signal` 从身份、上下文长度、任务领域、复杂度、对话形态、工具循环、安全风险和用户反馈中提取事实；
- `Projection` 把多个原始信号归并成 `fast / balanced / escalated` 等稳定策略档位；
- `Decision` 用可解释的规则选择路由策略；
- `Algorithm` 在候选模型中按质量、延迟、会话连续性等因素选择；
- `Model` 执行请求。

它还提供：

- `authz` 信号，用于管理员、普通用户和付费用户的差异化策略；
- `context / complexity / domain / modality / conversation` 等信号；
- Tool loop 和 provider continuation 期间的模型切换锁；
- Replay、决策轨迹、Dashboard dry-run；
- 策略的 `shadow / activate / revert` 生命周期。

这套分层与本项目所需的“分类模型只输出事实，确定性策略选择具体模型”高度一致。不过它以 Envoy `ext_proc` 和独立控制平面运行，完整接入对当前单体 Bot 来说偏重，更适合作为架构参考。

### 2. RouteLLM：强弱模型二选一的学习型路由

RouteLLM 使用 preference data 训练路由器，预测某条请求使用 strong model 相对 weak model 的收益，再通过阈值控制成本与质量。内置 matrix factorization、similarity-weighted ranking、BERT classifier 和 causal LLM classifier，并提供阈值校准与 benchmark。

适合借鉴的点：

- 将“是否升级到强模型”视为可校准的概率，而不是固定关键词；
- 在真实请求分布上校准阈值；
- 将路由策略与离线评测一起交付。

局限是它主要解决 strong/weak 二选一，不负责多能力标签、服务商健康、预算、工具安全或是否回答。

### 3. LiteLLM / Portkey：成熟的执行期路由和故障降级

LiteLLM Router 支持 weighted、rate-limit-aware、latency-based、least-busy 和 cost-based 路由；deployment 有独立健康状态与 cooldown；fallback 可按一般错误、context-window 错误和 content-policy 错误分组；预算可以按用户、Key 和多个时间窗口控制。

Portkey 的 conditional router 可以嵌套 fallback、load balancer 和 guardrails，各条件分支拥有独立降级链，并提供 retry、circuit breaker、budget 和 observability。

两者都擅长回答“已经决定调用某类模型后，怎样可靠地执行”，但不会自动理解群聊语义并决定是否出场。Portkey 的 conditional routing 主要依据调用方传入的 metadata 和参数，而不是自行完成任务分类。

### 4. OpenRouter Auto Router / Not Diamond：最容易试验的托管路由

OpenRouter 的 `openrouter/auto` 由 Not Diamond 提供路由能力，根据 prompt complexity、task type 和 model capabilities 选模型，并允许限制候选模型、调节 cost-quality tradeoff。它还通过 session stickiness 固定会话中的模型和服务商，避免多轮对话频繁切换及丢失 Prompt Cache。

Not Diamond 也可以只返回推荐模型，应用继续使用自己的 SDK 调用模型，并支持基于自有评测数据训练 custom router。

优点是验证成本低；缺点是消息需要交给第三方路由服务、选择逻辑不完全透明，而且它们不处理 Telegram 的回答/沉默语义。OpenRouter 模式还会把现有的自有服务商配置收敛到一个外部网关。

### 5. LobeHub Agent Group Supervisor：明确的“沉默”契约

LobeHub 的 Agent Group RFC 使用单独的 orchestrator model 决定哪些 Agent 下一步发言；Supervisor 返回 Agent ID 数组，返回空数组 `[]` 即停止对话。这是目前找到的与“分类模型选择回答或沉默”最接近的实际产品设计。

值得借鉴的是：

- 决策模型和回答模型分离；
- 输出严格的结构化结果；
- 沉默是显式决策，而不是模型生成空字符串；
- 可单独配置 orchestrator provider / model。

它没有覆盖服务商故障、预算和能力路由，且 LobeHub 当前使用 Community License，因此更适合作为交互契约参考，而不是直接复制实现。

## 技术细节

### 建议的本地决策契约

分类器不直接返回具体模型 ID，而是返回稳定语义：

```ts
interface RouteDecision {
  engagement: "answer" | "silent" | "decline";
  task: "chat" | "code" | "summary" | "tool";
  requiredCapabilities: ModelCapability[];
  qualityTier: "economy" | "balanced" | "premium";
  confidence: number;
  reasons: string[];
}
```

确定性 Policy Resolver 再结合以下约束产生执行计划：

1. 身份、群白名单和安全硬规则；
2. 用户手动锁定的 provider / model；
3. Tool loop、流式输出和多轮会话连续性锁；
4. 分类器输出的任务、能力与质量档位；
5. 当前预算、价格和服务商健康状态；
6. 与主线路能力等价的 fallback candidates。

### 回答与沉默

可借鉴 LobeHub 的空结果设计，但应把三种结果分开：

- `answer`：正常生成；
- `silent`：消息没有在邀请 Bot 参与，不产生用户可见输出；
- `decline`：权限、安全或能力边界要求明确说明，不能伪装成沉默。

明确 mention、回复 Bot 和管理员私聊可以作为硬规则保证回答；群聊普通消息才交给 engagement classifier。这样可以减少最危险的 false negative。

### 故障降级

借鉴 LiteLLM / Portkey，将降级限定在可识别的执行错误：

- 适合 fallback：429、超时、5xx、模型不可用、上下文窗口不足；
- 不应自动换模型重跑：鉴权失败、无效请求、安全拒绝；
- Tool 调用发生副作用后不得盲目重跑；
- 流式输出开始后不做透明重放；
- Tool loop 中优先锁定原模型，保证 tool result 返回给发起调用的模型。

### Shadow 与评估

第一阶段只记录分类结果，不改变实际回答与模型选择。建议记录：

- 触发信号、分类结果、置信度和理由；
- 建议模型与实际模型；
- 假定基准模型及估算成本差；
- fallback attempts 和最终恢复结果；
- 管理员对误路由、误沉默的反馈。

Shadow 数据足够后再逐项启用：

1. 自动选择 economy / balanced / premium；
2. provider fallback；
3. 普通群消息的智能沉默；
4. 预算降级。

## 关键发现

| 实现                     | 最强部分                            | 与本项目的缺口         | 建议用途                   |
| ------------------------ | ----------------------------------- | ---------------------- | -------------------------- |
| vLLM Semantic Router     | 信号、策略、会话锁、Replay、Shadow  | 独立基础设施较重       | 主要架构蓝本               |
| RouteLLM                 | 强弱模型质量/成本校准               | 只解决模型二选一       | 经济模型升级算法与评测     |
| LiteLLM                  | 多服务商、Cooldown、Fallback、预算  | 不理解 Bot 是否该回答  | 故障状态机参考             |
| Portkey                  | 可组合条件路由、Fallback、Guardrail | 更偏外部网关和规则执行 | 配置表达与可观测性参考     |
| OpenRouter / Not Diamond | 低成本托管语义路由                  | 第三方依赖、无沉默语义 | 快速实验和对照基线         |
| LobeHub Supervisor       | 独立 Orchestrator，可返回空集合     | 不处理预算与可靠性     | `answer / silent` 契约参考 |

没有必要把上述项目整体引入 cos-tool-bot。项目已经拥有 provider registry、per-chat model/provider override、模型能力标签和 token usage；引入完整 Gateway 会重复已有能力，并把 Telegram 特有决策拆到另一个服务。

## vLLM Semantic Router 深入映射

vLLM 的边界值得借鉴，但不应照搬全部抽象。对当前项目可以压缩为：

| vLLM 层           | cos-tool-bot 已有基础                                                         | 建议的首版形态                                              |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Heuristic Signals | 私聊/群聊、管理员、白名单、mention/reply/keyword/random、媒体类型、隐私模式   | 直接复用为硬信号                                            |
| Learned Signals   | 暂无统一分类器                                                                | 一个无工具、结构化输出的低成本分类调用                      |
| Projections       | 暂无                                                                          | 不做通用加权 DSL，只形成少量稳定档位                        |
| Decisions         | 默认模型、专用 Coding/Summary 模型、手动覆盖                                  | 命名策略：`economy / balanced / premium / silent / decline` |
| Algorithms        | 当前直接选择一个模型                                                          | 首版只做静态候选顺序，不做 AutoMix、Fusion 或在线学习       |
| Protection        | per-chat provider/model override；单次 `streamText` 内 Tool loop 使用同一模型 | 手动锁定优先；Tool/流式开始后禁止透明切换                   |
| Replay            | Debug log 与 token usage                                                      | 新建 route decision/attempt 审计记录                        |

### 为什么首版不应训练本地分类器

vLLM 将 heuristic 与 learned signals 分开，并使用专用 ModernBERT 分类模型降低延迟与随机性。这适用于具有训练数据和稳定流量的大规模网关。cos-tool-bot 当前没有“正确路由”和“正确沉默”的标注数据，直接训练分类器只会把未经验证的规则固化。

更合适的演进路径是：

1. 先使用硬规则和一个便宜的结构化 LLM 分类调用；
2. 通过 Shadow Mode 收集决策、人工反馈及实际结果；
3. 数据量足够后，再把稳定信号替换为 embedding、本地小分类器或学习型路由；
4. 保持 `SignalExtractor` 接口不变，使分类实现可替换。

### 两个决策不是一回事

需要显式区分：

1. **Engagement Decision**：Bot 是否应该加入这段对话；
2. **Execution Route**：如果回答，应该使用什么能力档位、模型和服务商。

二者可以共享一次分类输出，但硬规则不同：

- 明确 mention、回复 Bot、允许的私聊可以强制 `answer`，只读取任务路由部分；
- 普通群消息才允许分类器输出 `silent`；
- 权限或安全问题输出 `decline`，不能用 `silent` 隐藏；
- 分类器失败时，Engagement 回到现有 trigger 行为，Execution 回到当前 provider/model。

### 对当前请求链路的插入点

当前群消息先进入 RingBuffer，再由 `checkTrigger` 判断；未触发的公开群消息仍可写入会话历史。模型和服务商则在创建 Agent、GitHub、Vision 等工具前解析。

因此不能只在最终 `streamText` 前更换模型，而应拆成两个插入点：

```text
消息准入与权限
  → 写入群上下文
  → Engagement Gate
  → 提取轻量请求信号
  → Route Resolver
  → 创建与所选模型匹配的工具、图像和 Prompt
  → 执行及有限 Fallback
```

- Engagement Gate 应位于现有 trigger 检查附近，否则无法决定普通群消息是否主动加入；
- Route Resolver 必须位于当前 provider/model 解析之前，否则 Coding、Vision 和 Agent tools 已经绑定到旧模型；
- 分类输入不应装配完整系统 Prompt 和全量工具，只使用消息、有限群上下文、身份、媒体、历史规模、手动覆盖和预算状态；
- 群聊如果对每条消息都调用分类器会增加成本并制造并发竞态。智能参与模式需要 cooldown，必要时再增加短 debounce，把连续消息作为一轮判断。

### 应保留与应砍掉的 vLLM 能力

首个 Issue 应保留：

- detection、decision、selection 三层边界；
- 明确优先级和结构化理由；
- Shadow / active / disabled 模式；
- manual pin、Tool loop、流式输出保护；
- fallback attempt 与最终结果审计；
- 分类器 fail-open 到当前行为。

首个 Issue 应明确不包含：

- 通用 YAML/DSL 策略语言；
- 可配置的任意加权 Projection 图；
- ModernBERT 训练与部署；
- AutoMix、Fusion、多模型并行评审；
- 自动在线学习；
- 外置 Envoy/Gateway；
- 对带副作用 Tool 的自动重放。

## 实践参考

建议后续 Issue 以“可审计的自动决策层”为主题，而不是笼统的“接入自动路由器”：

- 在现有 trigger 与 AI execution 之间加入 `RouteDecisionService`；
- 使用结构化输出或本地轻量分类器产生语义决策；
- 使用现有模型能力标签进行确定性匹配；
- 新增 route decision / attempt 审计数据，而不是只扩充 token usage；
- 首发必须包含 shadow mode 和 fail-open 到当前行为；
- fallback 仅覆盖模型请求，Tool 副作用需独立保护；
- 面板展示“估算费用节省”和“成功恢复请求”，不宣称无法验证的 Token 节省或失败减少。

模型价格的来源、自动同步和历史价格快照另见
[LLM 模型价格自动同步来源研究](../research-llm-pricing-sources/README.md)。

## 个人思考与启发

最值得复制的不是某个项目的代码，而是 vLLM Semantic Router 的边界：

```text
事实提取和判断分离
语义决策和具体模型分离
模型选择和服务商故障转移分离
在线执行和离线评估分离
```

对 Bot 而言还需要再增加一层 `engagement`。这让系统不仅会选择“谁来回答”，还会选择“此刻是否应该出场”。它应当比模型路由更早执行，但晚于权限、白名单和明确 mention 等硬规则。

## 参考链接

- [vLLM Semantic Router 文档](https://vllm-sr.ai/docs/intro/)
- [vLLM Semantic Router v0.3 Themis](https://vllm.ai/blog/2026-06-05-v0.3-vllm-sr-themis-release)
- [vLLM Semantic Router GitHub](https://github.com/vllm-project/semantic-router)
- [RouteLLM GitHub](https://github.com/lm-sys/RouteLLM)
- [LiteLLM Router](https://docs.litellm.ai/docs/routing)
- [LiteLLM Fallbacks](https://docs.litellm.ai/docs/proxy/reliability)
- [LiteLLM Budgets](https://docs.litellm.ai/docs/proxy/users)
- [Portkey Conditional Routing](https://portkey.ai/docs/product/ai-gateway/conditional-routing)
- [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [Not Diamond Routing Quickstart](https://docs.notdiamond.ai/docs/quickstart-routing)
- [LobeHub Agent Group Supervisor RFC](https://github.com/lobehub/lobehub/discussions/8920)
