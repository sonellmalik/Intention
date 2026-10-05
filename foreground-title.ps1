# Prints the title of the current foreground window (one line) to stdout.
# Used by Intention to decide whether the chosen work window is active.

$ErrorActionPreference = 'SilentlyContinue'

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinFg
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    public static string GetForegroundTitle()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }
}
"@

Add-Type -TypeDefinition $sig -Language CSharp | Out-Null

[Console]::Out.WriteLine([WinFg]::GetForegroundTitle())
