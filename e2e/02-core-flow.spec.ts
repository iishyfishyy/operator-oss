// The core loop, driven through the UI end to end: create a project (pointed
// at a real fixture git repo), create a task, run its session with the mock
// agent, watch the transcript stream in, inspect the diff, merge to main, and
// confirm the file actually landed on the base branch on disk.

import { expect, test } from "@playwright/test";
import { ensureOnboarded, git, gotoApp, makeFixtureRepo, uid } from "./helpers";

test.describe.configure({ mode: "serial" });

const PROJECT = `Core Flow ${uid()}`;
const TASK_TITLE = "Ship a greeting file";
let repoPath: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  repoPath = makeFixtureRepo("core-flow");
});

test("create a project through the UI", async ({ page }) => {
  await gotoApp(page);
  await page.getByTitle("New project").first().click();

  await expect(page.getByText("New project").first()).toBeVisible();
  await page.getByPlaceholder("e.g. Northwind").fill(PROJECT);
  await page.getByPlaceholder("/Users/you/code/project").fill(repoPath);
  await page.getByRole("button", { name: "Create project" }).click();

  // The new project is created and selected; its (empty) task column shows.
  await expect(page.getByText(PROJECT).first()).toBeVisible();
  await expect(page.getByText("No tasks yet")).toBeVisible();
});

test("create a task, run the session, view the diff, and merge", async ({ page, request }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();

  // New task whose injected task context carries a mock-agent directive, so
  // the initial turn writes greeting.txt.
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill(TASK_TITLE);
  await page
    .getByPlaceholder(/Describe the feature or task/)
    .fill("Write the greeting. e2e:write=greeting.txt:hello from the mock agent");
  await page.getByText("Start session immediately").click();
  await page.getByRole("button", { name: "Create task" }).click();

  // The turn streams into the transcript and completes.
  await expect(page.getByText("Mock turn complete").first()).toBeVisible({ timeout: 20_000 });

  // The diff rail lists the written file.
  await expect(page.getByText("greeting.txt").first()).toBeVisible({ timeout: 15_000 });

  // Merge back to the project's base branch.
  await page.getByRole("button", { name: /Merge to main/ }).click();

  // The merge is recorded on the task row…
  const taskId = await taskIdByTitle(request, TASK_TITLE);
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${taskId}`)).json()).merged_at, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // …and the file is really on main in the fixture repo.
  expect(git(repoPath, "show", "main:greeting.txt")).toBe("hello from the mock agent");
});

test("the transcript survives a reload (persisted, not stream-bound)", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(TASK_TITLE).first().click();
  await expect(page.getByText("Mock turn complete").first()).toBeVisible();
});

test("the task description stays viewable after the session starts", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(TASK_TITLE).first().click();
  // The session header's edit button opens the task modal even after start —
  // the original description must stay viewable/copyable for a started task.
  await page.getByRole("button", { name: "View & edit task details" }).click();
  await expect(page.getByText("Edit task").first()).toBeVisible();
  await expect(page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints")).toHaveValue(TASK_TITLE);
  await expect(page.getByPlaceholder(/Describe the feature or task/)).toHaveValue(/e2e:write=greeting\.txt/);
  // Started task → the helper explains edits don't reach the running session.
  await expect(page.getByText(/Already sent to the agent/)).toBeVisible();
});

async function taskIdByTitle(request: import("@playwright/test").APIRequestContext, title: string): Promise<string> {
  const projects = await (await request.get("/api/projects")).json();
  const proj = projects.find((p: { name: string }) => p.name === PROJECT);
  const detail = await (await request.get(`/api/projects/${proj.id}`)).json();
  const task = detail.tasks.find((t: { title: string }) => t.title === title);
  expect(task).toBeTruthy();
  return task.id;
}
