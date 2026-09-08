import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, git, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
});

for (const resolution of ["manual", "chat"] as const) {
  test(`${resolution} resolution clears the conflict banner`, async ({ page, request }) => {
    const name = `Conflict banner ${resolution} ${uid()}`;
    const repoPath = makeFixtureRepo(name);
    const project = await createProject(request, { name, repoPath });
    const task = await createTask(request, {
      projectId: project.id,
      title: `Resolve ${resolution} conflicts`,
      description: "e2e:write=README.md:task version",
    });
    await sendMessage(request, task.id);
    const settled = await waitForIdle(request, task.id);
    fs.writeFileSync(path.join(repoPath, "README.md"), "main version\n");
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-m", "conflicting main update");
    for (let commit = 1; commit < 5; commit++) {
      git(repoPath, "commit", "--allow-empty", "-m", `main advance ${commit}`);
    }

    await gotoApp(page);
    await page.getByText(name, { exact: true }).first().click();
    await page.getByText(task.title, { exact: true }).first().click();
    const banner = page.locator(".sync-banner");
    await expect(banner).toContainText("5 behind main · conflicts in 1 file");

    if (resolution === "manual") {
      const prepared = await request.post(`/api/tasks/${task.id}/merge/prepare`);
      expect(prepared.ok()).toBeTruthy();
      await page.reload();
      await expect(banner).toContainText("conflicts in 1 file");
      fs.writeFileSync(path.join(settled.worktree_path, "README.md"), "resolved version\n");
      await expect(banner).toHaveCount(0, { timeout: 15_000 });
      const status = await (await request.get(`/api/tasks/${task.id}/sync`)).json();
      expect(status).toMatchObject({ mergeInProgress: true, behind: 5, conflicts: [] });
      expect(git(settled.worktree_path, "diff", "--name-only", "--diff-filter=U")).toBe("README.md");
      await page.reload();
      await expect(page.getByRole("button", { name: "Accept & merge" }).first()).toBeVisible();
      await expect(banner).toHaveCount(0);
      await page.getByRole("button", { name: "Accept & merge" }).first().click();
    } else {
      await page.route(`**/api/tasks/${task.id}/messages`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON();
        body.text += "\ne2e:sleep=1500\ne2e:write=README.md:resolved version";
        await route.continue({ postData: JSON.stringify(body) });
      });
      await banner.getByRole("button", { name: "Fix with AI" }).click();
      await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).running).toBe(1);
      await waitForIdle(request, task.id);
      await expect(banner).toHaveCount(0);
      expect(git(settled.worktree_path, "show", "HEAD:README.md")).toBe("resolved version");
      expect(await (await request.get(`/api/tasks/${task.id}/sync`)).json()).toMatchObject({ behind: 0, conflicts: [] });
      await page.reload();
      await expect(page.getByRole("button", { name: /Merge to main/ }).first()).toBeVisible();
      await expect(banner).toHaveCount(0);
      await page.getByRole("button", { name: /Merge to main/ }).first().click();
    }

    await expect.poll(() => git(repoPath, "show", "main:README.md")).toBe("resolved version");
    await expect(banner).toHaveCount(0);
  });
}
