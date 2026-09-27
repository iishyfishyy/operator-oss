import { expect, test } from "@playwright/test";
import { createProject, ensureOnboarded, getTask, git, gotoApp, makeFixtureRepo, sendMessage, uid } from "./helpers";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
});

// A 3-step auto-advance chain runs itself (mock steps write a file and call
// complete_step), shows up as a "Chains to review" card, and lands on main
// with one "Merge chain" click — every step marked done.
test("auto-advance chain: review card → per-step + combined diffs → merge chain", async ({ page, request }) => {
  const name = `Chain review ${uid()}`;
  const repoPath = makeFixtureRepo(name);
  const project = await createProject(request, { name, repoPath });

  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const res = await request.post("/api/tasks", {
      data: {
        project_id: project.id, title: `Chain step ${n}`, priority: "med", agent: "mock", suggested: true,
        description: `e2e:write=step${n}.txt:step ${n} work\ne2e:complete=Step ${n} summary: wrote step${n}.txt`,
      },
    });
    expect(res.status()).toBe(201);
    ids.push((await res.json()).id);
  }
  // What the composer's Auto-advance launch does: order as dependency edges,
  // then accept the batch as one chain.
  for (let i = 1; i < ids.length; i++) {
    expect((await request.patch(`/api/tasks/${ids[i]}`, { data: { depends_on: [ids[i - 1]] } })).ok()).toBeTruthy();
  }
  const accepted = await request.post("/api/tasks/accept-batch", { data: { ids, start_chain: true, chain_mode: "auto_review" } });
  expect(accepted.ok()).toBeTruthy();
  await sendMessage(request, ids[0]);

  await expect
    .poll(async () => Promise.all(ids.map(async (id) => (await getTask(request, id)).status)), { timeout: 60_000 })
    .toEqual(["in_review", "in_review", "in_review"]);
  const chainId = (await getTask(request, ids[0])).chain_id as string;

  const view = await (await request.get(`/api/chains/${chainId}`)).json();
  expect(view.steps.map((s: { title: string; additions: number }) => [s.title, s.additions])).toEqual([
    ["Chain step 1", 1], ["Chain step 2", 1], ["Chain step 3", 1],
  ]);

  await gotoApp(page);
  await page.getByText(name, { exact: true }).first().click();
  const card = page.locator(".chain-card");
  await expect(card).toContainText("3 of 3 finished");
  await card.getByRole("button", { name: "Review chain" }).click();

  const review = page.locator(".chr-root");
  await expect(review.locator(".chr-step")).toHaveCount(3);
  await expect(review).toContainText("Step 2 summary: wrote step2.txt");
  // A step's own diff shows only that step's file.
  await review.locator(".chr-step").nth(1).locator(".chr-stoggle").click();
  const stepDiff = review.locator(".chr-step").nth(1).locator(".chr-diff");
  await expect(stepDiff.locator(".tc-frow")).toHaveCount(1);
  await expect(stepDiff).toContainText("step2.txt");
  // Combined: the last step's branch vs main carries all three.
  await review.getByRole("tab", { name: "Combined" }).click();
  await expect(review.locator(".chr-combined .tc-frow")).toHaveCount(3);

  await review.getByRole("button", { name: "Merge chain" }).click();
  await expect(review.locator(".tc-mergebar.ok")).toContainText("Merged 3 step(s) into main");
  for (const n of [1, 2, 3]) expect(git(repoPath, "show", `main:step${n}.txt`)).toBe(`step ${n} work`);
  for (const id of ids) {
    const t = await getTask(request, id);
    expect(t.status).toBe("done");
    expect(t.merged_at).toBeGreaterThan(0);
  }
  // Every step done → the card leaves the tasks column.
  await expect(card).toHaveCount(0);
});
