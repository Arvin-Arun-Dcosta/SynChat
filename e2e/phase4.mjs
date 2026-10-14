// Phase 4 walk-through: topic mute and meaning search, as three people.
import { action, check, createGroup, expect, finish, newUser, openChat, row, say, sees, BASE } from "./lib.mjs";

const asha = await newUser("Asha");
const ben = await newUser("Ben");
const chidi = await newUser("Chidi");

await createGroup(asha, "Flatmates", [ben.username, chidi.username]);
await openChat(chidi, "Flatmates");
const chip = async (user, text) => {
  const c = row(user, text).getByTestId("topic-chip");
  await c.waitFor({ timeout: 5000 });
  return c.getAttribute("data-topic-id");
};

// Two topics. Sent from inside lanes after the openers, so the test of mute does not
// depend on how well the assigner separates them.
await say(asha, "who's in for dinner at the ramen place on saturday?");
const dinner = await chip(chidi, "ramen place");
await asha.page.waitForTimeout(400);
await say(chidi, "has anyone seen the electricity bill for this month");
const bill = await chip(asha, "electricity bill");

const inLane = async (user, topicId, text) => {
  await user.page.getByTestId("topics-switch").click();
  await user.page.locator(`[data-testid="topic-row"][data-topic-id="${topicId}"] button`).first().click();
  await user.page.getByTestId("lane-header").waitFor();
  await say(user, text);
  await sees(user, text);
  await user.page.getByRole("button", { name: "Chat", exact: true }).click();
};

const badge = (user) => user.page.getByTestId("conversation-row").filter({ hasText: "Flatmates" }).getByTestId("unread-badge");
const badgeCount = async (user) => ((await badge(user).count()) ? Number(await badge(user).innerText()) : 0);

await check("Setup: the two openers start two different topics", async () => {
  expect(dinner && bill && dinner !== bill, `topics: ${dinner} / ${bill}`);
});

await check("Ben mutes the bill topic from the Topics view", async () => {
  await openChat(ben, "Flatmates");
  await ben.page.getByTestId("topics-switch").click();
  await ben.page.locator(`[data-testid="topic-row"][data-topic-id="${bill}"]`).getByRole("button", { name: /^Mute topic/ }).click();
  await ben.page.locator(`[data-testid="topic-row"][data-topic-id="${bill}"][data-muted="true"]`).waitFor();
  // Ben goes elsewhere, so new messages are unread for him.
  await ben.page.goto(`${BASE}/profile`);
  await ben.page.getByRole("link", { name: "SynChat" }).click();
  await ben.page.getByText("Chats", { exact: true }).waitFor();
});

await check("Messages in the muted topic do not add to Ben's unread badge; other topics do", async () => {
  await inLane(chidi, bill, "it came to 3200 this time");
  await inLane(chidi, bill, "i'll put it on the fridge");
  await ben.page.getByTestId("conversation-row").filter({ hasText: "i'll put it on the fridge" }).waitFor();
  await ben.page.waitForTimeout(600);
  expect((await badgeCount(ben)) === 0, `badge shows ${await badgeCount(ben)} for muted-topic messages`);
  await inLane(asha, dinner, "table booked for 8");
  await badge(ben).filter({ hasText: "1" }).waitFor();
});

await check("A direct mention in the muted topic still gets through", async () => {
  await inLane(chidi, bill, `@${ben.username} your share is 800`);
  await badge(ben).filter({ hasText: "2" }).waitFor();
  await openChat(ben, "Flatmates");
  await row(ben, "your share is 800").getByTestId("mention").waitFor();
});

await check("Mute is personal: Asha still has the bill topic unmuted and counted", async () => {
  await asha.page.getByTestId("topics-switch").click();
  const r = asha.page.locator(`[data-testid="topic-row"][data-topic-id="${bill}"]`);
  await r.waitFor();
  expect((await r.getAttribute("data-muted")) === "false", "Asha sees the topic as muted");
  await asha.page.getByRole("button", { name: "Chat", exact: true }).click();
});

