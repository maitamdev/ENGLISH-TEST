import { expect, test, type Browser, type Page } from "@playwright/test";

const enabled = process.env.E2E_REAL_SUPABASE === "1";

async function createRoom(browser: Browser, suffix: string) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto("/create-room");
  await page.getByLabel("Display name").fill(`E2E Host ${suffix}`);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/u);
  const code = page.url().match(/\/room\/([A-Z0-9]{6})$/u)?.[1];
  if (!code) throw new Error("Room code was not returned by the real create_room RPC");
  return { context, page, code };
}

async function joinRoom(browser: Browser, code: string, suffix: string) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(`/join-room?code=${code}`);
  await page.getByLabel("Display name").fill(`E2E Peer ${suffix}`);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page).toHaveURL(new RegExp(`/room/${code}$`, "u"));
  return { context, page };
}

async function enterSetup(host: Page, peer: Page) {
  await expect(host.getByText("2 online")).toBeVisible({ timeout: 35_000 });
  await expect(peer.getByText("2 online")).toBeVisible({ timeout: 35_000 });
  await host.getByRole("button", { name: "Bật Gemini và setup trận" }).click();
  await expect(host.getByRole("button", { name: "Generate match" })).toBeVisible();
  await expect(peer.getByRole("button", { name: "Generate match" })).toBeVisible({ timeout: 25_000 });
}

test.describe("real two-browser room coordination", () => {
  test.skip(!enabled, "Set E2E_REAL_SUPABASE=1 to run against a configured real Supabase project.");

  test("both users receive presence and the surviving peer becomes host", async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const host = await createRoom(browser, suffix);
    const peer = await joinRoom(browser, host.code, suffix);
    await enterSetup(host.page, peer.page);
    await host.context.close();
    await expect(peer.page.getByText(/host epoch [2-9]/u)).toBeVisible({ timeout: 50_000 });
    await peer.context.close();
  });
});

test.describe("real AI match handshake", () => {
  test.skip(!enabled || process.env.E2E_REAL_AI !== "1", "Set E2E_REAL_SUPABASE=1 and E2E_REAL_AI=1 to use the configured Groq and Gemini services.");

  test("both users see START and NEXT ROUND for the same persisted match", async ({ browser }) => {
    test.setTimeout(360_000);
    const suffix = Date.now().toString(36);
    const host = await createRoom(browser, suffix);
    const peer = await joinRoom(browser, host.code, suffix);
    try {
      await enterSetup(host.page, peer.page);
      await host.page.getByPlaceholder("Or type exactly what both players want to practise…").fill("Tạo 5 câu thi từ vựng đồ vật trong gia đình, dịch tiếng Việt sang tiếng Anh, trình độ A2");
      await host.page.getByRole("button", { name: "Generate match" }).click();
      const hostStart = host.page.getByRole("button", { name: /START, tôi sẵn sàng/u });
      const peerStart = peer.page.getByRole("button", { name: /START, tôi sẵn sàng/u });
      await expect(hostStart).toBeVisible({ timeout: 240_000 });
      await expect(peerStart).toBeVisible({ timeout: 240_000 });
      await Promise.all([hostStart.click(), peerStart.click()]);
      await answerCurrentRound(host.page, "e2e host answer");
      await answerCurrentRound(peer.page, "e2e peer answer");
      await expect(host.page.getByRole("button", { name: /NEXT ROUND/u })).toBeVisible({ timeout: 35_000 });
      await expect(peer.page.getByRole("button", { name: /NEXT ROUND/u })).toBeVisible({ timeout: 35_000 });
    } finally {
      await Promise.allSettled([host.context.close(), peer.context.close()]);
    }
  });
});

async function answerCurrentRound(page: Page, answer: string) {
  const input = page.locator(".answer-form input, .answer-form textarea").first();
  const choice = page.locator(".choice-grid button").first();
  await expect(input.or(choice)).toBeVisible({ timeout: 35_000 });
  if (await input.isVisible()) {
    await input.fill(answer);
    await page.locator(".answer-form button[type=submit], .answer-form button").last().click();
  } else await choice.click();
}
