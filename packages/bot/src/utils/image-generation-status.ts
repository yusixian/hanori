import type { ImageGenerationView } from "@cos-tool-bot/shared";

/** Reports observations from this turn's executed tools, rather than model step counts. */
export function imageToolCompletion(name: string, output: unknown): string | undefined {
  if (
    name !== "create_image" &&
    name !== "cancel_image_generation" &&
    name !== "retry_image_delivery"
  )
    return undefined;
  const result = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  const generation = result.generation as ImageGenerationView | undefined;
  const id =
    generation?.id && /^[a-zA-Z0-9_-]{1,128}$/.test(generation.id)
      ? `（任务 ${generation.id}）`
      : "";
  if (name === "retry_image_delivery") {
    return result.ok === true
      ? `已安排原图片投递重试，尚未确认交付${id}`
      : generation?.deliveryState === "unknown"
        ? `投递结果未知，禁止重发${id}`
        : `未重试投递，请查询原任务状态${id}`;
  }
  if (name === "cancel_image_generation") {
    if (generation?.state === "cancelled") return `图片任务已确认取消${id}`;
    if (result.ok === false) return `取消未确认；原任务仍需继续查询${id}`;
    if (generation?.state === "waiting_stopped")
      return `已停止本地等待；供应商结果未知，未确认取消${id}`;
    return `已请求取消；尚未确认取消${id}`;
  }
  if (result.accepted !== true || !generation)
    return `图片生成请求未提交成功，请查看工具错误后再处理${id}`;
  if (generation.deliveryState === "delivered" && generation.deliveryMessageIds?.length)
    return `图片已交付${id}`;
  if (generation.deliveryState === "unknown")
    return `图片投递结果未知，请核对回执；不会自动重发${id}`;
  if (generation.deliveryState === "failed") return `图片已生成，投递失败${id}`;
  if (generation.state === "succeeded") return `图片已生成，等待投递${id}`;
  if (generation.state === "awaiting_approval") return `图片请求已提交，待审批${id}`;
  if (generation.state === "queued") return `图片请求已提交，排队中${id}`;
  if (generation.state === "running") return `图片请求已提交，生成中${id}`;
  if (generation.state === "attention_required")
    return `图片生成结果未知，请查询原任务；不要重新提交${id}`;
  if (generation.state === "failed") return `图片生成失败${id}`;
  return `已接收图片请求，尚未确认供应商提交${id}`;
}
