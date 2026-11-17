// bb Status for Windows: the counterpart of the macOS menu bar item.
//
// It only reads the files the menubar-status plugin keeps next to it (status.json,
// usage.json) and never calls bb. What it shows, chosen by the one-word file "ui":
//   strip (default)  a strip on the taskbar itself, at its left end where Windows
//                    puts the weather: the agents by state and every account's
//                    limits, always in view, like the title in the macOS menu bar;
//   tray             a notification-area icon with the most urgent state and a count;
//   both             both.
// Pointing at either opens the panel (panel.html, served by the local helper
// server.py) above the taskbar; it hides when the pointer leaves; a click pins it,
// a second click hides it; a right click opens the menu. Everything is shown only
// while BB Desktop runs. Built by install.ps1 with the C# compiler that ships with
// Windows (C# 5).
//
// Windows 11 has no place for third-party taskbar content, so the strip is a small
// borderless window kept above the taskbar; it steps aside for full-screen windows.
// Windows also has no web view that a plain .NET Framework program can host, so
// the panel is an Edge app window of its own profile (<folder>\edge-profile): this
// program owns that process, places its window and shows or hides it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Native
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetStyle(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetStyle(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr item);
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screen, ref Point position, ref Size size, IntPtr source, ref Point origin, int key, ref Blend blend, int flags);
    [StructLayout(LayoutKind.Sequential)] public struct Bounds { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct Blend { public byte Op, Flags, Alpha, Format; }
    public static readonly IntPtr Topmost = new IntPtr(-1);
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Native.SetProcessDPIAware();   // real pixels: everything is placed against the taskbar
        bool first;
        using (new Mutex(true, "Local\\dev.bb.status", out first))
        {
            if (!first) return;
            Application.EnableVisualStyles();
            // --self-test: show the strip and the panel once, write what happened to self-test.log, exit.
            Application.Run(new StatusContext(args.Length > 0 && (args[0] == "--self-test" || args[0] == "--panel-test")));
        }
    }
}

/** One account's limits as the plugin wrote them. */
sealed class Account
{
    public string Provider = "";
    public int FiveHour = -1, Week = -1;
    public DateTime? FiveHourReset, WeekReset;
}

/** What is shown: agents by state and the accounts. */
sealed class Model
{
    public bool Stale;
    public int Needs, Working, Errors, Unread;
    public List<Account> Accounts = new List<Account>();
}

