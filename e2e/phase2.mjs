// Phase 2 walk-through: the everyday chat features, as three people in three sessions.
import { action, apiCall, BASE, check, createGroup, expect, finish, login, newUser, openChat, row, say, sees, startDm } from "./lib.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const asha = await newUser("Asha");
const ben = await newUser("Ben");
const chidi = await newUser("Chidi");

await createGroup(asha, "Flatmates", [ben.username]);
await openChat(ben, "Flatmates");
await say(asha, "who is buying milk?");
await sees(ben, "who is buying milk?");

await check("Reply: Ben replies to a message and Asha sees the quote", async () => {
  await action(ben, "who is buying milk?", "Reply");
  await ben.page.getByTestId("composer-context").filter({ hasText: "Replying to Asha" }).waitFor();
  await say(ben, "i can get it tonight");
  const r = row(asha, "i can get it tonight");
  await r.waitFor();
  await r.getByTestId("quote").filter({ hasText: "who is buying milk?" }).waitFor();
});

await check("Reactions: both react, the count is shared, and a reaction can be taken back", async () => {
  await action(asha, "i can get it tonight", "React");
  await asha.page.getByRole("button", { name: "React with 👍" }).click();
  const chip = row(ben, "i can get it tonight").getByTestId("reaction");
  await chip.filter({ hasText: "1" }).waitFor();
  await chip.click();
  await row(asha, "i can get it tonight").getByTestId("reaction").filter({ hasText: "2" }).waitFor();
  await chip.click();
  await row(asha, "i can get it tonight").getByTestId("reaction").filter({ hasText: "1" }).waitFor();
});

await check("Edit: Ben fixes his message and Asha sees it marked as edited", async () => {
  await action(ben, "i can get it tonight", "More");
  await ben.page.getByRole("button", { name: "Edit" }).click();
  const box = ben.page.getByLabel("Message", { exact: true });
  expect((await box.inputValue()) === "i can get it tonight", "edit box was not prefilled");
  await box.fill("i can get it tomorrow");
  await box.press("Enter");
  const r = row(asha, "i can get it tomorrow");
  await r.waitFor();
  await r.getByText("edited").waitFor();
  expect((await asha.page.getByTestId("message").filter({ hasText: "tonight" }).count()) === 0, "old text still shown");
});

await check("Read receipts: the tick turns into a double tick once the other person has read it", async () => {
  await ben.page.goto(`${BASE}/settings`);
  await say(asha, "unread for now");
  const receipt = row(asha, "unread for now").getByTestId("receipt");
  await receipt.waitFor();
  await asha.page.waitForTimeout(400);
  expect((await receipt.getAttribute("data-read")) === "false", "showed as read before Ben opened it");
  await ben.page.goto(BASE);
  await openChat(ben, "Flatmates");
  await asha.page.locator('[data-testid="receipt"][data-read="true"]').last().waitFor();
});

await check("Delete: Ben deletes a message and it is gone for Asha too", async () => {
  await say(ben, "oops wrong chat");
  await sees(asha, "oops wrong chat");
  ben.page.once("dialog", (d) => d.accept());
  await action(ben, "oops wrong chat", "More");
  await ben.page.getByRole("button", { name: "Delete" }).click();
  await asha.page.getByTestId("message").filter({ hasText: "Message deleted" }).waitFor();
  expect((await asha.page.getByText("oops wrong chat").count()) === 0, "deleted text still visible");
});

await check("Images: Asha sends a picture with a caption and it loads for Ben", async () => {
  await asha.page.getByLabel("Attach image").setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: PNG });
  await asha.page.getByAltText("Image to send").waitFor();
  await say(asha, "the fridge situation");
  const img = row(ben, "the fridge situation").locator("img");
  await img.waitFor();
  await ben.page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle());
  await asha.page.locator('[data-testid="message"][data-status="sending"]').waitFor({ state: "detached" });
});

await check("Group admin: rename and add a member; everyone sees it live", async () => {
  await asha.page.getByRole("button", { name: "Group info" }).click();
  await asha.page.getByRole("button", { name: "Rename group" }).click();
  await asha.page.getByLabel("Group name").fill("Flat 4B");
  await asha.page.getByRole("button", { name: "Save" }).click();
  await ben.page.getByTestId("chat-title").filter({ hasText: "Flat 4B" }).waitFor();
  await ben.page.getByTestId("system-message").filter({ hasText: 'renamed the group to "Flat 4B"' }).waitFor();

  await asha.page.getByLabel("Add member by username").fill(chidi.username);
  await asha.page.getByRole("button", { name: "Add", exact: true }).click();
  await chidi.page.getByTestId("conversation-row").filter({ hasText: "Flat 4B" }).waitFor();
  await openChat(chidi, "Flat 4B");
  await sees(chidi, "who is buying milk?");
});

