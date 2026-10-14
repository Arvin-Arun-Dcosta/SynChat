// Small helpers for driving SynChat in real browsers. Each "user" gets an isolated
// browser context, i.e. a separate session with its own cookies.
import { chromium } from "playwright";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
export const PASSWORD = "correct horse battery";
export const stamp = Date.now().toString(36);

let browser;
const everyone = [];
const reported = new Map();
export async function launch() {
  browser ??= await chromium.launch();
  return browser;
}
export async function shutdown() {
  await browser?.close();
}

export async function newUser(name) {
  const b = await launch();
  const context = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const username = `${name.split(" ")[0]}_${stamp}`.toLowerCase();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${BASE}/signup`);
  await page.fill('input[name="fullName"]', name);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', `${username}@example.com`);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.getByText("Chats", { exact: true }).waitFor();
  const user = { name, username, context, page, errors };
  everyone.push(user);
  return user;
}

export async function startDm(user, otherUsername) {
  await user.page.getByRole("button", { name: "New chat" }).click();
  await user.page.getByLabel("Username", { exact: true }).fill(otherUsername);
  await user.page.getByRole("button", { name: "Start chat" }).click();
  // Wait for the dialog to close: another chat's message box may already be on screen.
  await user.page.getByRole("dialog", { name: "New chat" }).waitFor({ state: "detached" });
  await user.page.getByLabel("Message", { exact: true }).waitFor();
}

export async function createGroup(user, groupName, usernames) {
  await user.page.getByRole("button", { name: "New chat" }).click();
  await user.page.getByRole("tab", { name: "Group" }).click();
  await user.page.getByLabel("Group name").fill(groupName);
  for (const u of usernames) {
    await user.page.getByLabel("Add member by username").fill(u);
    await user.page.getByRole("button", { name: "Add", exact: true }).click();
    await user.page.getByText(`@${u}`).waitFor();
  }
  await user.page.getByRole("button", { name: /^Create group/ }).click();
  await user.page.getByTestId("chat-title").filter({ hasText: groupName }).waitFor();
}

export async function openChat(user, title) {
  await user.page.getByTestId("conversation-row").filter({ hasText: title }).first().click();
  await user.page.getByTestId("chat-title").filter({ hasText: title }).waitFor();
}

export async function say(user, text) {
  const box = user.page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await box.press("Enter");
}

export const messageTexts = (user) => user.page.getByTestId("message").locator(".msg-text").allInnerTexts();

export async function sees(user, text, timeout = 5000) {
  await user.page.getByTestId("message").filter({ hasText: text }).first().waitFor({ timeout });
}

const results = [];
export async function check(label, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  ok    ${label} (${Date.now() - started} ms)`);
    for (const u of everyone) {
      const seen = reported.get(u) ?? 0;
      if (u.errors.length > seen) console.log(`        (browser error for ${u.name} during this step: ${u.errors[seen].slice(0, 160)})`);
      reported.set(u, u.errors.length);
    }
  } catch (err) {
    results.push({ label, ok: false });
    console.log(`  FAIL  ${label}\n        ${String(err.message).split("\n").slice(0, 4).join("\n        ")}`);
  }
}
export function expect(cond, message) {
  if (!cond) throw new Error(message);
}
export async function finish(users = []) {
  for (const u of users) {
    if (u.errors.length) {
      results.push({ label: `no browser errors for ${u.name}`, ok: false });
      console.log(`  FAIL  browser errors for ${u.name}:\n        ${u.errors.slice(0, 5).join("\n        ")}`);
    }
  }
  await shutdown();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

export const row = (user, text) => user.page.getByTestId("message").filter({ hasText: text }).last();

/** Hover a message and press one of its action buttons (React, Reply, More). */
export async function action(user, text, name) {
  const r = row(user, text);
  await r.hover();
  await r.getByRole("button", { name, exact: true }).click();
}

export async function login(username) {
  const b = await launch();
  const context = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.getByText("Chats", { exact: true }).waitFor();
  return { name: username, username, context, page, errors: [] };
}

/** Call the API as this user (same cookies as their browser session). */
export async function apiCall(user, method, path, data) {
  const res = await user.context.request.fetch(`${BASE}/api${path}`, { method, data, headers: { origin: BASE } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
