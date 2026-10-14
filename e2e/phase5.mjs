// Phase 5 walk-through: the LLM-backed features (catch-up, decided-or-open, questions
// inbox) and the group admin's switch, as three people.
//
// Runs against whatever digest model the server has. Without ANTHROPIC_API_KEY, start
// the server with LLM_STUB=true: a rule-based stand-in (not AI) then fills these
// screens, which is enough to exercise the plumbing, permissions and UI.
import { BASE, check, createGroup, expect, finish, newUser, openChat, row, say, sees } from "./lib.mjs";

const config = await (await fetch(`${BASE}/api/config`)).json();
if (!config.features.llm) {
  console.log("  SKIP  the server has no AI model configured (set ANTHROPIC_API_KEY, or LLM_STUB=true for the stand-in)");
  process.exit(0);
}

const asha = await newUser("Asha");
const ben = await newUser("Ben");
const chidi = await newUser("Chidi");
await createGroup(asha, "Flatmates", [ben.username, chidi.username]);
await openChat(ben, "Flatmates");

await say(asha, "who's in for dinner at the ramen place on saturday?");
await row(ben, "ramen place").getByTestId("topic-chip").waitFor();
const topicId = await row(ben, "ramen place").getByTestId("topic-chip").getAttribute("data-topic-id");
const topicRow = (user) => user.page.locator(`[data-testid="topic-row"][data-topic-id="${topicId}"]`);
const showTopics = async (user) => {
  if ((await user.page.getByTestId("topics-panel").count()) === 0) await user.page.getByTestId("topics-switch").click();
  await topicRow(user).waitFor();
};
const inLane = async (user, text) => {
  await showTopics(user);
  await topicRow(user).getByRole("button").first().click();
  await user.page.getByTestId("lane-header").waitFor();
  await say(user, text);
  await sees(user, text);
};

await check("AI features are off by default: no status, no catch-up, no inbox entries", async () => {
  await showTopics(ben);
  await ben.page.waitForTimeout(2500);
  expect((await ben.page.getByTestId("topic-status").count()) === 0, "a status is shown while AI is off");
  expect((await ben.page.getByTestId("catch-up").count()) + (await ben.page.getByTestId("catch-up-button").count()) === 0, "catch-up is offered while AI is off");
  await ben.page.getByRole("button", { name: "Chat", exact: true }).click();
});

await check("A member who is not an admin is told plainly what the switch does, and cannot flip it", async () => {
  await ben.page.getByRole("button", { name: "Group info" }).click();
  const section = ben.page.getByTestId("ai-section");
  await section.getByText("sends this group's messages to an outside AI provider").waitFor();
  await section.getByText("This is off. Only a group admin can turn it on.").waitFor();
  expect((await section.getByRole("switch").count()) === 0, "a non-admin was offered the switch");
  await ben.page.getByRole("button", { name: "Close group info" }).click();
});

await check("The admin turns AI on, next to a plain statement, and everyone is told in the chat", async () => {
  await asha.page.getByRole("button", { name: "Group info" }).click();
  const section = asha.page.getByTestId("ai-section");
  await section.getByText("sends this group's messages to an outside AI provider").waitFor();
  expect(!(await section.getByRole("switch").isChecked()), "the switch was already on");
  await section.getByRole("switch").click(); // takes effect when the server confirms
  await section.getByRole("switch", { checked: true }).waitFor();
  await asha.page.getByRole("button", { name: "Close group info" }).click();
  await ben.page.getByTestId("system-message").filter({ hasText: "turned on AI features. Messages in this group are now sent to an outside AI provider" }).waitFor();
});

await check("The topic gets a status that every member sees", async () => {
  await showTopics(ben);
  await topicRow(ben).locator('[data-testid="topic-status"][data-status="open"]').waitFor({ timeout: 20000 });
  await showTopics(asha);
  await topicRow(asha).locator('[data-testid="topic-status"][data-status="open"]').waitFor();
});

await check("A question put to Ben appears in his inbox, and opening it jumps to the message", async () => {
  await inLane(asha, "Ben can you book the table for 8?");
  await ben.page.getByTestId("inbox-count").filter({ hasText: "1" }).waitFor({ timeout: 20000 });
  await ben.page.getByRole("button", { name: /^Questions waiting on you/ }).click();
  const item = ben.page.getByTestId("inbox-item");
  await item.filter({ hasText: "book the table" }).waitFor();
  expect((await item.innerText()).includes("Flatmates"), "the inbox item does not say which chat it is from");
  await item.getByRole("button").first().click();
  await sees(ben, "Ben can you book the table for 8?");
});

