# LLM 模型价格自动同步来源研究

> 研究日期：2026-07-24
> 来源：主流服务商官方 API / 文档，以及 models.dev、Portkey Models、LiteLLM 的公开目录
> 关联 Epic：GitHub Issue #28

## 项目概述

目标是判断 cos-tool-bot 能否自动获得模型价格，用于自动路由、每日预算和“预计节省金额”统计。

结论是：**存在可靠的局部来源，但不存在一个同时具备官方身份、统一格式和全服务商覆盖的价格 API。** 价格数据应分成两个问题处理：

1. **调用前估算**：路由和预算需要提前知道单价，只能依赖价格目录或人工配置；
2. **调用后核账**：部分服务商能返回实际费用，或提供组织级 Cost API，但通常延迟、聚合，不能直接替代调用前价格。

因此不应在“全自动同步”和“完全手填”之间二选一。更稳妥的产品形态是：**自动填充 + 明确来源 + 人工覆盖 + 调用时固化价格快照 + 账单对账**。

## 核心概念

### 1. 官方模型目录不等于官方价格目录

- OpenAI `GET /v1/models` 只返回 `id`、`created`、`object`、`owned_by`，不返回价格。官方模型网页展示价格，但不是稳定的机器接口。
- Anthropic `GET /v1/models` 返回模型 ID、能力、上下文等信息，不返回价格；价格在单独的文档页。
- Gemini `models.list/get` 返回模型标识、能力和 Token 限制，也没有价格字段；价格在单独的文档页。

因此，通用 OpenAI-compatible `/models` 端点不能被假定含有价格。cos-tool-bot 当前的模型发现响应也只接受 `id` 和 `owned_by`，即使某个兼容服务商额外返回 `pricing`，现在也会被丢弃。

### 2. 标价、估算费用和实际账单不同

- **List price**：服务商公开单价，可用于路由前估算；
- **Estimated cost**：本地使用本次 Token 和价格快照计算的金额；
- **Reported cost**：网关或服务商直接报告的实际请求费用；
- **Billed cost**：最终账单费用，可能包含折扣、批处理、缓存、区域、服务档位、合同价及其他计费项。

面板必须把 estimated 与 reported/billed 分开，不能把社区目录算出的金额称为“实际支出”。

## 技术细节

### 官方及准官方来源

| 来源                                 | 是否机器可读 | 适用范围                       | 可靠性与限制                                                                                                                            |
| ------------------------------------ | ------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| OpenRouter Models API                | 是           | 通过 OpenRouter 调用的模型     | `/api/v1/models` 返回 USD 单价；请求完成后可用 generation API 查询实际 cost。最适合 OpenRouter 自身，不应拿它推断任意直连或代理价格     |
| AWS Price List API                   | 是           | Bedrock 等 AWS 服务            | 官方 SKU 价格，支持区域和生效时间；但需要把 Bedrock 模型、区域、吞吐模式映射到 SKU，且官方说明目录与 Bedrock 价格页冲突时以后者为准     |
| Azure Retail Prices API              | 是           | Azure OpenAI / Foundry         | 官方、无需认证、支持区域与 SKU；Azure OpenAI FAQ 明确推荐用它程序化查价，但 meter 名称到部署模型的映射复杂，合同折扣不等于 retail price |
| Google Cloud Pricing API             | 是，Preview  | Vertex AI 等 Google Cloud 服务 | 可查公开 SKU 和合同价；需要 API key，部分接口还需 Billing 权限，模型和 SKU 的映射仍需维护                                               |
| OpenAI Organization Costs API        | 是           | OpenAI 组织实际支出            | 官方账单口径，但按日聚合，适合对账，不提供路由前单价和稳定的逐请求归因                                                                  |
| Anthropic Usage & Cost Admin API     | 是           | Anthropic 组织实际支出         | 官方账单口径，通常约 5 分钟后出现，成本 API 为日粒度；需要 Admin API key，不适合作为路由前价格源                                        |
| OpenAI / Anthropic / Gemini 价格网页 | 否           | 对应第一方直连                 | 官方但页面结构不稳定；不建议在 Bot 运行时抓取 HTML                                                                                      |

### OpenRouter 是重要特例

OpenRouter 的模型 API 明确定义了 `pricing.prompt`、`pricing.completion`、缓存、图片、请求和 web search 等字段；价格单位是 USD/Token 或相应计费单位。其模型级价格表示 OpenRouter 路由的价格结构，而不同 endpoint 仍可能需要进一步查询。

更重要的是，请求完成后可以使用 generation ID 查询 Token 和 cost。这使 OpenRouter 可以形成：

