// bb Status for Windows: the notification-area counterpart of the macOS menu bar item.
//
// It only reads the files the menubar-status plugin keeps next to it (status.json,
// usage.json) and never calls bb. The icon shows the most urgent agent state and a
// count; a left click opens the panel (panel.html, served by the local helper
// server.py) in an Edge app window; the icon is shown only while BB Desktop runs.
// Built by install.ps1 with the C# compiler that ships with Windows (C# 5).
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
    [STAThread]
    static void Main()
    {
        bool first;
        using (new Mutex(true, "Local\\dev.bb.status", out first))
        {
            if (!first) return;
            Application.EnableVisualStyles();
            Application.Run(new StatusContext());
        }
    }
}

sealed class StatusContext : ApplicationContext
{
    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr handle);

    const int StaleSeconds = 180;
    readonly string dir = Path.GetDirectoryName(Application.ExecutablePath);
    readonly string port = Environment.GetEnvironmentVariable("BB_MENUBAR_PORT") ?? "47615";
    readonly NotifyIcon tray = new NotifyIcon();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    Process helper;
    string drawn = "";
    IntPtr iconHandle = IntPtr.Zero;

    public StatusContext()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Панель агентов", null, delegate { OpenPanel(); });
        menu.Items.Add("Открыть bb", null, delegate { OpenBb(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Скрыть до следующего входа", null, delegate { ExitThread(); });
        tray.ContextMenuStrip = menu;
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenPanel(); };
        timer.Interval = 2000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();
        Refresh();
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        tray.Visible = false;
        tray.Dispose();
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
        if (!running) { tray.Visible = false; return; }
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

    // --- actions ----------------------------------------------------------

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

    void OpenPanel()
    {
        try
        {
            string url = "http://127.0.0.1:" + port + "/?t=" + File.ReadAllText(Path.Combine(dir, "token")).Trim();
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            int width = Math.Min(860, area.Width - 24), height = Math.Min(700, area.Height - 24);
            string edge = null;
            foreach (string root in new[] { Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles") })
            {
                string candidate = root == null ? null : Path.Combine(root, "Microsoft\\Edge\\Application\\msedge.exe");
                if (candidate != null && File.Exists(candidate)) { edge = candidate; break; }
            }
            if (edge == null) { Process.Start(url); return; }
            var start = new ProcessStartInfo(edge, "--app=" + url + " --window-size=" + width + "," + height +
                " --window-position=" + (area.Right - width - 12) + "," + (area.Bottom - height - 12));
            start.UseShellExecute = false;
            Process.Start(start);
        }
        catch (Exception error) { tray.ShowBalloonTip(5000, "bb Status", "Панель не открылась: " + error.Message, ToolTipIcon.Warning); }
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
