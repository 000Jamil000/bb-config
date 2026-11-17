// bb Status for Windows: the notification-area counterpart of the macOS menu bar item.
//
// It only reads the files the menubar-status plugin keeps next to it (status.json,
// usage.json) and never calls bb. The icon shows the most urgent agent state and a
// count. Hovering it opens the panel (panel.html, served by the local helper
// server.py) above the taskbar; the panel hides when the pointer leaves it and the
// icon; a click pins it, a second click hides it. The icon is shown only while BB
// Desktop runs. Built by install.ps1 with the C# compiler that ships with Windows (C# 5).
//
// Windows has no web view that a plain .NET Framework program can host, so the
// panel is an Edge app window of its own profile (<folder>\edge-profile): this
// program owns that process, places its window and shows or hides it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Program
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main(string[] args)
    {
        SetProcessDPIAware();   // real pixels: the panel is placed next to the icon on a scaled display too
        bool first;
        using (new Mutex(true, "Local\\dev.bb.status", out first))
        {
            if (!first) return;
            Application.EnableVisualStyles();
            // --panel-test: show the panel once, write what happened to panel-test.log, exit.
            Application.Run(new StatusContext(args.Length > 0 && args[0] == "--panel-test"));
        }
    }
}

sealed class StatusContext : ApplicationContext
{
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetStyle(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetStyle(IntPtr window, int index, IntPtr value);
    [StructLayout(LayoutKind.Sequential)] struct Bounds { public int Left, Top, Right, Bottom; }

    const int StaleSeconds = 180;
    const int PanelWidth = 860, PanelHeight = 700;
    const int LeaveDelayMs = 450;            // the pointer may cross the gap between icon and panel
    const int PanelIdleMinutes = 5;          // a hidden panel is closed after this to free memory
    static readonly IntPtr Topmost = new IntPtr(-1);

    readonly string dir = Path.GetDirectoryName(Application.ExecutablePath);
    readonly string port = Environment.GetEnvironmentVariable("BB_MENUBAR_PORT") ?? "47615";
    readonly NotifyIcon tray = new NotifyIcon();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer pointer = new System.Windows.Forms.Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly bool test;
    Process helper;
    Process panel;
    IntPtr styled = IntPtr.Zero;
    bool wanted, pinned;
    Point iconPoint;
    DateTime outsideSince = DateTime.MinValue, hiddenSince = DateTime.MinValue, testStarted;
    string drawn = "";
    IntPtr iconHandle = IntPtr.Zero;

    public StatusContext(bool test)
    {
        this.test = test;
        testStarted = DateTime.UtcNow;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Панель агентов", null, delegate { pinned = true; ShowPanel(); });
        menu.Items.Add("Открыть bb", null, delegate { OpenBb(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Скрыть до следующего входа", null, delegate { ExitThread(); });
        tray.ContextMenuStrip = menu;
        // Hover opens, like the menu bar item; a click pins the panel or, when pinned, hides it.
        tray.MouseMove += delegate { iconPoint = Cursor.Position; outsideSince = DateTime.MinValue; if (!wanted) ShowPanel(); };
        tray.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            pinned = !pinned;
            if (pinned) ShowPanel(); else HidePanel();
        };
        timer.Interval = 2000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();
        pointer.Interval = 150;
        pointer.Tick += delegate { TrackPointer(); };
        pointer.Start();
        Refresh();
        if (test) { pinned = true; iconPoint = new Point(Screen.PrimaryScreen.WorkingArea.Right - 40, Screen.PrimaryScreen.WorkingArea.Bottom); ShowPanel(); }
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        pointer.Stop();
        tray.Visible = false;
        tray.Dispose();
        ClosePanel();
        try { if (helper != null && !helper.HasExited) helper.Kill(); } catch (Exception) { }
        base.ExitThreadCore();
    }

    // --- data -------------------------------------------------------------

    Dictionary<string, object> Read(string name)
    {
        try { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dir, name))); }
        catch (Exception) { return null; }
    }

