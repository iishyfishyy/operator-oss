// Turn-lifecycle behaviors around the runner: follow-up queueing while a turn
// is live, explicit Stop, failed-turn transcript notices, agent suggestions
// landing in the tray, and multi-turn resume. Mostly API-driven (the flows are
// server-side), with UI assertions where the behavior is user-visible.

import { expect, test } from "@playwright/test";
import {
  createProject,
  createTask,
  ensureOnboarded,
  getTask,
  gotoApp,
  makeFixtureRepo,
  sendMessage,
  uid,
  waitForIdle,
} from "./helpers";

const PROJECT = `Behaviors ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("behaviors") });
  projectId = project.id;
});

test("a follow-up sent mid-turn queues, then runs as the next turn", async ({ request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Queueing",
    description: "e2e:sleep=3000",
  });
  await sendMessage(request, task.id); // initial turn: sleeps 3s
  await expect.poll(async () => (await getTask(request, task.id)).running).toBe(1);

  // Second message while the turn is live → parked, not run.
  const res = await request.post(`/api/tasks/${task.id}/messages`, { data: { text: "follow-up work" } });
  expect(res.status()).toBe(202);
  expect((await res.json()).queued).toBe(true);

  // Once the first turn ends the queue drains: both user messages and two
  // mock assistant replies end up in the transcript.
  await expect
    .poll(
      async () => {
        const t = await getTask(request, task.id);
        return t.running === 0 && t.messages.filter((m: { role: string }) => m.role === "assistant").length;
      },
      { timeout: 20_000 }
    )
    .toBe(2);
});

test("Stop ends a live turn cleanly and discards the queue", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Stopping",
    description: "e2e:sleep=60000",
  });
  await sendMessage(request, task.id);
  await expect.poll(async () => (await getTask(request, task.id)).running).toBe(1);
  await sendMessage(request, task.id, "queued behind the doomed turn");

  // Stop from the UI (the composer's stop button).
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Stopping").first().click();
  await page.getByTitle("Stop the current turn").click();

  const settled = await waitForIdle(request, task.id, 15_000);
  // Stopped, not failed: no error line, and the parked follow-up was discarded.
  const errors = settled.messages.filter((m: { content: string }) => m.content.startsWith("⚠"));
  expect(errors).toHaveLength(0);
  const assistants = settled.messages.filter((m: { role: string }) => m.role === "assistant");
  expect(assistants).toHaveLength(0); // aborted mid-sleep, before the reply
});

test("a failing turn surfaces the error in the transcript", async ({ request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Failing",
    description: "e2e:fail=Simulated agent failure",
  });
  await sendMessage(request, task.id);
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 0 && t.messages.some((m: { content: string }) => m.content.includes("Simulated agent failure"));
    }, { timeout: 20_000 })
    .toBeTruthy();
});

test("agent suggestions land in the Suggested tray", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Suggesting",
    description: "e2e:suggest=Refactor the widget factory",
  });
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);

  // Server-side: the suggested task row exists on this project.
  const detail = await (await request.get(`/api/projects/${projectId}`)).json();
  const suggestion = detail.tasks.find((t: { title: string }) => t.title === "Refactor the widget factory");
  expect(suggestion?.suggested).toBe(1);

  // UI: it shows under "Suggested by agents".
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await expect(page.getByText("Suggested by agents")).toBeVisible();
  // Scoped to the tray's name element — the originating task's description
  // contains the same words, so a bare text match is ambiguous.
  await expect(page.locator(".sg-name").filter({ hasText: "Refactor the widget factory" })).toBeVisible();
  // …under a header naming the task (and session) whose turn proposed it.
  await expect(page.locator(".sug-head").filter({ hasText: "From: Suggesting · session 1" })).toBeVisible();

  // The persisted suggest_task card links to the task it created (the driver
  // lifts the id off the tool result; the runner persists it on the row).
  const parent = await getTask(request, task.id);
  const card = parent.messages.find((m: { role: string; content: string }) => m.role === "tool" && m.content.includes('"suggestion"'));
  expect(JSON.parse(card.content).suggestion).toEqual({ title: "Refactor the widget factory", taskId: suggestion.id });

  // In the proposer's transcript that card is a LIVE chip: rename it inline and
  // the tray follows, dismiss it and the chip greys out as "dismissed".
  // `exact` keeps the tray's "From: Suggesting · session 1" header out of it.
  await page.getByText("Suggesting", { exact: true }).first().click();
  const chip = page.locator(".sug-chip").filter({ hasText: "Refactor the widget factory" });
  await expect(chip).toBeVisible();
  await chip.locator(".sug-chip-title").click();
  // While editing, the chip's text is the input's VALUE (not text content), so
  // the hasText filter above can't see it — find the field by its label.
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill("Refactor the widget factory, gently");
  await field.press("Enter");
  await expect(page.locator(".sg-name").filter({ hasText: "Refactor the widget factory, gently" })).toBeVisible();
  await expect.poll(async () => (await getTask(request, suggestion.id)).title).toBe("Refactor the widget factory, gently");

  await chip.getByRole("button", { name: "Dismiss suggestion" }).click();
  await expect(chip).toHaveClass(/is-gone/);
  await expect(chip).toContainText("dismissed");
  await expect(page.locator(".sg-name").filter({ hasText: "Refactor the widget factory" })).toHaveCount(0);
  expect((await request.get(`/api/tasks/${suggestion.id}`)).status()).toBe(404);
});

test("a turn that files several suggestions gets a 'Suggested this session' block", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Batching",
    description: "e2e:suggest=Batch alpha\ne2e:suggest=Batch beta",
  });
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);

  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Batching", { exact: true }).first().click();
  // One compact block at the end of the turn, holding both chips.
  const batch = page.locator(".sug-batch");
  await expect(batch).toBeVisible();
  await expect(batch).toContainText("Suggested this session");
  await expect(batch).toContainText("2 tasks");
  await expect(batch.locator(".sug-chip")).toHaveCount(2);

  // Add from the block: the chip flips to "added" (with Open), the tray drops
  // it, and it appears in the task list as a real task.
  const alpha = batch.locator(".sug-chip").filter({ hasText: "Batch alpha" });
  await alpha.getByRole("button", { name: "Add" }).click();
  await expect(alpha).toContainText("added");
  await expect(alpha.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: "Batch alpha" })).toHaveCount(0);
  await expect(page.locator(".sg-name").filter({ hasText: "Batch beta" })).toBeVisible();
  // Collapsing hides the chips; the header stays.
  await batch.locator(".sug-batch-h").click();
  await expect(batch.locator(".sug-chip")).toHaveCount(0);
  await expect(batch).toContainText("2 tasks");
});

test("a second turn resumes the same session", async ({ request }) => {
  const task = await createTask(request, { projectId, title: "Resuming", description: "first pass" });
  await sendMessage(request, task.id);
  const afterFirst = await waitForIdle(request, task.id);
  expect(afterFirst.session_id).toBeTruthy();

  await sendMessage(request, task.id, "second pass, same session please");
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 0 && t.messages.filter((m: { role: string }) => m.role === "assistant").length;
    }, { timeout: 20_000 })
    .toBe(2);
  const afterSecond = await getTask(request, task.id);
  expect(afterSecond.session_id).toBe(afterFirst.session_id);
});
