$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CodexBridgeChromeExtensionWindow
{
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint fromThread, uint toThread, bool attach);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);

    public static string WindowTitle(IntPtr window)
    {
        var text = new StringBuilder(512);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static IntPtr FindLauncherWindow()
    {
        var found = IntPtr.Zero;
        EnumWindows((window, parameter) =>
        {
            if (!IsWindowVisible(window))
            {
                return true;
            }
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            try
            {
                if (!Process.GetProcessById((int)processId).ProcessName.Equals("chrome", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            catch
            {
                return true;
            }
            if (WindowTitle(window).StartsWith("CodexBridge Chrome Extension Installer", StringComparison.Ordinal))
            {
                found = window;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool ForceForeground(IntPtr target)
    {
        uint ignored;
        var currentThread = GetCurrentThreadId();
        var targetThread = GetWindowThreadProcessId(target, out ignored);
        var foreground = GetForegroundWindow();
        var foregroundThread = GetWindowThreadProcessId(foreground, out ignored);
        var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
            AttachThreadInput(currentThread, foregroundThread, true);
        var attachedTarget = targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread &&
            AttachThreadInput(currentThread, targetThread, true);
        try
        {
            ShowWindowAsync(target, 9);
            BringWindowToTop(target);
            SetForegroundWindow(target);
            SetFocus(target);
            Thread.Sleep(220);
            return GetForegroundWindow() == target;
        }
        finally
        {
            if (attachedTarget)
            {
                AttachThreadInput(currentThread, targetThread, false);
            }
            if (attachedForeground)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }

    private static void Key(byte key)
    {
        keybd_event(key, 0, 0, UIntPtr.Zero);
        Thread.Sleep(60);
        keybd_event(key, 0, 2, UIntPtr.Zero);
    }

    private static void ControlKey(byte key)
    {
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        Thread.Sleep(60);
        Key(key);
        Thread.Sleep(60);
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
    }

    public static void NavigateFromClipboard()
    {
        ControlKey(0x4C);
        Thread.Sleep(250);
        ControlKey(0x56);
        Thread.Sleep(250);
        Key(0x0D);
    }
}
'@

$deadline = [DateTime]::UtcNow.AddSeconds(5)
$window = [IntPtr]::Zero
do {
    $window = [CodexBridgeChromeExtensionWindow]::FindLauncherWindow()
    if ($window -ne [IntPtr]::Zero) {
        break
    }
    Start-Sleep -Milliseconds 120
} while ([DateTime]::UtcNow -lt $deadline)

if ($window -eq [IntPtr]::Zero) {
    throw "Chrome launcher window was not found"
}
if (-not [CodexBridgeChromeExtensionWindow]::ForceForeground($window)) {
    throw "Chrome launcher window did not receive foreground focus"
}

[CodexBridgeChromeExtensionWindow]::NavigateFromClipboard()
$navigationDeadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    Start-Sleep -Milliseconds 150
    $title = [CodexBridgeChromeExtensionWindow]::WindowTitle($window)
    if (
        $title -and
        -not $title.StartsWith("CodexBridge Chrome Extension Installer") -and
        $title -notmatch "chrome://extensions"
    ) {
        break
    }
} while ([DateTime]::UtcNow -lt $navigationDeadline)

if (
    -not $title -or
    $title.StartsWith("CodexBridge Chrome Extension Installer") -or
    $title -match "chrome://extensions"
) {
    throw "Chrome extension manager navigation could not be verified"
}

@{
    activated = $true
    navigated = $true
    title = $title
} | ConvertTo-Json -Compress
