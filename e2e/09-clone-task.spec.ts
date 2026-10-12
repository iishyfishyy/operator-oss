import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

test("clone a started task, change providers, then start with a chosen model", async ({ page, request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: `Clone ${uid()}`, repoPath: makeFixtureRepo("clone") });
  const source = await createTask(request, { projectId: project.id, title: "Compare implementations", description: "Implement it. e2e:write=compare.txt:comparison" });
  await request.patch(`/api/tasks/${source.id}`, { data: { model: "mock-1", send_context: 0, priority: "hi" } });
  await sendMessage(request, source.id);
  const before = await waitForIdle(request, source.id);
  await gotoApp(page);
  await page.getByText(project.name).first().click();
  await page.getByText(source.title).first().click();
  await page.getByRole("button", { name: "Clone task", exact: true }).click();
  await expect(page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints")).toHaveValue(source.title);
  await expect(page.getByPlaceholder(/Describe the feature or task/)).toHaveValue(before.description);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("mock-1");
  await expect(page.getByText("Send saved project context to the agent").locator("input")).not.toBeChecked();

  await page.getByRole("button", { name: /Codex.*not connected/ }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
  await expect(page.getByText("Start session immediately").locator("input")).toBeDisabled();
  await page.getByLabel("Model", { exact: true }).selectOption("custom");
  await expect(page.getByRole("button", { name: "Clone task", exact: true }).last()).toBeDisabled();
  await page.getByLabel("Custom model ID").fill("gpt-comparison");
  const responsePromise = page.waitForResponse((r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Clone task", exact: true }).last().click();
  const clone = await (await responsePromise).json();
  expect(clone).toMatchObject({ agent: "codex", model: "gpt-comparison", priority: "hi", send_context: 0, started: 0, session_id: null, worktree_path: "" });
  expect(clone.id).not.toBe(source.id);

  // Clone from task details as well; switch back to the connected mock agent.
  await page.getByRole("button", { name: "View & edit task details" }).click();
  await page.getByRole("button", { name: "Clone task", exact: true }).last().click();
  await page.getByRole("button", { name: "Mock Agent", exact: true }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
  await page.getByLabel("Model", { exact: true }).selectOption("mock-1");
  const startedResponse = page.waitForResponse((r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Clone & start", exact: true }).click();
  const started = await (await startedResponse).json();
  const result = await waitForIdle(request, started.id);
  expect(result.model).toBe("mock-1");
  expect(result.worktree_path).not.toBe(before.worktree_path);
  expect(result.session_id).not.toBe(before.session_id);
  expect(result.depends_on).toEqual([]);
  expect(result.chain_id).toBeNull();
  const after = await getTask(request, source.id);
  expect(after).toMatchObject({ model: before.model, agent: before.agent, worktree_path: before.worktree_path, session_id: before.session_id, updated_at: before.updated_at });
  expect(after.messages).toEqual(before.messages);
});