await check("The mute survives a reload and can be undone", async () => {
  await ben.page.reload();
  await openChat(ben, "Flatmates");
  await ben.page.getByTestId("topics-switch").click();
  const r = ben.page.locator(`[data-testid="topic-row"][data-topic-id="${bill}"]`);
  await ben.page.locator(`[data-testid="topic-row"][data-topic-id="${bill}"][data-muted="true"]`).waitFor();
  await r.getByRole("button", { name: /^Unmute topic/ }).click();
  await ben.page.locator(`[data-testid="topic-row"][data-topic-id="${bill}"][data-muted="false"]`).waitFor();
  await ben.page.getByRole("button", { name: "Chat", exact: true }).click();
});

await check("Meaning search: a query with no word in common finds the message, grouped under its topic", async () => {
  await asha.page.getByRole("button", { name: "Search messages" }).click();
  await asha.page.getByLabel("Search messages").last().fill("where are we going to eat this weekend");
  const hit = asha.page.getByTestId("search-hit").filter({ hasText: "ramen place" });
  await hit.first().waitFor({ timeout: 8000 });
  const group = asha.page.getByTestId("search-group").filter({ hasText: "ramen place" }).first();
  expect((await group.getByTestId("search-topic").innerText()).length > 0, "result is not labelled with its topic");
  expect((await group.innerText()).includes("Flatmates"), "result is not labelled with its chat");
  const first = await asha.page.getByTestId("search-hit").first().innerText();
  console.log(`        top hit for "where are we going to eat this weekend": ${first.replace(/\s+/g, " ").slice(0, 90)}`);
});

await check("Keyword search finds an exact word, and opening a hit jumps to the message", async () => {
  await asha.page.getByLabel("Search messages").last().fill("fridge");
  const hit = asha.page.getByTestId("search-hit").filter({ hasText: "i'll put it on the fridge" });
  await hit.waitFor();
  await hit.click();
  await asha.page.getByTestId("chat-title").filter({ hasText: "Flatmates" }).waitFor();
  await sees(asha, "i'll put it on the fridge");
});

await check("Search never shows another group's messages", async () => {
  const dora = await newUser("Dora");
  await createGroup(dora, "Elsewhere", []);
  await say(dora, "the secret ramen place is behind the fridge");
  await sees(dora, "secret ramen");
  await asha.page.getByRole("button", { name: "Search messages" }).click();
  await asha.page.getByLabel("Search messages").last().fill("secret ramen fridge");
  await asha.page.getByTestId("search-hit").first().waitFor();
  await asha.page.waitForTimeout(600);
  expect((await asha.page.getByTestId("search-results").innerText()).includes("secret") === false, "another group's message appeared in search");
  await asha.page.getByRole("button", { name: "Close search" }).click();
  await dora.context.close();
});

await check("Switching Topic mute and Search off in Settings removes them from the app", async () => {
  await ben.page.goto(`${BASE}/settings`);
  await ben.page.getByRole("switch", { name: "Topic mute" }).uncheck();
  await ben.page.getByRole("switch", { name: "Meaning search" }).uncheck();
  await ben.page.getByRole("link", { name: "SynChat" }).click();
  await ben.page.getByText("Chats", { exact: true }).waitFor();
  expect((await ben.page.getByRole("button", { name: "Search messages" }).count()) === 0, "search button still shown");
  await openChat(ben, "Flatmates");
  await ben.page.getByTestId("topics-switch").click();
  await ben.page.getByTestId("topic-row").first().waitFor();
  expect((await ben.page.getByRole("button", { name: /^(Mute|Unmute) topic/ }).count()) === 0, "mute buttons still shown");
});

await check("Switching Topic lanes off gives Ben a plain chat, while Asha keeps her lanes", async () => {
  await ben.page.goto(`${BASE}/settings`);
  await ben.page.getByRole("switch", { name: "Topic lanes" }).uncheck();
  await ben.page.getByRole("link", { name: "SynChat" }).click();
  await openChat(ben, "Flatmates");
  await sees(ben, "table booked for 8");
  expect((await ben.page.getByTestId("topic-chip").count()) === 0, "topic chips still shown");
  expect((await ben.page.getByTestId("topics-switch").count()) === 0, "Topics switch still shown");
  await say(ben, "plain chat still works");
  await sees(asha, "plain chat still works");
  await row(asha, "plain chat still works").getByTestId("topic-chip").waitFor();
});

await finish([asha, ben, chidi]);
