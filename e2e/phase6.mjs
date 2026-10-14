// Phase 6 walk-through, meant to run against the PRODUCTION build served by the API:
//
//   npm run build && NODE_ENV=production PORT=5002 CLIENT_ORIGIN=http://localhost:5002 npm start
//   E2E_BASE_URL=http://localhost:5002 node e2e/phase6.mjs
//
// It checks the installable-app parts (manifest, icons, service worker, offline
// launch), the settings switches end to end, and that with every smart feature off
// SynChat is still a complete ordinary chat app.
import { action, BASE, check, createGroup, expect, finish, newUser, openChat, row, say, sees, startDm } from "./lib.mjs";

const config = await (await fetch(`${BASE}/api/config`)).json();
const asha = await newUser("Asha");
const ben = await newUser("Ben");

await check("The page links a valid web app manifest with installable icons", async () => {
  const href = await asha.page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await fetch(new URL(href, BASE))).json();
  expect(manifest.name === "SynChat" && manifest.display === "standalone" && manifest.start_url === "/", "manifest is missing name, display or start_url");
  const sizes = manifest.icons.map((i) => i.sizes);
  expect(sizes.includes("192x192") && sizes.includes("512x512"), "manifest lacks 192px and 512px icons");
  expect(manifest.icons.some((i) => i.purpose === "maskable"), "manifest lacks a maskable icon");
  for (const icon of manifest.icons) {
    const res = await fetch(new URL(icon.src, BASE));
    expect(res.ok && res.headers.get("content-type") === "image/png", `${icon.src} is not served as a PNG`);
  }
});

await check("A service worker is registered and takes control of the page", async () => {
  await asha.page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r?.active)), null, { timeout: 15000 });
  await asha.page.reload();
  await asha.page.getByText("Chats", { exact: true }).waitFor();
  expect(await asha.page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "the page is not controlled by the service worker");
});

await check("Settings offers exactly the switches this server supports", async () => {
  await asha.page.goto(`${BASE}/settings`);
  await asha.page.getByTestId("smart-features").waitFor();
  const names = await asha.page.getByTestId("smart-features").getByRole("switch").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const expected = ["Topic lanes", "Topic mute", "Meaning search", ...(config.features.llm ? ["Catch-up", "Decided or still open", "Questions waiting on you"] : [])];
  console.log(`        server has AI configured: ${config.features.llm}; switches shown: ${names.join(", ")}`);
  expect(names.join("|") === expected.join("|"), `expected ${expected.join(", ")}`);
  expect((await asha.page.getByRole("switch", { name: "Notifications on this device" }).count()) === 1, "no notifications switch");
});

await check("With every smart feature switched off, both people still have a complete chat app", async () => {
  for (const user of [asha, ben]) {
    await user.page.goto(`${BASE}/settings`);
    await user.page.getByTestId("smart-features").waitFor();
    for (const sw of await user.page.getByTestId("smart-features").getByRole("switch").all()) {
      await sw.click();
      await user.page.waitForTimeout(120);
    }
    const stillOn = await user.page.getByTestId("smart-features").getByRole("switch", { checked: true }).count();
    expect(stillOn === 0, `${stillOn} switches are still on for ${user.name}`);
    await user.page.getByRole("link", { name: "SynChat" }).click();
    await user.page.getByText("Chats", { exact: true }).waitFor();
  }
  await createGroup(asha, "Plain group", [ben.username]);
  await say(asha, "is this thing on");
  const badge = ben.page.getByTestId("conversation-row").filter({ hasText: "Plain group" }).getByTestId("unread-badge");
  await badge.filter({ hasText: "1" }).waitFor();
  await openChat(ben, "Plain group");
  await sees(ben, "is this thing on");
  await action(ben, "is this thing on", "Reply");
  await say(ben, "loud and clear");
  await row(asha, "loud and clear").getByTestId("quote").filter({ hasText: "is this thing on" }).waitFor();
  await action(asha, "loud and clear", "React");
  await asha.page.getByRole("button", { name: "React with 👍" }).click();
  await row(ben, "loud and clear").getByTestId("reaction").waitFor();
  await asha.page.locator('[data-testid="receipt"][data-read="true"]').first().waitFor();
  for (const user of [asha, ben]) {
    expect((await user.page.getByTestId("topic-chip").count()) === 0, "topic chips are shown with lanes off");
    expect((await user.page.getByTestId("topics-switch").count()) === 0, "the Topics switch is shown with lanes off");
    expect((await user.page.getByRole("button", { name: "Search messages" }).count()) === 0, "search is shown while switched off");
    expect((await user.page.getByRole("button", { name: /^Questions waiting/ }).count()) === 0, "the inbox is shown while switched off");
  }
  await startDm(asha, ben.username);
  await asha.page.getByTestId("chat-title").filter({ hasText: "Ben" }).waitFor();
  await say(asha, "and a DM");
  await ben.page.getByTestId("conversation-row").filter({ hasText: "and a DM" }).filter({ hasNotText: "Plain group" }).waitFor();
});

await check("Switching a feature back on takes effect at once, and is remembered across a reload", async () => {
  await ben.page.goto(`${BASE}/settings`);
  await ben.page.getByRole("switch", { name: "Topic lanes" }).click();
  await ben.page.getByRole("switch", { name: "Topic lanes", checked: true }).waitFor();
  await ben.page.reload();
  await ben.page.getByRole("switch", { name: "Topic lanes", checked: true }).waitFor();
  expect((await ben.page.getByRole("switch", { name: "Meaning search", checked: false }).count()) === 1, "search came back on by itself");
  await ben.page.getByRole("link", { name: "SynChat" }).click();
  await openChat(ben, "Plain group");
  await row(ben, "loud and clear").getByTestId("topic-chip").waitFor(); // lanes were kept server-side all along
});

await check("The app opens with no network connection (app shell from the service worker)", async () => {
  await asha.page.goto(BASE);
  await asha.page.getByText("Chats", { exact: true }).waitFor();
  await asha.context.setOffline(true);
  await asha.page.reload();
  await asha.page.getByRole("heading", { name: "SynChat" }).waitFor({ timeout: 10000 });
  await asha.context.setOffline(false);
  await asha.page.reload();
  await asha.page.getByText("Chats", { exact: true }).waitFor();
});

await check("Push: Settings offers notifications when the server has push keys", async () => {
  // Subscribing itself cannot be exercised here: automated browser contexts are
  // incognito-like, and Chrome has no Push API there. Who gets notified, and topic
  // mute, are covered by backend/test/push.test.ts.
  await asha.page.goto(`${BASE}/settings`);
  const toggle = asha.page.getByRole("switch", { name: "Notifications on this device" });
  await toggle.waitFor();
  expect((await toggle.isEnabled()) === Boolean(config.features.push), `switch enabled=${await toggle.isEnabled()} but server push=${config.features.push}`);
});

await finish([asha, ben]);
