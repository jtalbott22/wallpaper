using System.Text.Json;
using Microsoft.Win32;

namespace Aether;

/// <summary>Saved in %APPDATA%\Aether\settings.json.</summary>
sealed class Settings
{
    public double Brightness { get; set; } = 1.0;   // 0.05–1.5, as the page's level
    public bool Paused { get; set; }                // paused from the tray
    public string? Scene { get; set; }              // null: cycle through all scenes
    public string Quality { get; set; } = "balanced"; // saver, balanced, high or max
    public bool MathOnStart { get; set; } = true;    // show a scene's math when it starts
    public List<string> Skip { get; set; } = new();  // scene keys left out of the rotation
    public int BatteryFps { get; set; } = 20;        // frame rate cap on battery, 0 for none

    public static readonly string[] Qualities = { "saver", "balanced", "high", "max" };

    public static readonly string Folder =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Aether");
    static readonly string FilePath = Path.Combine(Folder, "settings.json");
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static Settings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings();
                s.Brightness = Math.Clamp(double.IsFinite(s.Brightness) ? s.Brightness : 1, 0.05, 1.5);
                if (!Qualities.Contains(s.Quality)) s.Quality = "balanced";
                s.Skip = (s.Skip ?? new()).Where(k => !string.IsNullOrWhiteSpace(k))
                    .Select(k => k.Trim().ToLowerInvariant()).Distinct().ToList();
                s.BatteryFps = Math.Clamp(s.BatteryFps, 0, 60);
                return s;
            }
        }
        catch (Exception e) { Log.Write("settings: " + e.Message); }
        return new Settings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Folder);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
            File.Move(tmp, FilePath, true);
        }
        catch (Exception e) { Log.Write("settings: " + e.Message); }
    }
}

/// <summary>"Start at login", through the HKCU Run key.</summary>
static class Startup
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "Aether";
    static string Command => $"\"{Environment.ProcessPath}\"";

    public static bool Enabled
    {
        get
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey);
            return string.Equals(k?.GetValue(Name) as string, Command, StringComparison.OrdinalIgnoreCase);
        }
        set
        {
            using var k = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) k.SetValue(Name, Command);
            else k.DeleteValue(Name, false);
        }
    }
}

/// <summary>A small rolling log in %LOCALAPPDATA%\Aether\aether.log.</summary>
static class Log
{
    public static readonly string Folder =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Aether");
    static readonly string FilePath = Path.Combine(Folder, "aether.log");
    static readonly object Gate = new();

    public static void Write(string line)
    {
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                var fi = new FileInfo(FilePath);
                if (fi.Exists && fi.Length > 512 * 1024) File.Move(FilePath, FilePath + ".old", true);
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}  {line}{Environment.NewLine}");
            }
            catch { }
        }
    }
}