await check("Removing a member takes the chat away from them at once", async () => {
  asha.page.once("dialog", (d) => d.accept());
  await asha.page.getByRole("button", { name: "Remove Chidi", exact: true }).click();
  await chidi.page.getByTestId("conversation-row").filter({ hasText: "Flat 4B" }).waitFor({ state: "detached" });
  await say(asha, "chidi should not see this");
  await sees(ben, "chidi should not see this");
  await chidi.page.waitForTimeout(500);
  expect((await chidi.page.getByText("chidi should not see this").count()) === 0, "removed member still received a message");
});

let inviteLink;
await check("Group invite link: Chidi follows it, previews the group, and joins", async () => {
  await asha.page.getByRole("button", { name: "Create invite link" }).click();
  inviteLink = await asha.page.locator("li span.font-mono").first().innerText();
  expect(/\/join\/[\w-]{16,}$/.test(inviteLink), `unexpected link ${inviteLink}`);
  await chidi.page.goto(inviteLink);
  await chidi.page.getByRole("heading", { name: "Flat 4B" }).waitFor();
  await chidi.page.getByText("2 members").waitFor();
  await chidi.page.getByRole("button", { name: "Join group" }).click();
  await chidi.page.getByTestId("chat-title").filter({ hasText: "Flat 4B" }).waitFor();
  await ben.page.getByTestId("system-message").filter({ hasText: "Chidi joined with an invite link" }).waitFor();
});

await check("Personal invite link: opened while signed out, it survives sign-in and starts a DM", async () => {
  const code = (await apiCall(ben, "GET", "/auth/me")).body.user.inviteCode;
  await chidi.page.getByRole("button", { name: "Log out" }).click();
  await chidi.page.goto(`${BASE}/u/${code}`);
  await chidi.page.fill('input[name="identifier"]', chidi.username);
  await chidi.page.fill('input[name="password"]', "correct horse battery");
  await chidi.page.click('button[type="submit"]');
  await chidi.page.getByRole("button", { name: "Message Ben" }).click();
  await chidi.page.getByTestId("chat-title").filter({ hasText: "Ben" }).waitFor();
  await say(chidi, "hi ben, got your link");
  await ben.page.getByTestId("conversation-row").filter({ hasText: "hi ben, got your link" }).waitFor();
});

await check("People cannot be found by partial username", async () => {
  await chidi.page.getByRole("button", { name: "New chat" }).click();
  // All but the last character: a prefix that cannot itself be someone's username.
  await chidi.page.getByLabel("Username", { exact: true }).fill(asha.username.slice(0, -1));
  await chidi.page.getByRole("button", { name: "Start chat" }).click();
  await chidi.page.getByText("User not found").waitFor();
  await chidi.page.getByRole("button", { name: "Close" }).first().click();
});

await check("Long history: only part of it is in the DOM, and scrolling up pages in the rest", async () => {
  const id = (await apiCall(asha, "GET", "/conversations")).body.conversations.find((c) => c.name === "Flat 4B").id;
  for (let i = 1; i <= 300; i++) {
    const res = await apiCall(asha, "POST", `/conversations/${id}/messages`, { id: crypto.randomUUID(), text: `bulk message ${i}` });
    if (res.status === 429) { await asha.page.waitForTimeout(2000); i--; }
    else if (i % 28 === 0) await asha.page.waitForTimeout(10_000); // stay under 30 sends per 10 s
  }
  await ben.page.reload();
  await openChat(ben, "Flat 4B");
  await sees(ben, "bulk message 300");
  const inDom = await ben.page.getByTestId("message").count();
  expect(inDom < 80, `expected a virtualised list, found ${inDom} rows in the DOM`);
  const scroller = ben.page.locator('[data-testid="message-list"] [data-virtuoso-scroller]');
  for (let i = 0; i < 60 && (await ben.page.getByText("Start of the conversation").count()) === 0; i++) {
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await ben.page.waitForTimeout(150);
  }
  await ben.page.getByText("who is buying milk?").first().waitFor();
  expect((await ben.page.getByTestId("message").count()) < 120, "DOM grew with history instead of staying windowed");
});

await check("Asha opens a DM with Ben", async () => {
  await startDm(asha, ben.username);
});

await check("Presence: Ben on two devices stays online until both are closed", async () => {
  await openChat(asha, "Ben");
  const subtitle = asha.page.getByTestId("chat-subtitle");
  await subtitle.filter({ hasText: "Online" }).waitFor();
  const ben2 = await login(ben.username);
  await ben.context.close();
  await asha.page.waitForTimeout(5500);
  expect((await subtitle.innerText()) === "Online", "went offline while a second device was connected");
  await ben2.context.close();
  await subtitle.filter({ hasText: "Offline" }).waitFor({ timeout: 10000 });
});

await finish([asha, chidi]);