    static int Number(IDictionary<string, object> map, string key)
    {
        object value;
        return map != null && map.TryGetValue(key, out value) && value != null ? Convert.ToInt32(Convert.ToDouble(value)) : 0;
    }

    /** The highest used percent of the given window kind over all accounts, or -1. */
    int Usage(string kind)
    {
        var usage = Read("usage.json");
        object accounts;
        if (usage == null || !usage.TryGetValue("accounts", out accounts) || !(accounts is IEnumerable)) return -1;
        int worst = -1;
        foreach (object account in (IEnumerable)accounts)
        {
            var row = account as Dictionary<string, object>;
            object windows;
            if (row == null || !row.TryGetValue("windows", out windows) || !(windows is IEnumerable)) continue;
            foreach (object window in (IEnumerable)windows)
            {
                var entry = window as Dictionary<string, object>;
                object named;
                if (entry != null && entry.TryGetValue("kind", out named) && (named as string) == kind) worst = Math.Max(worst, Number(entry, "usedPercent"));
            }
        }
        return worst;
    }

    void Refresh()
    {
        // Like the menu bar item: present only while the desktop app runs.
        bool running = Process.GetProcessesByName("bb").Length > 0;
        if (!running && !test) { tray.Visible = false; ClosePanel(); return; }
        KeepHelper();

        var feed = Read("status.json");
        object raw;
        var counts = feed != null && feed.TryGetValue("counts", out raw) ? raw as Dictionary<string, object> : null;
        double generated = feed != null && feed.ContainsKey("generatedAt") ? Convert.ToDouble(feed["generatedAt"]) : 0;
        bool stale = feed == null || (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - generated > StaleSeconds * 1000;
        int needs = Number(counts, "needs"), working = Number(counts, "running"), errors = Number(counts, "error"), unread = Number(counts, "unread");

        Color badge; string digit = "";
        if (stale) badge = Color.FromArgb(120, 120, 120);
        else if (needs > 0) { badge = Color.FromArgb(245, 158, 11); digit = needs > 9 ? "9+" : needs.ToString(); }
        else if (errors > 0) { badge = Color.FromArgb(239, 68, 68); digit = errors > 9 ? "9+" : errors.ToString(); }
        else if (working > 0) { badge = Color.FromArgb(59, 130, 246); digit = working > 9 ? "9+" : working.ToString(); }
        else if (unread > 0) badge = Color.FromArgb(34, 197, 94);
        else badge = Color.Empty;

        string text = stale ? "bb: нет свежих данных" : "bb · ждут " + needs + " · работают " + working + (errors > 0 ? " · ошибок " + errors : "") + (unread > 0 ? " · новых " + unread : "");
        int five = Usage("five-hour"), week = Usage("weekly");
        string limits = (five >= 0 ? " · 5ч " + five + "%" : "") + (week >= 0 ? " · нед " + week + "%" : "");
        if ((text + limits).Length <= 63) text += limits;   // NotifyIcon.Text takes at most 63 characters
        if (text.Length > 63) text = text.Substring(0, 63);

        string signature = badge.ToArgb() + "|" + digit;
        if (signature != drawn) { Draw(badge, digit); drawn = signature; }
        tray.Text = text;
        tray.Visible = true;

        if (panel != null && !wanted && hiddenSince != DateTime.MinValue && (DateTime.UtcNow - hiddenSince).TotalMinutes > PanelIdleMinutes) ClosePanel();
        if (test && (DateTime.UtcNow - testStarted).TotalSeconds > 20) { ReportTest(); ExitThread(); }
    }

    void Draw(Color badge, string digit)
    {
        using (var bitmap = new Bitmap(32, 32))
        {
            using (var g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                using (var back = new SolidBrush(Color.FromArgb(31, 41, 55))) FillRound(g, back, new Rectangle(1, 1, 30, 30), 7);
                using (var font = new Font("Segoe UI", 15f, FontStyle.Bold, GraphicsUnit.Pixel))
                    g.DrawString("bb", font, Brushes.White, new RectangleF(0, badge.IsEmpty ? 5 : 1, 32, 22), Centered());
                if (!badge.IsEmpty)
                {
                    var spot = digit.Length > 0 ? new Rectangle(14, 14, 18, 18) : new Rectangle(20, 20, 11, 11);
                    using (var brush = new SolidBrush(badge)) g.FillEllipse(brush, spot);
                    if (digit.Length > 0)
                        using (var font = new Font("Segoe UI", digit.Length > 1 ? 10f : 13f, FontStyle.Bold, GraphicsUnit.Pixel))
                            g.DrawString(digit, font, Brushes.White, new RectangleF(13, 13, 20, 20), Centered());
                }
            }
            IntPtr handle = bitmap.GetHicon();
            tray.Icon = Icon.FromHandle(handle);
            if (iconHandle != IntPtr.Zero) DestroyIcon(iconHandle);
            iconHandle = handle;
        }
    }

    static StringFormat Centered()
    {
        return new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
    }

    static void FillRound(Graphics g, Brush brush, Rectangle r, int radius)
    {
        using (var path = new GraphicsPath())
        {
            int d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            g.FillPath(brush, path);
        }
    }

    // --- helper -----------------------------------------------------------

    /** The helper serves the panel on loopback; it is started here and restarted if it stops. */
    void KeepHelper()
    {
        try
        {
            if (helper != null && !helper.HasExited) return;
            string python = "python";
            string named = Path.Combine(dir, "python");
            if (File.Exists(named)) python = File.ReadAllText(named).Trim();
            var start = new ProcessStartInfo(python, "-X utf8 \"" + Path.Combine(dir, "server.py") + "\" " + port);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = dir;
            helper = Process.Start(start);
        }
        catch (Exception) { helper = null; }
    }

    // --- panel ------------------------------------------------------------

    static string Edge()
    {
        foreach (string root in new[] { Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles") })
        {
            string candidate = root == null ? null : Path.Combine(root, "Microsoft\\Edge\\Application\\msedge.exe");
            if (candidate != null && File.Exists(candidate)) return candidate;
        }
        return null;
    }

    /** Where the panel goes: above the taskbar, centred on the icon, inside the screen. */
    Rectangle Place()
    {
        Rectangle area = Screen.FromPoint(iconPoint).WorkingArea;
        float scale;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
        int width = Math.Min((int)(PanelWidth * scale), area.Width - 16), height = Math.Min((int)(PanelHeight * scale), area.Height - 16);
        int x = Math.Max(area.Left + 8, Math.Min(iconPoint.X - width / 2, area.Right - width - 8));
        return new Rectangle(x, area.Bottom - height - 8, width, height);
    }

    IntPtr PanelWindow()
    {
        try
        {
            if (panel == null || panel.HasExited) { panel = null; return IntPtr.Zero; }
            panel.Refresh();
            return panel.MainWindowHandle;
        }
        catch (Exception) { return IntPtr.Zero; }
    }

    void ShowPanel()
    {
        wanted = true;
        hiddenSince = DateTime.MinValue;
        try
        {
            if (PanelWindow() == IntPtr.Zero && panel == null)
            {
                string url = "http://127.0.0.1:" + port + "/?t=" + File.ReadAllText(Path.Combine(dir, "token")).Trim();
                string edge = Edge();
                if (edge == null) { Process.Start(url); wanted = false; return; }   // no Edge: the default browser, on demand only
                Rectangle at = Place();
                var start = new ProcessStartInfo(edge, "--app=" + url + " --user-data-dir=\"" + Path.Combine(dir, "edge-profile") + "\"" +
                    " --no-first-run --no-default-browser-check --window-size=" + at.Width + "," + at.Height + " --window-position=" + at.X + "," + at.Y);
                start.UseShellExecute = false;
                panel = Process.Start(start);
                styled = IntPtr.Zero;
            }
            Arrange();
        }
        catch (Exception error) { wanted = false; tray.ShowBalloonTip(5000, "bb Status", "Панель не открылась: " + error.Message, ToolTipIcon.Warning); }
    }

    /** Puts the panel window in place once it exists; called again from the pointer timer until it does. */
    void Arrange()
    {
        IntPtr window = PanelWindow();
        if (window == IntPtr.Zero || !wanted) return;
        if (styled != window)
        {
            // A tool window: no taskbar button and no Alt+Tab entry for a popup.
            ShowWindow(window, 0);
            SetStyle(window, -20, new IntPtr(GetStyle(window, -20).ToInt64() | 0x80));
            styled = window;
        }
        Rectangle at = Place();
        SetWindowPos(window, Topmost, at.X, at.Y, at.Width, at.Height, 0x0040 | (pinned ? 0u : 0x0010u));   // show; do not take focus on hover
        if (pinned) SetForegroundWindow(window);
    }

    void HidePanel()
    {
        wanted = false;
        pinned = false;
        hiddenSince = DateTime.UtcNow;
        IntPtr window = PanelWindow();
        if (window != IntPtr.Zero) ShowWindow(window, 0);
    }

    void ClosePanel()
    {
        wanted = false;
        pinned = false;
        try { if (panel != null && !panel.HasExited) { panel.CloseMainWindow(); if (!panel.WaitForExit(1500)) panel.Kill(); } } catch (Exception) { }
        panel = null;
    }

    /** Hides a hovered panel soon after the pointer has left both it and the icon. */
    void TrackPointer()
    {
        if (!wanted) return;
        IntPtr window = PanelWindow();
        if (window == IntPtr.Zero) { if (panel == null) wanted = false; return; }   // closed by the user, or still starting
        if (styled != window || !IsWindowVisible(window)) { Arrange(); return; }
        if (pinned) return;
        Bounds b;
        if (!GetWindowRect(window, out b)) return;
        Point p = Cursor.Position;
        var over = Rectangle.FromLTRB(b.Left - 8, b.Top - 8, b.Right + 8, b.Bottom + 8);
        // From the panel's lower edge down to the icon, so the way between them counts as inside.
        var bridge = Rectangle.FromLTRB(Math.Min(b.Left, iconPoint.X - 24), b.Bottom - 8, Math.Max(b.Right, iconPoint.X + 24), Math.Max(b.Bottom, iconPoint.Y + 24));
        if (over.Contains(p) || bridge.Contains(p)) { outsideSince = DateTime.MinValue; return; }
        if (outsideSince == DateTime.MinValue) { outsideSince = DateTime.UtcNow; return; }
        if ((DateTime.UtcNow - outsideSince).TotalMilliseconds > LeaveDelayMs) HidePanel();
    }

    void ReportTest()
    {
        IntPtr window = PanelWindow();
        Bounds b = new Bounds();
        bool rect = window != IntPtr.Zero && GetWindowRect(window, out b);
        Rectangle at = Place();
        File.WriteAllText(Path.Combine(dir, "panel-test.log"),
            "window=" + (window != IntPtr.Zero) + " visible=" + (window != IntPtr.Zero && IsWindowVisible(window)) +
            " toolWindow=" + (window != IntPtr.Zero && (GetStyle(window, -20).ToInt64() & 0x80) != 0) +
            " rect=" + (rect ? b.Left + "," + b.Top + "," + b.Right + "," + b.Bottom : "none") +
            " expected=" + at.Left + "," + at.Top + "," + at.Right + "," + at.Bottom +
            " helper=" + (helper != null && !helper.HasExited) + "\r\n");
    }

    static void OpenBb()
    {
        try
        {
            string app = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\bb\\bb.exe");
            if (File.Exists(app)) Process.Start(app);
        }
        catch (Exception) { }
    }
}
