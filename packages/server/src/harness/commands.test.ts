import { readFileSync } from "node:fs";
import type { HarnessCommandName } from "@cos-tool-bot/bot";
import { describe, expect, it } from "vitest";
import { extractJson, parseMachineList } from "./lody.js";
import {
  FakeGitHub,
  TEST_CHAT_ID,
  TEST_OWNER,
  createTestService,
  testConfigRaw,
} from "./test-fakes.js";

type Context = Awaited<ReturnType<typeof createTestService>>;

function run(ctx: Context, command: HarnessCommandName, args = "", threadId?: number) {
  return ctx.port.handleCommand({
    command,
    args,
    chatId: TEST_CHAT_ID,
    threadId,
    userId: TEST_OWNER,
    messageId: 1,
  });
}

const machinesFixture = readFileSync(
  new URL("./__fixtures__/lody-machine-list.txt", import.meta.url),
  "utf8",
);

describe("/status", () => {
  it("summarizes the harness in General and degrades without Lody", async () => {
    const ctx = await createTestService();
    const reply = await run(ctx, "status");
    expect(reply.html).toContain("<b>Dev Harness</b>");
    expect(reply.html).toContain("执行层未配置（未找到 lody CLI（lody））");
    expect(reply.html).toContain("Webhook 密钥：已设置");
    expect(reply.html).toContain("Bot：example-dev（<code>bot-1</code>）");
    expect(reply.html).toContain('<a href="https://t.me/c/1234567890/501">sandbox</a>');
  });

  it("links to the project manager when a panel URL is configured", async () => {
    const ctx = await createTestService({ panelUrl: "https://bot.example.test/" });
    for (const reply of [await run(ctx, "status"), await run(ctx, "harness")]) {
      expect(reply.keyboard).toEqual([
        [{ text: "⚙️ 管理项目", url: "https://bot.example.test/harness" }],
      ]);
    }
    expect((await run(ctx, "harness", "config")).keyboard).toBeUndefined();
    expect((await run(await createTestService(), "status")).keyboard).toBeUndefined();
  });

  it("opens the Bot's main Mini App when it has one", async () => {
    const ctx = await createTestService({ panelUrl: "https://bot.example.test/" });
    ctx.service.claimBot({ id: "bot-1", name: "example-dev", miniApp: true });
    const reply = await ctx.port.handleCommand({
      command: "status",
      args: "",
      chatId: TEST_CHAT_ID,
      userId: TEST_OWNER,
      messageId: 1,
      botUsername: "example_dev_bot",
    });
    expect(reply.keyboard?.[0]?.[0]?.url).toBe("https://t.me/example_dev_bot?startapp=harness");
  });

  it("describes the project bound to the topic", async () => {
    const github = new FakeGitHub();
    github.policyText = "version: 1\nkind: electron\n";
    const now = new Date("2026-09-24T12:00:00Z");
    const ctx = await createTestService({
      github,
      raw: testConfigRaw({ machines: { mbp: { lody: "MBP-64G" } } }),
      lody: {
        listMachines: async () => ({
          ok: true,
          value: parseMachineList(extractJson(machinesFixture), now),
        }),
      },
    });
    const reply = await run(ctx, "status", "", 501);
    expect(reply.html).toContain("默认分支：main · 类型：electron");
    expect(reply.html).toContain(`策略：.cos/harness.yml @${"b".repeat(7)}`);
    expect(reply.html).toContain("执行机：MBP-64G.local 🟢 在线");
    expect(reply.html).toContain("排队：0 · 进行中：0 · 待合并 PR：0");

    const quota = await run(ctx, "quota", "", 501);
    expect(quota.html).toContain("claude · Team");
    expect(quota.html).not.toContain("Desktop-5090");
  });
});

describe("access", () => {
  it("re-checks the owner and chat on the server side", async () => {
    const ctx = await createTestService();
    const base = { command: "status" as const, args: "", messageId: 1 };
    expect((await ctx.port.handleCommand({ ...base, chatId: TEST_CHAT_ID, userId: 7 })).html).toBe(
      "无权限",
    );
    expect((await ctx.port.handleCommand({ ...base, chatId: -1, userId: TEST_OWNER })).html).toBe(
      "无权限",
    );
  });
});

