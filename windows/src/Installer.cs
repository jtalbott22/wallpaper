using System.Diagnostics;
using Microsoft.Win32;

namespace Aether;

/// <summary>
/// The single-file Aether.exe (build-exe.ps1) installs itself: run from
/// anywhere else, it offers to copy itself to %LOCALAPPDATA%\Programs\Aether,
/// add a Start menu entry, optionally start at login, and list itself in
/// Settings › Apps, whose Uninstall runs "Aether.exe --uninstall".
/// No installer framework, no admin rights.
/// </summary>
static class Installer
{
    public static readonly string Folder =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Aether");
    public static readonly string Exe = Path.Combine(Folder, "Aether.exe");
    static readonly string Shortcut =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Aether.lnk");
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Aether";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    static string Version => typeof(Installer).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    public static bool RunningInstalled =>
        string.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(Exe), StringComparison.OrdinalIgnoreCase);

    /// <summary>The page built into the exe, unpacked to %LOCALAPPDATA%\Aether\web (rewritten only when it changed).</summary>
    public static string UnpackWeb()
    {
        var dir = Path.Combine(Log.Folder, "web");
        Directory.CreateDirectory(dir);
        var asm = typeof(Installer).Assembly;
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.StartsWith("web/")))
        {
            using var s = asm.GetManifestResourceStream(name)!;
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            var bytes = ms.ToArray();
            var path = Path.Combine(dir, name["web/".Length..]);
            try
            {
                if (!File.Exists(path) || !File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes))
                    File.WriteAllBytes(path, bytes);
            }
            catch (IOException e) { Log.Write($"unpack {name}: {e.Message}"); }
        }
        return dir;
    }

    /// <summary>Asks whether to install; true if it did (and started the installed copy), so this one should exit.</summary>
    public static bool Offer()
    {
        bool update = File.Exists(Exe);
        var install = new TaskDialogButton(update ? "Update" : "Install");
        var justRun = new TaskDialogButton("Just run it");
        var login = new TaskDialogVerificationCheckBox("Start Aether when I sign in", update ? StartsAtLogin : true);
        var page = new TaskDialogPage
        {
            Caption = "Aether",
            Heading = update ? "Update Aether?" : "Install Aether?",
            Text = (update ? "Replace the installed copy with this one. Your settings stay.\n\n" :
                    "Aether shows animated scenes as your desktop wallpaper, behind the icons, on every monitor.\n\n") +
                   $"It installs for you only, in {Folder}, with a Start menu entry. " +
                   "Remove it from Settings › Apps.",
            Icon = TaskDialogIcon.Information,
            Buttons = { install, justRun, TaskDialogButton.Cancel },
            DefaultButton = install,
            Verification = login,
            AllowCancel = true,
        };
        var picked = TaskDialog.ShowDialog(page);
        if (picked == TaskDialogButton.Cancel) Environment.Exit(0);
        if (picked != install) return false;
        try
        {
            Install(login.Checked);
            return true;
        }
        catch (Exception e)
        {
            Log.Write("install: " + e);
            MessageBox.Show($"Aether couldn't be installed.\n\n{e.Message}", "Aether", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    public static void Install(bool startAtLogin)
    {
        Log.Write($"installing {Version} to {Folder}");
        StopOthers();
        // a copy from install.ps1 leaves files (and an older web\) beside the exe: start clean
        if (Directory.Exists(Folder))
            foreach (var entry in new DirectoryInfo(Folder).EnumerateFileSystemInfos())
            {
                if (entry is DirectoryInfo d) d.Delete(true); else entry.Delete();
            }
        Directory.CreateDirectory(Folder);
        File.Copy(Environment.ProcessPath!, Exe, true);

        MakeShortcut();
        using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", "Aether");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("DisplayIcon", $"\"{Exe}\",0");
            k.SetValue("InstallLocation", Folder);
            k.SetValue("UninstallString", $"\"{Exe}\" --uninstall");
            k.SetValue("QuietUninstallString", $"\"{Exe}\" --uninstall --quiet");
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("EstimatedSize", (int)(new FileInfo(Exe).Length / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (startAtLogin) k.SetValue("Aether", $"\"{Exe}\"");
            else k.DeleteValue("Aether", false);
        }
        Log.Write("installed");
        Process.Start(new ProcessStartInfo(Exe) { UseShellExecute = true, WorkingDirectory = Folder });
    }

    public static void Uninstall(bool quiet)
    {
        Log.Write("uninstalling");
        StopOthers();
        using (var k = Registry.CurrentUser.OpenSubKey(RunKey, true)) k?.DeleteValue("Aether", false);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        try { File.Delete(Shortcut); } catch (IOException) { }
        try { Directory.Delete(Path.Combine(Log.Folder, "web"), true); } catch (IOException) { }
        Desktop.Repaint(null);

        if (RunningInstalled)
        {
            // this exe is the one to delete: leave it to cmd once we've exited
            Process.Start(new ProcessStartInfo("cmd.exe",
                $"/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{Folder}\"")
            { CreateNoWindow = true, UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
        }
        else if (Directory.Exists(Folder)) Directory.Delete(Folder, true);
        Log.Write("uninstalled");
        if (!quiet)
            MessageBox.Show($"Aether has been removed.\n\nYour settings stay in {Settings.Folder}.", "Aether",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    static bool StartsAtLogin
    {
        get
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey);
            return k?.GetValue("Aether") is string;
        }
    }

    /// <summary>Close any running Aether (cleanly first, through the --exit signal), so its files can be replaced.</summary>
    static void StopOthers()
    {
        var others = Process.GetProcessesByName("Aether").Where(p => p.Id != Environment.ProcessId).ToList();
        if (others.Count == 0) return;
        using (var exit = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ExitSignalName)) exit.Set();
        foreach (var p in others)
        {
            try { if (!p.WaitForExit(5000)) p.Kill(); p.WaitForExit(2000); }
            catch (Exception e) { Log.Write("stop running copy: " + e.Message); }
        }
    }

    static void MakeShortcut()
    {
        var type = Type.GetTypeFromProgID("WScript.Shell");
        if (type == null) return;
        dynamic shell = Activator.CreateInstance(type)!;
        dynamic lnk = shell.CreateShortcut(Shortcut);
        lnk.TargetPath = Exe;
        lnk.WorkingDirectory = Folder;
        lnk.IconLocation = $"{Exe},0";
        lnk.Description = "Aether animated wallpaper";
        lnk.Save();
    }
}