/** The window on the taskbar: drawn into a bitmap with its own transparency. */
sealed class Strip : Form
{
    public Strip()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x80000 | 0x80 | 0x08000000 | 0x8;   // layered, tool window, never activated, topmost
            return p;
        }
    }

    /** Shows the picture at the given screen position; the picture's alpha is the window's shape. */
    public void Present(Bitmap picture, Point at)
    {
        IntPtr screen = Native.GetDC(IntPtr.Zero), memory = Native.CreateCompatibleDC(screen);
        IntPtr bitmap = picture.GetHbitmap(Color.FromArgb(0)), previous = Native.SelectObject(memory, bitmap);
        try
        {
            Size size = picture.Size;
            Point origin = Point.Empty;
            var blend = new Native.Blend { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
            Native.UpdateLayeredWindow(Handle, screen, ref at, ref size, memory, ref origin, 0, ref blend, 2);
        }
        finally
        {
            Native.SelectObject(memory, previous);
            Native.DeleteObject(bitmap);
            Native.DeleteDC(memory);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

sealed class StatusContext : ApplicationContext
{
    const int StaleSeconds = 180;
    const int PanelWidth = 860, PanelHeight = 700;
    const int LeaveDelayMs = 450;            // the pointer may cross the gap between strip and panel
    const int PanelIdleMinutes = 5;          // a hidden panel is closed after this to free memory
    static readonly Color Orange = Color.FromArgb(245, 158, 11), Red = Color.FromArgb(239, 68, 68),
        Blue = Color.FromArgb(59, 130, 246), Green = Color.FromArgb(34, 197, 94), Grey = Color.FromArgb(120, 120, 120);

    readonly string dir = Path.GetDirectoryName(Application.ExecutablePath);
    readonly string port = Environment.GetEnvironmentVariable("BB_MENUBAR_PORT") ?? "47615";
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Strip strip = new Strip();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer pointer = new System.Windows.Forms.Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly bool test;
    readonly bool useStrip, useTray;
    Model model = new Model { Stale = true };
    Process helper;
    Process panel;
    IntPtr styled = IntPtr.Zero;
    bool wanted, pinned, hovered, stripShown;
    Rectangle anchor;                        // what the panel hangs over: the strip or the tray icon
    DateTime outsideSince = DateTime.MinValue, hiddenSince = DateTime.MinValue, testStarted;
    string trayDrawn = "", stripDrawn = "";
    IntPtr iconHandle = IntPtr.Zero;
    int ticks;

    public StatusContext(bool test)
    {
        this.test = test;
        testStarted = DateTime.UtcNow;
        string ui = "strip";
        try { ui = File.ReadAllText(Path.Combine(dir, "ui")).Trim().ToLowerInvariant(); } catch (Exception) { }
        useStrip = ui != "tray";
        useTray = ui == "tray" || ui == "both";

        menu.Items.Add("Панель агентов", null, delegate { pinned = true; ShowPanel(); });
        menu.Items.Add("Открыть bb", null, delegate { OpenBb(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Скрыть до следующего входа", null, delegate { ExitThread(); });
        tray.ContextMenuStrip = menu;
        // Pointing opens, like the menu bar item; a click pins the panel or, when pinned, hides it.
        tray.MouseMove += delegate { Point p = Cursor.Position; anchor = new Rectangle(p.X - 20, p.Y - 20, 40, 40); Pointed(); };
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Clicked(); };
        strip.MouseMove += delegate { anchor = strip.Bounds; if (!hovered) { hovered = true; stripDrawn = ""; DrawStrip(); } Pointed(); };
        strip.MouseLeave += delegate { hovered = false; stripDrawn = ""; DrawStrip(); };
        strip.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) Clicked();
            else if (e.Button == MouseButtons.Right) menu.Show(Cursor.Position);
        };
        timer.Interval = 2000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();
        pointer.Interval = 150;
        pointer.Tick += delegate { TrackPointer(); if (++ticks % 7 == 0) KeepStripOnTop(); };
        pointer.Start();
        Refresh();
        if (test) { pinned = true; if (anchor.IsEmpty) { Rectangle area = Screen.PrimaryScreen.WorkingArea; anchor = new Rectangle(area.Right - 60, area.Bottom, 40, 40); } ShowPanel(); }
    }

    void Pointed() { outsideSince = DateTime.MinValue; if (!wanted) ShowPanel(); }

    void Clicked() { pinned = !pinned; if (pinned) ShowPanel(); else HidePanel(); }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        pointer.Stop();
        tray.Visible = false;
        tray.Dispose();
        strip.Hide();
        strip.Dispose();
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

    static string Text(IDictionary<string, object> map, string key)
    {
        object value;
        return map != null && map.TryGetValue(key, out value) ? value as string : null;
    }

    Model Load()
    {
        var result = new Model();
        var feed = Read("status.json");
        object raw;
        var counts = feed != null && feed.TryGetValue("counts", out raw) ? raw as Dictionary<string, object> : null;
        double generated = feed != null && feed.ContainsKey("generatedAt") ? Convert.ToDouble(feed["generatedAt"]) : 0;
        result.Stale = feed == null || (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - generated > StaleSeconds * 1000;
        result.Needs = Number(counts, "needs"); result.Working = Number(counts, "running");
        result.Errors = Number(counts, "error"); result.Unread = Number(counts, "unread");

        var usage = Read("usage.json");
        object accounts;
        if (usage == null || !usage.TryGetValue("accounts", out accounts) || !(accounts is IEnumerable)) return result;
        foreach (object item in (IEnumerable)accounts)
        {
            var row = item as Dictionary<string, object>;
            object windows;
            if (row == null || !row.TryGetValue("windows", out windows) || !(windows is IEnumerable)) continue;
            var account = new Account { Provider = Text(row, "provider") ?? "" };
            foreach (object window in (IEnumerable)windows)
            {
                var entry = window as Dictionary<string, object>;
                string kind = Text(entry, "kind");
                DateTime parsed;
                DateTime? reset = DateTime.TryParse(Text(entry, "resetsAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed) ? parsed.ToUniversalTime() : (DateTime?)null;
                if (kind == "five-hour" && Number(entry, "usedPercent") >= account.FiveHour) { account.FiveHour = Number(entry, "usedPercent"); account.FiveHourReset = reset; }
                if (kind == "weekly" && Number(entry, "usedPercent") >= account.Week) { account.Week = Number(entry, "usedPercent"); account.WeekReset = reset; }
            }
            if (account.FiveHour >= 0 || account.Week >= 0) result.Accounts.Add(account);
        }
        return result;
    }

    void Refresh()
    {
        // Like the menu bar item: present only while the desktop app runs.
        bool running = Process.GetProcessesByName("bb").Length > 0;
        if (!running && !test) { tray.Visible = false; HideStrip(); ClosePanel(); return; }
        KeepHelper();
        model = Load();
        bool taskbar = useStrip && DrawStrip();
        if (useTray || !taskbar) DrawTray(); else tray.Visible = false;   // no taskbar to sit on: fall back to the icon

        if (panel != null && !wanted && hiddenSince != DateTime.MinValue && (DateTime.UtcNow - hiddenSince).TotalMinutes > PanelIdleMinutes) ClosePanel();
        if (test && (DateTime.UtcNow - testStarted).TotalSeconds > 20) { ReportTest(); ExitThread(); }
    }

    // --- notification-area icon --------------------------------------------

    void DrawTray()
    {
        Color badge; string digit = "";
        if (model.Stale) badge = Grey;
        else if (model.Needs > 0) { badge = Orange; digit = Short(model.Needs); }
        else if (model.Errors > 0) { badge = Red; digit = Short(model.Errors); }
        else if (model.Working > 0) { badge = Blue; digit = Short(model.Working); }
        else if (model.Unread > 0) badge = Green;
        else badge = Color.Empty;

        string text = model.Stale ? "bb: нет свежих данных" : "bb · ждут " + model.Needs + " · работают " + model.Working +
            (model.Errors > 0 ? " · ошибок " + model.Errors : "") + (model.Unread > 0 ? " · новых " + model.Unread : "");
        int five = -1, week = -1;
        foreach (Account account in model.Accounts) { five = Math.Max(five, account.FiveHour); week = Math.Max(week, account.Week); }
        string limits = (five >= 0 ? " · 5ч " + five + "%" : "") + (week >= 0 ? " · нед " + week + "%" : "");
        if ((text + limits).Length <= 63) text += limits;   // NotifyIcon.Text takes at most 63 characters
        if (text.Length > 63) text = text.Substring(0, 63);

        string signature = badge.ToArgb() + "|" + digit;
        if (signature != trayDrawn)
        {
            using (var bitmap = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    using (var back = new SolidBrush(Color.FromArgb(31, 41, 55))) FillRound(g, back, new RectangleF(1, 1, 30, 30), 7);
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
                if (iconHandle != IntPtr.Zero) Native.DestroyIcon(iconHandle);
                iconHandle = handle;
            }
            trayDrawn = signature;
        }
        tray.Text = text;
        tray.Visible = true;
    }

    static string Short(int count) { return count > 9 ? "9+" : count.ToString(); }

    static StringFormat Centered()
    {
        return new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
    }

    static void FillRound(Graphics g, Brush brush, RectangleF r, float radius)
    {
        using (var path = new GraphicsPath())
        {
            float d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            g.FillPath(brush, path);
        }
    }

    // --- taskbar strip ------------------------------------------------------

    static bool Taskbar(out Rectangle bounds)
    {
        bounds = Rectangle.Empty;
        IntPtr bar = Native.FindWindow("Shell_TrayWnd", null);
        Native.Bounds b;
        if (bar == IntPtr.Zero || !Native.IsWindowVisible(bar) || !Native.GetWindowRect(bar, out b)) return false;
        bounds = Rectangle.FromLTRB(b.Left, b.Top, b.Right, b.Bottom);
        // A hidden (auto-hide) or vertical taskbar has no room for a strip.
        return bounds.Width > bounds.Height * 4 && bounds.Top < Screen.PrimaryScreen.Bounds.Bottom - 8;
    }

    /** A window covering the whole screen (a game, a video) is in front: the taskbar is not in view. */
    static bool FullScreenInFront()
    {
        IntPtr front = Native.GetForegroundWindow();
        Native.Bounds b;
        if (front == IntPtr.Zero || !Native.GetWindowRect(front, out b)) return false;
        var name = new StringBuilder(64);
        Native.GetClassName(front, name, name.Capacity);
        string kind = name.ToString();
        if (kind == "Progman" || kind == "WorkerW" || kind == "Shell_TrayWnd") return false;
        Rectangle screen = Screen.FromHandle(front).Bounds;
        return b.Left <= screen.Left && b.Top <= screen.Top && b.Right >= screen.Right && b.Bottom >= screen.Bottom;
    }

    static bool LightTaskbar()
    {
        try { return Convert.ToInt32(Registry.GetValue("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "SystemUsesLightTheme", 0)) == 1; }
        catch (Exception) { return false; }
    }

    static string Until(DateTime? moment)
    {
        if (moment == null) return "";
        TimeSpan left = moment.Value - DateTime.UtcNow;
        if (left.TotalMinutes < 1) return "";
        if (left.TotalHours >= 24) return (int)left.TotalDays + "д " + left.Hours + "ч";
        return left.TotalHours >= 1 ? (int)left.TotalHours + "ч " + left.Minutes + "м" : left.Minutes + "м";
    }

    static string Name(string provider)
    {
        if (provider.StartsWith("claude")) return "Claude";
        if (provider.StartsWith("codex")) return "Codex";
        return provider.Length > 0 ? char.ToUpperInvariant(provider[0]) + provider.Substring(1) : "Аккаунт";
    }

    static Color Level(int percent, Color normal) { return percent >= 100 ? Red : percent >= 90 ? Orange : normal; }

    void HideStrip() { if (stripShown) { strip.Hide(); stripShown = false; stripDrawn = ""; } }

    void KeepStripOnTop()
    {
        if (!useStrip || !stripShown) return;
        if (FullScreenInFront()) { HideStrip(); return; }
        // The taskbar is topmost too and comes forward when it is used.
        Native.SetWindowPos(strip.Handle, Native.Topmost, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }

    /** Draws the strip when what it shows has changed; false when there is no taskbar to put it on. */
    bool DrawStrip()
    {
        Rectangle bar;
        if (!useStrip || !Taskbar(out bar)) { HideStrip(); return false; }
        if (FullScreenInFront() && !test) { HideStrip(); return true; }
        float s;
        using (var probe = Graphics.FromHwnd(IntPtr.Zero)) s = probe.DpiX / 96f;
        bool light = LightTaskbar();
        Color ink = light ? Color.FromArgb(235, 0, 0, 0) : Color.White;
        Color dim = Color.FromArgb(light ? 150 : 165, ink);

        var signature = new StringBuilder();
        signature.Append(bar).Append(light).Append(hovered).Append(pinned).Append(model.Stale).Append(model.Needs).Append('/').Append(model.Working)
            .Append('/').Append(model.Errors).Append('/').Append(model.Unread);
        foreach (Account a in model.Accounts) signature.Append('|').Append(a.Provider).Append(a.FiveHour).Append('/').Append(a.Week).Append(Until(a.FiveHourReset)).Append(Until(a.WeekReset));
        string wantedPicture = signature.ToString();
        if (wantedPicture == stripDrawn && stripShown) return true;

        int height = bar.Height;
        using (var small = new Font("Segoe UI", 10.5f * s, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var strong = new Font("Segoe UI", 12.5f * s, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var canvas = new Bitmap(Math.Max(64, bar.Width / 2), height, PixelFormat.Format32bppArgb))
        {
            float x;
            using (var g = Graphics.FromImage(canvas))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAlias;   // grey antialiasing: ClearType needs an opaque background
                float top = height / 2f - 15 * s, bottom = height / 2f + 1 * s, gap = 14 * s;
                x = 10 * s;

                // The logo with the most urgent state as a dot, as in the notification area.
                float box = 26 * s, logoTop = (height - box) / 2f;
                using (var back = new SolidBrush(light ? Color.FromArgb(31, 41, 55) : Color.FromArgb(70, 82, 104))) FillRound(g, back, new RectangleF(x, logoTop, box, box), 6 * s);
                using (var font = new Font("Segoe UI", 13f * s, FontStyle.Bold, GraphicsUnit.Pixel)) g.DrawString("bb", font, Brushes.White, new RectangleF(x, logoTop - 1 * s, box, box), Centered());
                x += box + 10 * s;

                // Agents: one coloured count per state that has any.
                x = Pair(g, small, strong, dim, x, top, bottom, "Агенты", delegate(float at)
                {
                    if (model.Stale) return Word(g, strong, dim, at, bottom, "нет данных");
                    float start = at;
                    at = Count(g, strong, ink, Orange, at, bottom, s, model.Needs, "ждут");
                    at = Count(g, strong, ink, Red, at, bottom, s, model.Errors, "ошибки");
                    at = Count(g, strong, ink, Blue, at, bottom, s, model.Working, "в работе");
                    at = Count(g, strong, ink, Green, at, bottom, s, model.Unread, "новые");
                    return at == start ? Word(g, strong, dim, at, bottom, "тихо") : at - 8 * s;
                }) + gap;

                // Every account: its limits as a bar and a percent, then when the tighter one resets.
                foreach (Account account in model.Accounts)
                {
                    using (var line = new Pen(Color.FromArgb(light ? 40 : 55, ink), 1)) g.DrawLine(line, x - gap / 2, height * 0.26f, x - gap / 2, height * 0.74f);
                    Account current = account;
                    x = Pair(g, small, strong, dim, x, top, bottom, Name(current.Provider), delegate(float at)
                    {
                        if (current.FiveHour >= 0) at = Limit(g, small, strong, ink, dim, at, bottom, s, "5ч", current.FiveHour) + 10 * s;
                        if (current.Week >= 0) at = Limit(g, small, strong, ink, dim, at, bottom, s, "нед", current.Week) + 10 * s;
                        string reset = Until(current.FiveHour >= 0 && (current.FiveHour >= current.Week || current.Week < 100) ? current.FiveHourReset : current.WeekReset);
                        return reset.Length > 0 ? Word(g, small, dim, at, bottom + 2 * s, "↻ " + reset) : at - 10 * s;
                    }) + gap;
                }
                x = x - gap + 12 * s;
            }

            int width = Math.Min(canvas.Width, (int)Math.Ceiling(x));
            using (var picture = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(picture))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    // Almost invisible everywhere, so the whole strip takes the pointer; a soft plate when pointed at or pinned.
                    using (var plate = new SolidBrush(Color.FromArgb(hovered || pinned ? (light ? 26 : 34) : 1, ink))) FillRound(g, plate, new RectangleF(2 * s, 4 * s, width - 4 * s, height - 8 * s), 6 * s);
                    g.DrawImageUnscaled(canvas, 0, 0);
                }
                var at = new Point(bar.Left + (int)(6 * s), bar.Top);
                strip.Bounds = new Rectangle(at, picture.Size);
                if (!stripShown) { strip.Show(); stripShown = true; }
                strip.Present(picture, at);
            }
        }
        stripDrawn = wantedPicture;
        return true;
    }

    /** A small caption above, content drawn by `below` under it; returns where the wider of the two ends. */
    static float Pair(Graphics g, Font small, Font strong, Color dim, float x, float top, float bottom, string caption, Func<float, float> below)
    {
        using (var brush = new SolidBrush(dim)) g.DrawString(caption, small, brush, x - 2, top);
        float captionEnd = x + g.MeasureString(caption, small).Width;
        return Math.Max(captionEnd, below(x));
    }

    static float Word(Graphics g, Font font, Color color, float x, float y, string text)
    {
        using (var brush = new SolidBrush(color)) g.DrawString(text, font, brush, x - 2, y - 1);
        return x + g.MeasureString(text, font).Width - 3;
    }

    static float Count(Graphics g, Font font, Color ink, Color dot, float x, float y, float s, int count, string word)
    {
        if (count <= 0) return x;
        using (var brush = new SolidBrush(dot)) g.FillEllipse(brush, x, y + 5 * s, 8 * s, 8 * s);
        return Word(g, font, ink, x + 12 * s, y, count + " " + word) + 8 * s;
    }

    static float Limit(Graphics g, Font small, Font strong, Color ink, Color dim, float x, float y, float s, string label, int percent)
    {
        x = Word(g, small, dim, x, y + 2 * s, label) + 3 * s;
        float width = 30 * s, thick = 5 * s, barTop = y + 7 * s;
        using (var track = new SolidBrush(Color.FromArgb(60, ink))) FillRound(g, track, new RectangleF(x, barTop, width, thick), thick / 2);
        float filled = Math.Max(thick, width * Math.Min(100, Math.Max(0, percent)) / 100f);
        if (percent > 0) using (var fill = new SolidBrush(Level(percent, ink))) FillRound(g, fill, new RectangleF(x, barTop, filled, thick), thick / 2);
        return Word(g, strong, Level(percent, ink), x + width + 5 * s, y, percent + "%");
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

    /** Where the panel goes: above the taskbar, over what was pointed at, inside the screen. */
    Rectangle Place()
    {
        Rectangle area = Screen.FromRectangle(anchor).WorkingArea;
        float scale;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
        int width = Math.Min((int)(PanelWidth * scale), area.Width - 16), height = Math.Min((int)(PanelHeight * scale), area.Height - 16);
        int centre = anchor.Left + anchor.Width / 2;
        int x = Math.Max(area.Left + 8, Math.Min(centre - width / 2, area.Right - width - 8));
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
            Native.ShowWindow(window, 0);
            Native.SetStyle(window, -20, new IntPtr(Native.GetStyle(window, -20).ToInt64() | 0x80));
            styled = window;
        }
        Rectangle at = Place();
        Native.SetWindowPos(window, Native.Topmost, at.X, at.Y, at.Width, at.Height, 0x0040 | (pinned ? 0u : 0x0010u));   // show; do not take focus when only pointed at
        if (pinned) Native.SetForegroundWindow(window);
    }

    void HidePanel()
    {
        wanted = false;
        pinned = false;
        hiddenSince = DateTime.UtcNow;
        IntPtr window = PanelWindow();
        if (window != IntPtr.Zero) Native.ShowWindow(window, 0);
        stripDrawn = "";
        DrawStrip();
    }

    void ClosePanel()
    {
        wanted = false;
        pinned = false;
        try { if (panel != null && !panel.HasExited) { panel.CloseMainWindow(); if (!panel.WaitForExit(1500)) panel.Kill(); } } catch (Exception) { }
        panel = null;
    }

    /** Hides a panel that was only pointed at, soon after the pointer has left both it and its anchor. */
    void TrackPointer()
    {
        if (!wanted) return;
        IntPtr window = PanelWindow();
        if (window == IntPtr.Zero) { if (panel == null) wanted = false; return; }   // closed by the user, or still starting
        if (styled != window || !Native.IsWindowVisible(window)) { Arrange(); return; }
        if (pinned) return;
        Native.Bounds b;
        if (!Native.GetWindowRect(window, out b)) return;
        Point p = Cursor.Position;
        var over = Rectangle.FromLTRB(b.Left - 8, b.Top - 8, b.Right + 8, b.Bottom + 8);
        var near = Rectangle.Inflate(anchor, 8, 8);
        // The way between the panel's lower edge and what was pointed at counts as inside.
        var bridge = Rectangle.FromLTRB(Math.Min(b.Left, near.Left), b.Bottom - 8, Math.Max(b.Right, near.Right), Math.Max(b.Bottom, near.Bottom));
        if (over.Contains(p) || near.Contains(p) || bridge.Contains(p)) { outsideSince = DateTime.MinValue; return; }
        if (outsideSince == DateTime.MinValue) { outsideSince = DateTime.UtcNow; return; }
        if ((DateTime.UtcNow - outsideSince).TotalMilliseconds > LeaveDelayMs) HidePanel();
    }

    void ReportTest()
    {
        IntPtr window = PanelWindow();
        var b = new Native.Bounds();
        bool rect = window != IntPtr.Zero && Native.GetWindowRect(window, out b);
        Rectangle at = Place();
        Rectangle bar;
        bool taskbar = Taskbar(out bar);
        File.WriteAllText(Path.Combine(dir, "self-test.log"),
            "ui=" + (useStrip ? "strip" : "") + (useTray ? "+tray" : "") +
            " taskbar=" + taskbar + " strip=" + stripShown + " stripRect=" + strip.Left + "," + strip.Top + "," + strip.Right + "," + strip.Bottom +
            " accounts=" + model.Accounts.Count + " stale=" + model.Stale +
            " panel=" + (window != IntPtr.Zero) + " visible=" + (window != IntPtr.Zero && Native.IsWindowVisible(window)) +
            " toolWindow=" + (window != IntPtr.Zero && (Native.GetStyle(window, -20).ToInt64() & 0x80) != 0) +
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
