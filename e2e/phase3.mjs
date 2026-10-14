// Phase 3 walk-through: three people hold interleaved conversations in one group and
// watch them separate into topic lanes; then they correct the assigner.
import { action, check, createGroup, expect, finish, newUser, openChat, row, say, sees } from "./lib.mjs";

const asha = await newUser("Asha");
const ben = await newUser("Ben");
const chidi = await newUser("Chidi");
const people = { asha, ben, chidi };

await createGroup(asha, "Flatmates", [ben.username, chidi.username]);
await openChat(ben, "Flatmates");
await openChat(chidi, "Flatmates");

const chipOf = async (user, text) => {
  const chip = row(user, text).getByTestId("topic-chip");
  await chip.waitFor({ timeout: 5000 });
  return chip.getAttribute("data-topic-id");
};

// Two conversations at once, the way they really arrive.
const script = [
  ["asha", "DINNER", "who's in for dinner on saturday?"],
  ["ben", "DINNER", "me! where though"],
  ["chidi", "HW", "did anyone start the networks assignment"],
  ["asha", "DINNER", "thinking that ramen place near the station"],
  ["ben", "HW", "not yet, isn't the assignment due friday?"],
  ["chidi", "HW", "thursday midnight actually, check the portal"],
  ["ben", "DINNER", "what time for the ramen place"],
  ["asha", "DINNER", "8?"],
  ["ben", "DINNER", "8 works"],
  ["chidi", "HW", "question 3 of the assignment is brutal"],
  ["asha", "HW", "is that the sliding window proof question"],
  ["chidi", "HW", "yes"],
];
const lanes = {};
const latencies = [];

await check("Interleaved messages are delivered at once and each gets a topic chip within about a second", async () => {
  for (const [who, label, text] of script) {
    const sender = people[who];
    const watcher = sender === asha ? ben : asha;
    const t0 = Date.now();
    await say(sender, text);
    await sees(watcher, text);
    const delivered = Date.now() - t0;
    const topicId = await chipOf(watcher, text);
    const labelled = Date.now() - t0;
    latencies.push(labelled);
    expect(delivered < 1000, `"${text}" took ${delivered} ms to be delivered`);
    expect(labelled < 1500, `"${text}" took ${labelled} ms to get its topic`);
    (lanes[label] ??= []).push({ text, topicId });
    await sender.page.waitForTimeout(350); // people do not type at machine speed
  }
  latencies.sort((a, b) => a - b);
  console.log(`        send -> topic chip on another screen: median ${latencies[latencies.length >> 1]} ms, slowest ${latencies.at(-1)} ms`);
});

const main = {}; // label -> the lane holding most of that conversation
await check("The two conversations are kept apart: no lane mixes dinner with the assignment", async () => {
  const describe = (label) => lanes[label].map((m) => `${m.topicId.slice(0, 4)}  ${m.text}`).join("\n          ");
  console.log(`        dinner:\n          ${describe("DINNER")}\n        assignment:\n          ${describe("HW")}`);
  const dinner = new Set(lanes.DINNER.map((m) => m.topicId));
  const hw = new Set(lanes.HW.map((m) => m.topicId));
  const mixed = [...dinner].filter((id) => hw.has(id));
  for (const label of ["DINNER", "HW"]) {
    const counts = {};
    for (const m of lanes[label]) counts[m.topicId] = (counts[m.topicId] ?? 0) + 1;
    main[label] = Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
  }
  const inMain = [...lanes.DINNER, ...lanes.HW].filter((m) => m.topicId === main.DINNER || m.topicId === main.HW).length;
  console.log(`        ${dinner.size + hw.size - mixed.length} lanes for 2 conversations; ${inMain}/${script.length} messages in their conversation's main lane`);
  expect(mixed.length === 0, `${mixed.length} lane(s) contain messages from both conversations`);
  expect(main.DINNER !== main.HW, "both conversations were put in the same lane");
  expect(inMain / script.length >= 0.75, `only ${inMain}/${script.length} messages are in their conversation's main lane`);
});

await check("Correction: a lane the assigner split off is merged back with one action, for everyone", async () => {
  const strays = [...new Set([...lanes.DINNER.filter((m) => m.topicId !== main.DINNER).map((m) => [m.topicId, main.DINNER]), ...lanes.HW.filter((m) => m.topicId !== main.HW).map((m) => [m.topicId, main.HW])].map((x) => x.join(">")))].map((x) => x.split(">"));
  console.log(`        ${strays.length} stray lane(s) to merge`);
  await asha.page.getByTestId("topics-switch").click();
  for (const [from, into] of strays) {
    const target = await asha.page.locator(`[data-testid="topic-row"][data-topic-id="${into}"]`).getByTestId("topic-title").innerText();
    await asha.page.locator(`[data-testid="topic-row"][data-topic-id="${from}"]`).getByRole("button", { name: /^Merge topic/ }).click();
    await asha.page.getByRole("dialog").locator("label").filter({ hasText: target }).click();
    await asha.page.getByRole("button", { name: "Merge", exact: true }).click();
    await asha.page.locator(`[data-testid="topic-row"][data-topic-id="${from}"]`).waitFor({ state: "detached" });
  }
  await asha.page.getByRole("button", { name: "Chat", exact: true }).click();
  for (const label of ["DINNER", "HW"]) for (const m of lanes[label]) m.topicId = main[label];
  // Ben, who did nothing, now sees every message under its conversation's lane.
  for (const label of ["DINNER", "HW"]) {
    for (const m of lanes[label]) expect((await chipOf(ben, m.text)) === main[label], `"${m.text}" is not in its lane after the merge`);
  }
  expect((await asha.page.getByTestId("topics-switch").innerText()).includes("2"), "expected exactly two lanes after the merge");
});

