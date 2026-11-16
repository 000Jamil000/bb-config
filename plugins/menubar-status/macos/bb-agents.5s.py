#!/usr/bin/env python3
# <swiftbar.title>bb agents</swiftbar.title>
# <swiftbar.desc>Agent statuses from bb: who needs you, who is running, last replies.</swiftbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
#
# Reads the status file the bb plugin "menubar-status" keeps on this machine.
# No network and no credentials: the refresh is a local file read.
#
# Layout: one row per agent (state symbol, title, project in grey, age as a
# badge on the right), grouped by state. The last reply is the row's tooltip
# and, wrapped, its submenu, so the list itself stays one line per agent.
import json
import os
import socket
import textwrap
import time

STATUS_FILE = os.environ.get(
    "BB_MENUBAR_STATUS",
    os.path.expanduser("~/Library/Application Support/bb-menubar/status.json"),
)
HOME_DIR = os.path.expanduser("~/Library/Application Support/bb-menubar")
PANEL_PORT = int(os.environ.get("BB_MENUBAR_PORT", "47615"))
STALE_AFTER = 180  # seconds without a rewrite: server down or this Mac was asleep
OPEN_APP = "bash=/usr/bin/open param1=-a param2=bb terminal=false"
GREY = "#8E8E93"
DIM = "\033[38;2;142;142;147m"
RESET = "\033[0m"

# State is told by shape as well as colour.
SYMBOL = {
    "needs": ("exclamationmark.bubble.fill", "#FF9500"),
    "error": ("xmark.octagon.fill", "#FF3B30"),
    "running": ("arrow.triangle.2.circlepath", "#0A84FF"),
    "unread": ("circle.fill", "#34C759"),
    "idle": ("circle", GREY),
}
SECTIONS = (
    ("needs", "ЖДУТ ВАС"),
    ("error", "ОШИБКИ"),
    ("running", "РАБОТАЮТ"),
    ("unread", "НОВЫЕ ОТВЕТЫ"),
    ("idle", "НЕДАВНИЕ"),
)
LABEL = {
    "needs": "Ждёт вашего ответа",
    "error": "Остановился с ошибкой",
    "running": "Работает",
    "unread": "Новый ответ",
    "idle": "Свободен",
}


def clean(text):
    # "|" starts the parameters and a double quote ends a quoted value.
    return str(text or "").replace("|", "¦").replace('"', "”").replace("\n", " ").strip()


def cut(text, width):
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "сейчас"
    if seconds < 3600:
        return f"{seconds // 60} мин"
    if seconds < 86400:
        return f"{seconds // 3600} ч"
    return f"{seconds // 86400} д"


def panel_link():
    """The panel's address when its local helper answers, else None.

    With it, a left click opens the panel and a right click this menu; without
    it, both open this menu.
    """
    try:
        with open(os.path.join(HOME_DIR, "token"), encoding="utf-8") as handle:
            token = handle.read().strip()
        with socket.create_connection(("127.0.0.1", PANEL_PORT), timeout=0.2):
            pass
    except OSError:
        return None
    return f"http://127.0.0.1:{PANEL_PORT}/?t={token}"


def header(parts):
    """The menu bar title: "bb" and one symbol (with a count) per live state."""
    text = " ".join(f":{symbol}:{f' {count}' if count else ''}" for symbol, _, count in parts)
    # sfcolor tints the first symbol, sfcolor2 the second, and so on.
    colours = " ".join(
        f"sfcolor{'' if index == 1 else index}={colour}"
        for index, (_, colour, _) in enumerate(parts, start=1)
    )
    link = panel_link()
    panel = f" href={link} webview=true webvieww=400 webviewh=660" if link else ""
    print(f"bb {text} | {colours} sfsize=13{panel}")


def row(item, now):
    state = item.get("state", "idle")
    symbol, colour = SYMBOL.get(state, SYMBOL["idle"])
    title = cut(clean(item.get("title")), 38)
    project = cut(clean(item.get("project")), 18)
    when = age(now - item.get("updatedAt", 0) / 1000)
    snippet = clean(item.get("snippet"))
    text = f"{title}  {DIM}{project}{RESET}" if project else title
    tooltip = f' tooltip="{cut(snippet, 240)}"' if snippet else ""
    print(
        f'{text} | sfimage={symbol} sfcolor={colour} badge="{when}" ansi=true'
        f" symbolize=false{tooltip} {OPEN_APP}"
    )
    where = " · ".join(part for part in (clean(item.get("project")), clean(item.get("machine"))) if part)
    print(f"--{LABEL.get(state, '')} · {when} | size=12 color={GREY}")
    if where:
        print(f"--{where} | size=12 color={GREY}")
    if snippet:
        print("-----")
        for line in textwrap.wrap(snippet, 58)[:6]:
            print(f"--{line} | size=12 symbolize=false")
    print("-----")
    print(f"--Открыть bb | {OPEN_APP}")
    if item.get("url"):
        print(f"--Открыть тред в браузере | href={item['url']}")


def main():
    try:
        with open(STATUS_FILE, encoding="utf-8") as handle:
            feed = json.load(handle)
    except (OSError, ValueError):
        header([("wifi.slash", GREY, 0)])
        print("---")
        print(f"Нет данных от bb | color={GREY}")
        print(f"Открыть bb | {OPEN_APP}")
        return

    now = time.time()
    stale = now - feed.get("generatedAt", 0) / 1000 > STALE_AFTER
    counts = feed.get("counts", {})
    live = [
        (SYMBOL[state][0], SYMBOL[state][1], counts.get(state, 0))
        for state in ("needs", "error", "running")
        if counts.get(state)
    ]
    if stale:
        header([("wifi.slash", GREY, 0)])
    elif live:
        header(live)
    elif counts.get("unread"):
        header([(SYMBOL["unread"][0], SYMBOL["unread"][1], counts["unread"])])
    else:
        header([("checkmark.circle", GREY, 0)])
    print("---")

    if stale:
        print(f"Нет связи с bb, данные устарели | color=#FF9500 size=12 sfimage=wifi.slash")
        print("---")

    words = [
        f"{label} {counts[state]}"
        for state, label in (("needs", "ждут вас"), ("error", "с ошибкой"), ("running", "работают"), ("unread", "новых ответов"))
        if counts.get(state)
    ]
    print(f"bb · {', '.join(words) if words else 'все агенты свободны'} | size=12 color={GREY}")
    print("---")

    items = feed.get("items", [])
    first = True
    for state, title in SECTIONS:
        group = [item for item in items if item.get("state", "idle") == state]
        if not group:
            continue
        if not first:
            print("---")
        first = False
        print(f"{title} | size=11 color={GREY}")
        for item in group:
            row(item, now)
    if not items:
        print(f"Тредов нет | color={GREY}")

    print("---")
    print(f"Открыть bb | {OPEN_APP} sfimage=macwindow")


main()