describe("/harness", () => {
  it("shows the effective value and its source layer", async () => {
    const github = new FakeGitHub();
    github.policyText = "kind: electron\n";
    const ctx = await createTestService({ github });
    const reply = await run(ctx, "harness", "config guardrails.time.idleRemindAfter", 501);
    expect(reply.html).toContain("来源：按 kind 推断");
    expect(reply.html).toContain("<pre>90m</pre>");
  });

  it("refuses to override security fields", async () => {
    const ctx = await createTestService();
    for (const path of [
      "telegram.owners [1]",
      "approvals.ttl 1h",
      "guardrails.autonomy.autoMergeTiers [T0]",
      "executors.lody.cli /bin/sh",
    ]) {
      const reply = await run(ctx, "harness", `set ${path}`);
      expect(reply.html).toContain("只能通过 harness.yaml 修改");
    }
    expect(ctx.store.overrides).toHaveLength(0);
  });

  it("validates values before writing", async () => {
    const ctx = await createTestService();
    const reply = await run(ctx, "harness", "set guardrails.autoFixRounds lots");
    expect(reply.html).toContain("覆盖未写入：校验失败");
    expect(reply.html).toContain("覆盖层 guardrails.autoFixRounds");
    expect(ctx.store.overrides).toHaveLength(0);
  });

  it("writes a project override with a TTL that restores the YAML value", async () => {
    let now = new Date("2026-09-24T12:00:00Z");
    const ctx = await createTestService({ now: () => now });
    const set = await run(ctx, "harness", "set guardrails.time.idleRemindAfter 10m --ttl 1h", 501);
    expect(set.html).toContain("已写入项目 sandbox覆盖");
    expect(ctx.store.overrides[0]).toMatchObject({ scope: "sandbox", value: "10m" });
    expect(ctx.store.events.at(-1)).toMatchObject({
      type: "config.override_set",
      actorId: TEST_OWNER,
    });

    const shown = await run(ctx, "harness", "config guardrails.time.idleRemindAfter", 501);
    expect(shown.html).toContain("来源：覆盖层（项目）");
    const diff = await run(ctx, "harness", "diff", 501);
    expect(diff.html).toContain(
      "guardrails.time.idleRemindAfter</code>：&quot;45m&quot; → <b>&quot;10m&quot;</b> · 09-24 21:00 到期",
    );

    now = new Date("2026-09-24T13:00:01Z");
    const restored = await run(ctx, "harness", "config guardrails.time.idleRemindAfter", 501);
    expect(restored.html).toContain("<pre>45m</pre>");
    expect((await run(ctx, "harness", "diff", 501)).html).toContain("没有生效的覆盖");
  });

  it("unsets overrides and exports the effective config", async () => {
    const ctx = await createTestService();
    await run(ctx, "harness", "set guardrails.autoFixRounds 4");
    expect((await run(ctx, "harness", "unset guardrails.autoFixRounds")).html).toContain(
      "已删除全局覆盖",
    );
    expect(ctx.store.overrides).toHaveLength(0);
    const exported = await run(ctx, "harness", "export");
    expect(exported.document?.filename).toBe("harness.effective.yaml");
    expect(exported.document?.content).toContain("autoFixRounds: 2");
  });

  it("keeps the previous config when reload fails and reports field paths", async () => {
    const ctx = await createTestService();
    ctx.setRaw(testConfigRaw({ guardrails: { concurrency: { perMachine: 0 } } }));
    const failed = await run(ctx, "harness", "reload");
    expect(failed.html).toContain("reload 失败，继续使用上一次配置");
    expect(failed.html).toContain("guardrails.concurrency.perMachine");
    expect(ctx.service.active).toBe(true);
    expect((await run(ctx, "status")).html).toContain("reload 失败，仍使用上一次配置");

    ctx.setRaw(testConfigRaw({ guardrails: { concurrency: { perMachine: 2 } } }));
    expect((await run(ctx, "harness", "reload")).html).toContain("已重新加载");
    expect(ctx.service.globalView().config.guardrails.concurrency.perMachine).toBe(2);
  });
});