await check("Lanes are shared state: every member sees the same chip on the same message", async () => {
  for (const { text, topicId } of [...lanes.DINNER, ...lanes.HW]) {
    for (const user of [ben, chidi]) expect((await chipOf(user, text)) === topicId, `${user.name} sees a different topic for "${text}"`);
  }
});

await check("The Topics view lists the lanes, and opening one shows only its messages", async () => {
  await chidi.page.getByTestId("topics-switch").click();
  const rows = chidi.page.getByTestId("topic-row");
  await rows.first().waitFor();
  const dinnerId = main.DINNER;
  const dinnerRow = chidi.page.locator(`[data-testid="topic-row"][data-topic-id="${dinnerId}"]`);
  expect((await dinnerRow.getByTestId("topic-count").innerText()) === String(lanes.DINNER.filter((m) => m.topicId === dinnerId).length), "lane count is wrong");
  await dinnerRow.getByRole("button").first().click();
  await chidi.page.getByTestId("lane-header").waitFor();
  await sees(chidi, "8 works");
  const shown = await chidi.page.getByTestId("message").locator(".msg-text").allInnerTexts();
  const expected = lanes.DINNER.filter((m) => m.topicId === dinnerId).map((m) => m.text);
  expect(shown.join("|") === expected.join("|"), `lane shows: ${shown.join(" | ")}`);
});

await check("Sending from inside a lane pins the message to that topic, even off-topic text", async () => {
  await say(chidi, "the assignment portal is down btw");
  await sees(chidi, "the assignment portal is down btw");
  const id = await chipOf(asha, "the assignment portal is down btw");
  expect(id === main.DINNER, "a message sent inside the dinner lane was put elsewhere");
});

await check("Correction: Asha moves that message to the right topic, and it changes for everyone", async () => {
  const hwId = main.HW;
  await action(asha, "the assignment portal is down btw", "More");
  await asha.page.getByRole("button", { name: "Move to topic…" }).click();
  await asha.page.getByRole("dialog", { name: "Move to topic" }).locator("label").filter({ hasText: lanes.HW[0].text.slice(0, 20) }).click();
  await asha.page.getByRole("button", { name: "Move", exact: true }).click();
  await ben.page.locator(`[data-testid="message"]:has-text("the assignment portal is down btw") [data-topic-id="${hwId}"]`).waitFor();
  // Chidi is looking at the dinner lane: the message leaves it.
  await chidi.page.getByTestId("message").filter({ hasText: "the assignment portal is down btw" }).waitFor({ state: "detached" });
});

await check("Correction: a message can be split off into a new, named topic", async () => {
  await say(ben, "unrelated but has anyone seen my blue umbrella");
  await chipOf(asha, "blue umbrella");
  await action(ben, "blue umbrella", "More");
  await ben.page.getByRole("button", { name: "Move to topic…" }).click();
  await ben.page.getByRole("dialog", { name: "Move to topic" }).locator("label").filter({ hasText: "A new topic" }).click();
  await ben.page.getByLabel("New topic name").fill("Lost umbrella");
  await ben.page.getByRole("button", { name: "Move", exact: true }).click();
  await row(asha, "blue umbrella").getByTestId("topic-chip").filter({ hasText: "Lost umbrella" }).waitFor();
});

await check("Correction: renaming a topic updates every chip for everyone", async () => {
  await chidi.page.getByRole("button", { name: "Topics", exact: false }).first().click();
  chidi.page.once("dialog", (d) => d.accept("Saturday dinner"));
  await chidi.page.locator(`[data-testid="topic-row"][data-topic-id="${main.DINNER}"]`).getByRole("button", { name: /^Rename topic/ }).click();
  await row(asha, "8 works").getByTestId("topic-chip").filter({ hasText: "Saturday dinner" }).waitFor();
  await row(ben, "who's in for dinner").getByTestId("topic-chip").filter({ hasText: "Saturday dinner" }).waitFor();
});

await check("Correction: merging two topics moves all the messages and removes the emptied lane", async () => {
  const before = await chidi.page.getByTestId("topic-row").count();
  await chidi.page.getByTestId("topic-row").filter({ hasText: "Lost umbrella" }).getByRole("button", { name: /^Merge topic/ }).click();
  await chidi.page.getByRole("dialog").locator("label").filter({ hasText: "Saturday dinner" }).click();
  await chidi.page.getByRole("button", { name: "Merge", exact: true }).click();
  await row(asha, "blue umbrella").getByTestId("topic-chip").filter({ hasText: "Saturday dinner" }).waitFor();
  await chidi.page.waitForFunction((n) => document.querySelectorAll('[data-testid="topic-row"]').length === n - 1, before);
});

await check("Lanes survive a reload exactly as they were", async () => {
  await ben.page.reload();
  await openChat(ben, "Flatmates");
  await row(ben, "8 works").getByTestId("topic-chip").filter({ hasText: "Saturday dinner" }).waitFor();
  expect((await chipOf(ben, "is that the sliding window proof question")) === main.HW, "assignment lane changed after reload");
});

await finish([asha, ben, chidi]);
