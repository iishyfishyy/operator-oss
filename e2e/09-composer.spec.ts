import { expect, test } from "@playwright/test";
import { ensureOnboarded, gotoApp, runTaskToCompletion, uid } from "./helpers";

test("expand long drafts, collapse without losing text, and send on mobile", async ({ page, request }) => {
  await ensureOnboarded(request);
  const name = `Composer ${uid()}`;
  const { task } = await runTaskToCompletion(request, { name, title: "Long draft" });
  await gotoApp(page);
  await page.getByText(name).first().click();
  await page.getByText(task.title).first().click();
  const composer = page.locator(".composer textarea");
  const draft = Array.from({ length: 25 }, (_, i) => `Draft line ${i + 1}`).join("\n");
  await composer.fill(draft);
  await expect.poll(() => composer.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(160);
  await page.getByRole("button", { name: "Expand prompt area", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collapse prompt area", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => composer.evaluate((el) => el.clientHeight)).toBeGreaterThan(160);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue(`${draft}\n`);
  await composer.press("Escape");
  await expect(page.getByRole("button", { name: "Expand prompt area", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => composer.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(160);
  await expect(composer).toHaveValue(`${draft}\n`);

  await page.getByRole("button", { name: "Expand prompt area", exact: true }).click();
  await composer.fill("/");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse prompt area", exact: true })).toBeVisible();

  await composer.fill(draft);
  await page.getByRole("button", { name: "Collapse prompt area", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toHaveValue(draft);
  await page.getByRole("button", { name: "Expand prompt area", exact: true }).click();
  const collapse = page.getByRole("button", { name: "Collapse prompt area", exact: true });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(composer).toHaveValue(draft);
  await page.getByRole("button", { name: "Expand prompt area", exact: true }).click();
  await expect.poll(() => composer.evaluate((el) => el.clientHeight)).toBeGreaterThan(160);
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/tasks/${task.id}/messages`));
  await composer.press("Enter");
  expect((await sent).postDataJSON().text).toBe(draft);
  await expect(composer).toHaveValue("");
});
