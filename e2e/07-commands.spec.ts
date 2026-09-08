import { expect, test } from "@playwright/test";
import { ensureOnboarded, getTask, gotoApp, runTaskToCompletion, uid, waitForIdle } from "./helpers";

test("preset editor, keyboard selection, expansion, and palette insertion", async ({ page, request }) => {
  await ensureOnboarded(request);
  const name = `Commands ${uid()}`;
  const { task } = await runTaskToCompletion(request, { name, title: "Review comments", description: "Check correctness" });
  await gotoApp(page);
  await page.getByText(name).first().click();
  await page.getByText(task.title).first().click();
  const composer = page.locator(".composer textarea");
  await page.locator(".comp-foot").getByRole("button", { name: "/ commands", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("analyze-ai-comments");
  await page.getByLabel("Description", { exact: true }).fill("Analyze review feedback");
  await page.getByLabel("Prompt template").fill("Review {{task.title}}: {{task.description}}. Focus: {{args}}");
  await page.getByRole("button", { name: "Create command", exact: true }).click();
  await expect(page.getByRole("button", { name: "/analyze-ai-comments · project", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await composer.fill("/analyze");
  await expect(page.getByRole("option", { name: /analyze-ai-comments/ })).toBeVisible();
  await composer.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Manage commands/ })).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowUp");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/analyze-ai-comments ");
  // Selection does not send anything; submission carries the normal expanded text.
  const before = (await getTask(request, task.id)).messages.length;
  await composer.fill("/analyze-ai-comments edge cases");
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/tasks/${task.id}/messages`));
  await composer.press("Enter");
  expect((await sent).postDataJSON().text).toBe("Review Review comments: Check correctness. Focus: edge cases");
  await expect.poll(async () => (await getTask(request, task.id)).messages.length).toBeGreaterThan(before);
  const settled = await waitForIdle(request, task.id);
  expect(settled.messages.some((m: { content: string }) => m.content === "Review Review comments: Check correctness. Focus: edge cases")).toBe(true);

  await composer.fill("more checks");
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input input").fill("analyze-ai-comments");
  await page.locator(".palette").getByRole("button", { name: /analyze-ai-comments/ }).click();
  await expect(composer).toHaveValue("/analyze-ai-comments more checks");

  // Editing refreshes the mounted composer; deleting removes the definition.
  await page.locator(".comp-foot").getByRole("button", { name: "/ commands", exact: true }).click();
  await page.getByRole("button", { name: "/analyze-ai-comments · project", exact: true }).click();
  await page.getByLabel("Prompt template").fill("Updated {{args}}");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "/analyze-ai-comments · project", exact: true }).click();
  await expect(page.getByLabel("Prompt template")).toHaveValue("Updated {{args}}");
  await page.getByRole("button", { name: "Delete command", exact: true }).click();
  await expect(page.getByRole("button", { name: "/analyze-ai-comments · project", exact: true })).toHaveCount(0);
});
