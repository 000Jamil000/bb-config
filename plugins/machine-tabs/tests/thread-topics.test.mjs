import assert from "node:assert/strict";
import { test } from "node:test";
import { chatCount, matchesFilters, topicForTitle, withAncestors } from "../lib/thread-topics.ts";
test("Russian and English titles receive distinct topics", () => {
  for (const [title, topic] of [
    ["Дизайн формы", "design"],
    ["Repository migration", "migration"],
    ["Подключение к API", "integration"],
    ["Missing chat", "search"], ["Пропали чаты", "search"],
    ["Отчёт за октябрь", "docs"], ["Тесты бэкенда", "code"], ["Привет", "chat"],
  ]) assert.equal(topicForTitle(title).id, topic, title);
});
test("filtered children retain the ancestor path, excluding siblings", () => {
  const threads = [{ id: "root" }, { id: "child", parentThreadId: "root" },
    { id: "leaf", parentThreadId: "child" }, { id: "sibling", parentThreadId: "root" }];
  const matched = new Set(["leaf"]);
  assert.deepEqual([...withAncestors(threads, matched)].sort(), ["child", "leaf", "root"]);
  assert.deepEqual([...matched], ["leaf"]);
});
test("cycles and missing parents cannot hang filtering or invent rows", () => {
  assert.deepEqual([...withAncestors([{ id: "a", parentThreadId: "b" }, { id: "b", parentThreadId: "a" }], new Set(["a"]))], ["a", "b"]);
  assert.deepEqual([...withAncestors([{ id: "a", parentThreadId: "missing" }], new Set(["a"]))], ["a"]);
});

test("topic and project filters must both match", () => {
  assert.equal(matchesFilters("Design notes", "p1", "design", "p1"), true);
  assert.equal(matchesFilters("Design notes", "p2", "design", "p1"), false);
  assert.equal(matchesFilters("Design notes", "p1", "code", "p1"), false);
  assert.equal(matchesFilters("Hello", "p1", "all", "all"), true);
});

test("chat count uses Russian plural forms", () => {
  assert.deepEqual([0, 1, 2, 11, 21, 24].map(chatCount),
    ["0 чатов", "1 чат", "2 чата", "11 чатов", "21 чат", "24 чата"]);
});
