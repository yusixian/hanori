import { createHmac } from "node:crypto";

export interface LarkCardElement {
  tag: string;
  [key: string]: unknown;
}

export interface LarkCardConfig {
  wide_screen_mode?: boolean;
}

export interface LarkCardHeader {
  title: { tag: "plain_text"; content: string };
  template?: string;
}

export interface LarkCardMessage {
  header?: LarkCardHeader;
  elements: LarkCardElement[];
  config?: LarkCardConfig;
}

export class LarkWebhookClient {
  constructor(
    private webhookUrl: string,
    private signSecret?: string,
  ) {}

  // Feishu signature: HMAC-SHA256(key = timestamp + "\n" + secret, data = "")
  // See: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot#756b882f
  private generateSign(timestampSec: number): string {
    if (!this.signSecret) return "";
    const stringToSign = `${timestampSec}\n${this.signSecret}`;
    return createHmac("sha256", stringToSign).update("").digest("base64");
  }

  async send(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const body: Record<string, unknown> = { ...payload };

    if (this.signSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      body.timestamp = String(timestamp);
      body.sign = this.generateSign(timestamp);
    }

    let res: Response;
    try {
      res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Lark webhook request failed: ${message}` };
    }

    if (!res.ok) {
      return { ok: false, error: `Lark webhook HTTP ${res.status}: ${res.statusText}` };
    }

    let result: unknown;
    try {
      result = await res.json();
    } catch {
      return { ok: false, error: "Lark webhook returned an invalid JSON response" };
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("code" in result) ||
      typeof result.code !== "number"
    ) {
      return { ok: false, error: "Lark webhook returned an invalid API response" };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        error:
          "msg" in result && typeof result.msg === "string"
            ? result.msg
            : `Lark API error code: ${result.code}`,
      };
    }
    return { ok: true };
  }

  async sendText(text: string): Promise<{ ok: boolean; error?: string }> {
    return this.send({
      msg_type: "text",
      content: { text },
    });
  }

  async sendCard(card: LarkCardMessage): Promise<{ ok: boolean; error?: string }> {
    return this.send({
      msg_type: "interactive",
      card,
    });
  }
}
