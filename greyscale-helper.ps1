# Intention full-screen greyscale helper
# Uses the Windows Magnification API (MagSetFullscreenColorEffect) to apply a
# grayscale color matrix to the ENTIRE screen (all windows, taskbar, desktop).
#
# It runs persistently and reads simple commands from stdin:
#   ON   -> apply full-screen greyscale
#   OFF  -> remove the effect (restore color)
#   EXIT -> remove the effect and quit
#
# The effect is owned by this process, so if the process dies the OS restores
# color automatically (fail-safe: you never get stuck in greyscale).

$ErrorActionPreference = 'Stop'

$typeDef = @"
using System;
using System.Runtime.InteropServices;

public static class Mag
{
    [DllImport("Magnification.dll")]
    public static extern bool MagInitialize();

    [DllImport("Magnification.dll")]
    public static extern bool MagUninitialize();

    [DllImport("Magnification.dll")]
    public static extern bool MagSetFullscreenColorEffect(ref MAGCOLOREFFECT pEffect);

    [StructLayout(LayoutKind.Sequential)]
    public struct MAGCOLOREFFECT
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 25)]
        public float[] transform;
    }

    // Standard luminance-based grayscale color matrix (5x5, row-major)
    public static MAGCOLOREFFECT GrayEffect()
    {
        MAGCOLOREFFECT e = new MAGCOLOREFFECT();
        e.transform = new float[25]
        {
            0.299f, 0.299f, 0.299f, 0.0f, 0.0f,
            0.587f, 0.587f, 0.587f, 0.0f, 0.0f,
            0.114f, 0.114f, 0.114f, 0.0f, 0.0f,
            0.0f,   0.0f,   0.0f,   1.0f, 0.0f,
            0.0f,   0.0f,   0.0f,   0.0f, 1.0f
        };
        return e;
    }

    // Identity matrix = no color change (restores normal color)
    public static MAGCOLOREFFECT IdentityEffect()
    {
        MAGCOLOREFFECT e = new MAGCOLOREFFECT();
        e.transform = new float[25]
        {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f,
            0.0f, 1.0f, 0.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 0.0f, 1.0f, 0.0f,
            0.0f, 0.0f, 0.0f, 0.0f, 1.0f
        };
        return e;
    }
}
"@

Add-Type -TypeDefinition $typeDef -Language CSharp | Out-Null

[Mag]::MagInitialize() | Out-Null

$grayOn = $false

function Set-Gray {
    $e = [Mag]::GrayEffect()
    [Mag]::MagSetFullscreenColorEffect([ref]$e) | Out-Null
}

function Set-Color {
    $e = [Mag]::IdentityEffect()
    [Mag]::MagSetFullscreenColorEffect([ref]$e) | Out-Null
}

# Signal readiness to the parent process
Write-Output "READY"

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }   # stdin closed -> parent gone
        $cmd = $line.Trim().ToUpperInvariant()
        switch ($cmd) {
            'ON'   { Set-Gray;  $grayOn = $true }
            'OFF'  { Set-Color; $grayOn = $false }
            'EXIT' { break }
            default { }
        }
    }
}
finally {
    # Always restore color and clean up so the user is never stuck in greyscale
    try { Set-Color } catch {}
    try { [Mag]::MagUninitialize() | Out-Null } catch {}
}
