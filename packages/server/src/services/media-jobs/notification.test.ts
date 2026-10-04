import { describe, expect, it } from "vitest";
import { formatMediaJobNotice } from "./notification.js";

const id = "ec48fa47-1a7a-4355-aef4-032b1ad9bfb4";

describe("media job status notices", () => {
  it.each([
    ["completed", "已完成"],
    ["failed", "未完成"],
    ["cancelled", "已取消"],
    ["expired", "已过期"],
  ] as const)("describes %s with a job ID and safe failure code", (status, label) => {
    const notice = formatMediaJobNotice({ id, status, error: "interrupted_transcription" });
    expect(notice).toContain(`<code>${id}</code>`);
    expect(notice).toContain(label);
    if (status === "failed") expect(notice).toContain("interrupted_transcription");
    else expect(notice).not.toContain("interrupted_transcription");
  });

  it("never includes unrecognized provider text or HTML in failure notices", () => {
    const notice = formatMediaJobNotice({
      id,
      status: "failed",
      error: "<b>Private credential https://private.example.com/?key=secret</b>",
    });
    expect(notice).toContain("job_failed");
    expect(notice).not.toContain("Private");
    expect(notice).not.toContain("private.example.com");
  });
});
