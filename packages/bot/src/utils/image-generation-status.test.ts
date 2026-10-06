import { describe, expect, it } from "vitest";
import { imageToolCompletion } from "./image-generation-status.js";

describe("image result wording", () => {
  it.each([
    [{ state: "preparing" }, "尚未确认供应商提交"],
    [{ state: "awaiting_approval" }, "待审批"],
    [{ state: "queued" }, "排队中"],
    [{ state: "running" }, "生成中"],
    [{ state: "succeeded", deliveryState: "pending" }, "等待投递"],
    [{ state: "succeeded", deliveryState: "failed" }, "投递失败"],
    [{ state: "succeeded", deliveryState: "unknown" }, "投递结果未知"],
    [{ state: "attention_required" }, "生成结果未知"],
    [{ state: "succeeded", deliveryState: "delivered", deliveryMessageIds: [123] }, "已交付"],
    [{ state: "succeeded", deliveryState: "delivered", deliveryMessageIds: [] }, "等待投递"],
  ])("reports observed state %j", (generation, expected) => {
    expect(
      imageToolCompletion("create_image", {
        accepted: true,
        generation: { id: "generation-1", ...generation },
      }),
    ).toContain(expected);
  });
  it("reports confirmed cancellation only for the confirmed terminal state", () => {
    expect(
      imageToolCompletion("cancel_image_generation", {
        ok: true,
        generation: { state: "cancel_requested" },
      }),
    ).toContain("尚未确认取消");
    expect(
      imageToolCompletion("cancel_image_generation", {
        ok: true,
        generation: { state: "cancelled" },
      }),
    ).toContain("已确认取消");
    expect(imageToolCompletion("create_image", { accepted: false })).toContain("未提交成功");
  });
});