```text
调用前：Models API 估算
调用后：Generation API 核对实际费用
```

但这个优势只对实际通过 OpenRouter 计费的请求成立。若用户配置的是自建中转、折扣代理或直连厂商，不能套用 OpenRouter 单价。

OpenRouter 文档允许应用运行时查询模型信息，但没有找到类似 MIT 的开放数据许可，其 Terms 还限制使用服务开发竞争性服务。因此适合做 OpenRouter provider adapter，不建议把完整目录复制并重新发布为通用价格数据库。

### 开源聚合目录

| 目录           | 主要优势                                                                       | 主要风险                                                     | 建议角色                     |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------- |
| LiteLLM        | 2,500+ 模型、100+ provider、复杂计费字段，Model Catalog API 从 GitHub 高频刷新 | 社区维护，已有缺失和错误价格；别名、区域和 tier 容易匹配错误 | 第一版默认自动填充源         |
| models.dev     | MIT、JSON API、TypeScript SDK、provider-specific 模型与能力结构清晰            | 无价格准确性 SLA，复杂计费维度少于 LiteLLM                   | 备选目录或能力元数据来源     |
| Portkey Models | MIT、免费 API、计费维度丰富、PR 要求官方来源链接                               | 社区维护；单位是美分/Token，转换错误风险高                   | 交叉校验或复杂多模态价格参考 |

### models.dev

- MIT 许可，由 OpenCode/SST 维护并用于 OpenCode；
- 提供 `https://models.dev/api.json`、`models.json`、`catalog.json`；
- 按 provider/model 组织，价格单位是 USD/百万 Token；
- 包含 input、output、reasoning、cache read/write、audio，以及上下文和能力信息；
- 模型与具体服务商价格分离，适合“同一模型由不同服务商承载”的场景；
- 提供 TypeScript SDK 与离线快照，和 cos-tool-bot 的 TypeScript/AI SDK 技术栈较契合。

限制：它明确是 community-contributed database，没有价格准确性 SLA；数据适合作为自动填充和路由估算，不能代替账单。

### Portkey Models

- MIT 许可，免费 API、无需认证；
- 官方仓库宣称覆盖 2,000+ 模型、40+ provider，并用于 Portkey Gateway 的成本归因；
- schema 比 models.dev 更完整，覆盖 Token、缓存、音视频、图片、搜索、批处理和 provider-specific additional units；
- 提交价格变更时要求附来源链接。

限制：仍是社区维护数据；其价格单位为“美分/Token”，与常见的 USD/百万 Token 不同，接入时必须严格转换并保留原单位，避免 100 倍或 1,000,000 倍错误。

### LiteLLM model cost map

- 仓库非 enterprise 部分使用 MIT 许可；
- Model Catalog API 宣称覆盖 2,500+ 模型，数据从 GitHub 价格文件高频刷新；
- `model_prices_and_context_window.json` 覆盖 100+ provider 和复杂价格字段；
- LiteLLM 支持 custom pricing 覆盖，说明其自身也将目录视为默认值而非绝对真值。

限制：社区 issue 中可以看到缺失模型、缓存价格遗漏和错误价格的实际案例，部分条目也没有可追溯的官方 source。它适合做第一版默认自动填充源，但所有结果都必须标记为 estimated，不建议无审查地成为硬预算唯一依据。

## 关键发现

### 1. “官方自动同步”只能按 provider 做 adapter

可实现的官方同步不是一个全局开关，而是一组 provider adapter：

```text
OpenRouter → OpenRouter Models / Generation API
AWS Bedrock → AWS Price List API
Azure OpenAI → Azure Retail Prices API
Vertex AI → Google Cloud Pricing API
OpenAI / Anthropic / Gemini direct → 开源目录预填 + 官方账单 API 对账
Custom/OpenAI-compatible proxy → 人工配置或代理自己的价格接口
Local model → 人工标记为免费，或配置摊销成本
```

### 2. 不能只凭 model ID 猜价格

同一个 `claude-*`、`gpt-*` 或 `gemini-*` ID 可能来自：

- 第一方 API；
- OpenRouter；
- Azure、Bedrock、Vertex；
- 有折扣或加价的中转；
- 本地兼容服务器。

cos-tool-bot 当前只有 `providerFormat: "openai" | "gemini"`，它描述协议而不是计费实体。自动同步至少还需要一个明确的 `pricingProvider` / catalog provider ID。baseURL 只能用来建议，不能作为无提示的最终判断。

