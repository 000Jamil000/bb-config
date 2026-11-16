import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeed, oneLine, sameContent, stateOf, type FeedThread } from "./feed.ts";

const thread = (over: Partial<FeedThread>): FeedThread => ({
  id: "t", projectId: "p", title: "T", status: "idle", updatedAt: 1, ...over,
});

test("state: pending beats running, unread needs newer attention", () => {
  assert.equal(stateOf(thread({ status: "active", hasPendingInteraction: true })), "needs");
  assert.equal(stateOf(thread({ status: "active" })), "running");
  assert.equal(stateOf(thread({ latestAttentionAt: 5, lastReadAt: 3 })), "unread");
  assert.equal(stateOf(thread({ latestAttentionAt: 5, lastReadAt: 9 })), "idle");
});

test("feed: needs first, children only when they need something, capped", () => {
  const feed = buildFeed({
    threads: [
      thread({ id: "old", updatedAt: 1 }),
      thread({ id: "run", status: "active", updatedAt: 2 }),
      thread({ id: "ask", hasPendingInteraction: true, updatedAt: 0 }),
      thread({ id: "child", parentThreadId: "run", status: "active", updatedAt: 9 }),
    ],
    projectNames: new Map([["p", "proj"]]), machineNames: new Map([["ask", "Mac"]]),
    snippets: { ask: "hi" }, webUrl: "https://x.example/", maxItems: 2, now: 7,
  });
  assert.deepEqual(feed.items.map((item) => item.id), ["ask", "run"]);
  assert.deepEqual(feed.counts, { needs: 1, running: 2, unread: 0, error: 0 });
  assert.equal(feed.items[0]!.url, "https://x.example/projects/p/threads/ask");
  assert.equal(sameContent(feed, { ...feed, generatedAt: 99 }), true);
});

test("oneLine flattens markdown and cuts at a word", () => {
  assert.equal(oneLine("**Done.**\n\n- a\n- b"), "Done. - a - b");
  assert.ok(oneLine("word ".repeat(60), 40).endsWith("…"));
});