await check("Chidi, who was away, gets a catch-up on the topic he has unread messages in", async () => {
  await openChat(chidi, "Flatmates");
  await chidi.page.goto(`${BASE}/profile`); // away
  await inLane(asha, "also should we invite the neighbours");
  await chidi.page.getByRole("link", { name: "SynChat" }).click();
  await chidi.page.getByText("Chats", { exact: true }).waitFor();
  await chidi.page.getByTestId("conversation-row").filter({ hasText: "Flatmates" }).getByTestId("unread-badge").waitFor();
  // Open the chat without reading the lane: go straight to Topics.
  await chidi.page.getByTestId("conversation-row").filter({ hasText: "Flatmates" }).click();
  await chidi.page.getByTestId("topics-switch").click();
  await topicRow(chidi).waitFor();
  // Either the recap is already there, or one click fetches it.
  const button = topicRow(chidi).getByTestId("catch-up-button");
  if (await button.count()) await button.click();
  const recap = topicRow(chidi).getByTestId("catch-up");
  await recap.waitFor({ timeout: 20000 });
  console.log(`        catch-up shown to Chidi: ${(await recap.innerText()).replace(/\s+/g, " ").slice(0, 110)}`);
});

await check("Ben answers; his inbox empties and the topic becomes Decided with the outcome pinned", async () => {
  await inLane(ben, "booked for 8 on saturday, confirmed");
  await ben.page.getByTestId("inbox-count").waitFor({ state: "detached", timeout: 20000 });
  await ben.page.getByTestId("lane-outcome").waitFor({ timeout: 20000 });
  const outcome = await ben.page.getByTestId("lane-outcome").innerText();
  console.log(`        pinned outcome: ${outcome.replace(/\s+/g, " ")}`);
  await showTopics(asha);
  await topicRow(asha).locator('[data-testid="topic-status"][data-status="decided"]').waitFor({ timeout: 20000 });
  await topicRow(asha).getByTestId("topic-outcome").waitFor();
});

await check("Any member can override the status, for everyone", async () => {
  await ben.page.getByRole("button", { name: "Change topic status" }).click();
  await ben.page.getByRole("button", { name: "Mark as still open" }).click();
  await topicRow(asha).locator('[data-testid="topic-status"][data-status="open"]').waitFor();
  await ben.page.getByTestId("lane-outcome").waitFor({ state: "detached" });
});

await check("The next digest does not undo a member's choice", async () => {
  await say(ben, "table is confirmed btw");
  await sees(ben, "table is confirmed btw");
  await asha.page.waitForTimeout(4000);
  expect((await topicRow(asha).getByTestId("topic-status").getAttribute("data-status")) === "open", "the digest overwrote a member's status");
});

await check("A member can record what was decided; it is pinned for everyone", async () => {
  ben.page.once("dialog", (d) => d.accept("Ramen place, Saturday 8pm"));
  await ben.page.getByRole("button", { name: "Change topic status" }).click();
  await ben.page.getByRole("button", { name: "Mark as decided…" }).click();
  await ben.page.getByTestId("lane-outcome").filter({ hasText: "Ramen place, Saturday 8pm" }).waitFor();
  await topicRow(asha).getByTestId("topic-outcome").filter({ hasText: "Ramen place, Saturday 8pm" }).waitFor();
});

await check("A question can be dismissed from the inbox, and stays gone", async () => {
  await inLane(asha, "Chidi are you bringing the speaker?");
  await chidi.page.getByTestId("inbox-count").waitFor({ timeout: 20000 });
  await chidi.page.getByRole("button", { name: /^Questions waiting on you/ }).click();
  await chidi.page.getByTestId("inbox-item").filter({ hasText: "speaker" }).getByRole("button", { name: /^Dismiss/ }).click();
  await chidi.page.getByText("Nothing is waiting on you.").waitFor();
  await chidi.page.getByRole("button", { name: "Close", exact: true }).first().click();
  await inLane(asha, "it would be great for the party");
  await asha.page.waitForTimeout(4000);
  expect((await chidi.page.getByTestId("inbox-count").count()) === 0, "a dismissed question came back");
});

await check("Each person can switch the AI features off for themselves", async () => {
  await ben.page.goto(`${BASE}/settings`);
  for (const name of ["Catch-up", "Decided or still open", "Questions waiting on you"]) await ben.page.getByRole("switch", { name }).uncheck();
  await ben.page.getByRole("link", { name: "SynChat" }).click();
  await openChat(ben, "Flatmates");
  expect((await ben.page.getByRole("button", { name: /^Questions waiting on you/ }).count()) === 0, "the inbox button is still shown");
  await showTopics(ben);
  expect((await ben.page.getByTestId("topic-status").count()) === 0, "status is still shown");
  await asha.page.getByRole("button", { name: "Topics", exact: false }).first().click();
  await topicRow(asha).getByTestId("topic-status").waitFor(); // Asha's view is unaffected
});

await check("The admin turns AI off: the summaries disappear for everyone, and the chat says so", async () => {
  await asha.page.getByRole("button", { name: "Chat", exact: true }).click();
  await asha.page.getByRole("button", { name: "Group info" }).click();
  await asha.page.getByTestId("ai-section").getByRole("switch").click();
  await asha.page.getByTestId("ai-section").getByRole("switch", { checked: false }).waitFor();
  await asha.page.getByRole("button", { name: "Close group info" }).click();
  await asha.page.getByTestId("system-message").filter({ hasText: "turned off AI features" }).waitFor();
  await showTopics(chidi);
  await chidi.page.waitForFunction(() => document.querySelectorAll('[data-testid="topic-status"], [data-testid="topic-outcome"], [data-testid="catch-up"]').length === 0);
});

await finish([asha, ben, chidi]);