对于任何自定义 `baseURL`，默认状态都应是 `unpriced`。代理可能加价、打折、包月、按请求收费，甚至把相同 model ID 路由到其他模型；仅凭 OpenAI-compatible `/models` 返回的名字无法推断真实价格。

### 3. 价格必须按调用固化快照

历史用量不能用“今天的价格”重新计算，否则服务商调价后旧账会改变。每次 attempt 至少应记录：

```ts
{
  providerId,
  modelId,
  promptTokens,
  completionTokens,
  estimatedCostUsd,
  reportedCostUsd?,
  pricingSource,
  pricingSourceVersion,
  inputPriceSnapshot,
  outputPriceSnapshot,
  pricedAt
}
```

缓存、reasoning、搜索和其他计费项可以后续扩展，但 schema 应允许新增 price components。

## 实践参考

### 对 cos-tool-bot 的建议

### 推荐的数据优先级

1. **管理员手工覆盖**：最高优先级，适用于代理、合同价和本地模型；
2. **当前 provider 的原生价格 API**：OpenRouter 等明确提供机器价格的服务；
3. **LiteLLM 自动填充**：第一版默认聚合源，要求 provider、model revision、region 和 service tier 精确匹配，结果标记为 estimated；
4. **models.dev / Portkey 交叉校验**：发现缺失或冲突时提示管理员，不静默改价；
5. **未知价格**：保持 unknown，绝不能默认成 0。

### 推荐的同步行为

- 只做 exact match，不用模糊字符串自动绑定价格；
- 自动同步结果显示来源、同步时间、单位和是否过期；
- 远端不可用时使用 last-known-good，不能把价格清空；
- 自动价格变更超过阈值时提示确认；
- 手工值永远不被后台同步覆盖；
- 允许显式配置 `0` 表示免费，与 `undefined` 表示未知区分；
- 每次请求固化当时使用的价格，历史报表不随 catalog 更新漂移；
- 后续使用 OpenAI/Anthropic Cost API 或云账单做聚合对账，而不是反向改写每一条历史请求。

### 建议的第一版范围

第一版不需要实现所有云厂商 SKU adapter。Feature Epic 可以先包含：

1. Model pricing schema、手工编辑和价格快照；
2. LiteLLM catalog exact-match 自动填充，保留 source、版本/hash 和抓取时间；
3. OpenRouter 专用价格与实际 cost adapter；
4. unknown / stale / manual / synced 的面板状态；
5. 预算只统计已知价格，并明确显示未计价调用；
6. 将 AWS、Azure、Google Cloud 官方 Pricing API adapter 留作后续子 Issue。

这样既能让大多数常见模型免手填，又不会假装自建中转和合同价能够被公共目录准确推断。

## 个人思考与启发

价格同步本质上不是“给模型加两个数字”，而是一个小型 FinOps 数据链路。最容易犯的错误是：

- 把协议格式当作计费服务商；
- 把社区 list price 当实际账单；
- 调价后重算历史；
- 把 unknown 当免费；
- 忽略 cache、reasoning、工具和区域价格；
- 用模糊匹配把相似模型绑定到错误单价。

对自动路由而言，价格不必达到财务结算精度，但必须具备可解释性：系统应能回答“这次为什么认为它更便宜、使用了哪一版价格、实际费用是否可核对”。

## 参考链接

- [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list)
- [OpenAI Models and Pricing](https://developers.openai.com/api/docs/models)
- [OpenAI Organization Costs API](https://platform.openai.com/docs/api-reference/usage)
- [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
- [Gemini Models API](https://ai.google.dev/api/models)
- [Gemini Developer API Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Google Cloud Pricing API](https://docs.cloud.google.com/billing/docs/reference/pricing-api/rest)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- [Azure OpenAI pricing lookup FAQ](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/faq#looking-up-pricing-programmatically)
- [AWS Price List API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/Welcome.html)
- [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)
- [OpenRouter Models API](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter model endpoint prices](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints)
- [OpenRouter API cost and generation stats](https://openrouter.ai/docs/api/reference/overview)
- [OpenRouter Terms](https://openrouter.ai/terms)
- [models.dev](https://models.dev/)
- [models.dev GitHub](https://github.com/anomalyco/models.dev)
- [Portkey Models](https://github.com/Portkey-AI/models)
- [LiteLLM Model Catalog API](https://models.litellm.ai/docs)
- [LiteLLM custom pricing and cost map](https://docs.litellm.ai/docs/proxy/custom_pricing)
- [LiteLLM missing pricing example](https://github.com/BerriAI/litellm/issues/22646)
- [LiteLLM Bedrock pricing error example](https://github.com/BerriAI/litellm/issues/15764)
