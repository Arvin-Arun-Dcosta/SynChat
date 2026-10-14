// Phase 1 walk-through: two people, two browser sessions, DMs, a group, reliability.
import { BASE, check, createGroup, expect, finish, messageTexts, newUser, openChat, say, sees, startDm } from "./lib.mjs";

const asha = await newUser("Asha");
const ben = await newUser("Ben");

await check("Asha starts a DM with Ben by exact username and sends a message", async () => {
  await startDm(asha, ben.username);
  await say(asha, "hey ben, you around?");
  await sees(asha, "hey ben, you around?");
});

await check("Ben's sidebar updates for a chat he has not opened, with an unread badge", async () => {
  const row = ben.page.getByTestId("conversation-row").filter({ hasText: "Asha" });
  await row.waitFor();
  await row.getByText("hey ben, you around?").waitFor();
  expect((await row.getByTestId("unread-badge").innerText()) === "1", "expected unread badge of 1");
});

await check("Ben opens it, the badge clears, and his reply reaches Asha live", async () => {
  await openChat(ben, "Asha");
  await sees(ben, "hey ben, you around?");
  await ben.page.getByTestId("unread-badge").waitFor({ state: "detached" });
  await say(ben, "yep, what's up");
  await sees(asha, "yep, what's up");
});

await check("Asha sees Ben as online and sees him typing", async () => {
  await asha.page.getByTestId("chat-subtitle").filter({ hasText: "Online" }).waitFor();
  await ben.page.getByLabel("Message", { exact: true }).pressSequentially("thinking", { delay: 30 });
  await asha.page.getByTestId("chat-subtitle").filter({ hasText: "typing" }).waitFor();
  await ben.page.getByLabel("Message", { exact: true }).fill("");
});

await check("A group delivers to both members in the same order", async () => {
  await createGroup(asha, "Weekend", [ben.username]);
  await ben.page.getByTestId("conversation-row").filter({ hasText: "Weekend" }).waitFor();
  await openChat(ben, "Weekend");
  for (let i = 1; i <= 4; i++) await say(i % 2 ? asha : ben, `plan ${i}`);
  await sees(asha, "plan 4");
  await sees(ben, "plan 4");
  const a = await messageTexts(asha);
  const b = await messageTexts(ben);
  expect(a.join("|") === "plan 1|plan 2|plan 3|plan 4", `Asha saw ${a.join("|")}`);
  expect(b.join("|") === a.join("|"), `Ben saw ${b.join("|")}`);
});

await check("Messages sent while offline are queued, then delivered once, in order", async () => {
  await ben.context.setOffline(true);
  await say(ben, "sent while offline 1");
  await say(ben, "sent while offline 2");
  await ben.page.locator('[data-testid="message"][data-status="sending"]').first().waitFor();
  await say(asha, "ben are you there");
  await asha.page.waitForTimeout(1500);
  expect(!(await messageTexts(asha)).includes("sent while offline 1"), "offline message leaked early");
  await ben.context.setOffline(false);
  await sees(asha, "sent while offline 2", 30000);
  await sees(ben, "ben are you there", 30000);
  await ben.page.locator('[data-testid="message"][data-status="sending"]').first().waitFor({ state: "detached", timeout: 30000 });
  const a = (await messageTexts(asha)).slice(4);
  const b = (await messageTexts(ben)).slice(4);
  expect(a.length === 3 && new Set(a).size === 3, `Asha has duplicates or gaps: ${a.join("|")}`);
  expect(a.join("|") === b.join("|"), `order differs: ${a.join("|")} vs ${b.join("|")}`);
});

await check("History survives a reload and stays signed in", async () => {
  await ben.page.reload();
  await openChat(ben, "Weekend");
  await sees(ben, "plan 1");
  expect((await messageTexts(ben)).length === 7, "expected 7 messages after reload");
});

await check("Logging out ends the session", async () => {
  await ben.page.getByRole("button", { name: "Log out" }).click();
  await ben.page.getByText("Welcome back", { exact: true }).waitFor();
  const res = await ben.page.request.get(`${BASE}/api/conversations`);
  expect(res.status() === 401, `expected 401 after logout, got ${res.status()}`);
});

await finish([asha, ben]);
