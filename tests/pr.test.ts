import { describe, expect, it } from "vitest";
import { buildPrBody } from "../lib/github";

describe("buildPrBody", () => {
  it("stacks description, latest summary, and the attribution footer", () => {
    const body = buildPrBody({ description: "Add sparklines.", summary: "Built the chart component.", taskId: "t1" });
    expect(body).toBe(
      "Add sparklines.\n\n## Session summary\n\nBuilt the chart component.\n\n---\n_Opened by Agent Orchestrator (task t1)._"
    );
  });

  it("omits empty or whitespace-only sections", () => {
    const body = buildPrBody({ description: "  ", summary: undefined, taskId: "t2" });
    expect(body).toBe("---\n_Opened by Agent Orchestrator (task t2)._");
    expect(body).not.toContain("## Session summary");
  });

  it("keeps the summary section when only the description is missing", () => {
    const body = buildPrBody({ summary: "Refactored auth.", taskId: "t3" });
    expect(body.startsWith("## Session summary\n\nRefactored auth.")).toBe(true);
  });
});
