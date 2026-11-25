// Kept to plain C# 5 so make-icon.ps1 can compile it with Add-Type in either PowerShell.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Aether
{
    /// <summary>
    /// The Aether mark: a ring, a core and a swirl on an 18×18 grid. It's the
    /// same drawing as the macOS menu bar item (macos/Sources/Aether/App.swift),
    /// the GNOME top bar icon (gnome-extension/icons/aether-symbolic.svg) and
    /// the favicon of web/aether.html.
    /// </summary>
    public static class Icons
    {
        public static void DrawMark(Graphics g, RectangleF box, Color color)
        {
            GraphicsState saved = g.Save();
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TranslateTransform(box.X, box.Y);
            g.ScaleTransform(box.Width / 18f, box.Height / 18f);
            using (var ring = new Pen(color, 1.4f)) g.DrawEllipse(ring, 2.5f, 2.5f, 13f, 13f);
            using (var core = new SolidBrush(color)) g.FillEllipse(core, 5.5f, 5f, 5f, 5f);
            using (var swirl = new Pen(color, 1.2f)) g.DrawBezier(swirl, 4.5f, 11f, 7f, 14.5f, 12f, 13f, 13.5f, 9f);
            g.Restore(saved);
        }

        /// <summary>The app icon, as the web favicon: a white mark on a black rounded square.</summary>
        public static Bitmap AppImage(int size)
        {
            var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                float r = size * 4f / 18f, d = 2 * r;
                using (var path = new GraphicsPath())
                using (var black = new SolidBrush(Color.Black))
                {
                    path.AddArc(0, 0, d, d, 180, 90);
                    path.AddArc(size - d, 0, d, d, 270, 90);
                    path.AddArc(size - d, size - d, d, d, 0, 90);
                    path.AddArc(0, size - d, d, d, 90, 90);
                    path.CloseFigure();
                    g.FillPath(black, path);
                }
                DrawMark(g, new RectangleF(0, 0, size, size), Color.White);
            }
            return bmp;
        }

        /// <summary>
        /// The tray icon: the mark alone, in the taskbar's text colour, cropped
        /// like the GNOME symbolic icon (viewBox 1 1 16 16). Dimmed while paused.
        /// </summary>
        public static Icon TrayIcon(int size, bool lightTaskbar, bool dim)
        {
            int a = dim ? 115 : 255;
            Color c = lightTaskbar ? Color.FromArgb(a, 0x1c, 0x1c, 0x1c) : Color.FromArgb(a, 255, 255, 255);
            using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    float k = size / 16f;
                    DrawMark(g, new RectangleF(-k, -k, 18 * k, 18 * k), c);
                }
                IntPtr h = bmp.GetHicon();
                try { return (Icon)Icon.FromHandle(h).Clone(); }
                finally { DestroyIcon(h); }
            }
        }

        /// <summary>
        /// Writes a multi-size .ico of <see cref="AppImage"/>: 32-bit DIB entries,
        /// which everything reads, and PNG for 256 px, as Windows expects.
        /// </summary>
        public static void WriteIco(string path, int[] sizes)
        {
            var images = new List<byte[]>();
            foreach (int s in sizes)
                using (Bitmap bmp = AppImage(s))
                using (var ms = new MemoryStream())
                {
                    if (s >= 256) bmp.Save(ms, ImageFormat.Png);
                    else WriteDib(ms, bmp);
                    images.Add(ms.ToArray());
                }
            using (var w = new BinaryWriter(File.Create(path)))
            {
                w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);   // ICONDIR
                int offset = 6 + 16 * sizes.Length;
                for (int i = 0; i < sizes.Length; i++)                                // ICONDIRENTRY
                {
                    w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                    w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                    w.Write((byte)0); w.Write((byte)0);
                    w.Write((short)1); w.Write((short)32);
                    w.Write(images[i].Length);
                    w.Write(offset);
                    offset += images[i].Length;
                }
                foreach (byte[] png in images) w.Write(png);
            }
        }

        // BITMAPINFOHEADER (double height: XOR image + AND mask), bottom-up BGRA rows, then an empty AND mask
        static void WriteDib(Stream s, Bitmap bmp)
        {
            int w = bmp.Width, h = bmp.Height, maskStride = ((w + 31) / 32) * 4;
            var o = new BinaryWriter(s);
            o.Write(40); o.Write(w); o.Write(h * 2); o.Write((short)1); o.Write((short)32);
            o.Write(0); o.Write(w * h * 4 + maskStride * h); o.Write(0); o.Write(0); o.Write(0); o.Write(0);
            for (int y = h - 1; y >= 0; y--)
                for (int x = 0; x < w; x++)
                {
                    Color c = bmp.GetPixel(x, y);
                    o.Write(c.B); o.Write(c.G); o.Write(c.R); o.Write(c.A);
                }
            o.Write(new byte[maskStride * h]);
            o.Flush();
        }

        [DllImport("user32")] static extern bool DestroyIcon(IntPtr icon);
    }
}
