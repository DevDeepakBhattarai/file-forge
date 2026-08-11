import { getSelectedFinderItems } from "@raycast/api";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_EXPLORER_SELECTION_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class RaycastExplorerSelectionNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$foreground = [RaycastExplorerSelectionNative]::GetForegroundWindow()
[uint32]$foregroundPid = 0
[void][RaycastExplorerSelectionNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)

$shell = New-Object -ComObject Shell.Application
$explorerByHwnd = @{}
foreach ($window in @($shell.Windows())) {
  try {
    if ($window.FullName -and [IO.Path]::GetFileName($window.FullName) -ieq "explorer.exe") {
      $explorerByHwnd[[long]$window.HWND] = $window
    }
  } catch {}
}

$selectedPaths = @()
$current = $foreground
while ($true) {
  # GW_HWNDNEXT = 2. The first visible window from another app is normally
  # the window that was active immediately before Raycast opened.
  $current = [RaycastExplorerSelectionNative]::GetWindow($current, 2)
  if ($current -eq [IntPtr]::Zero) { break }
  if (-not [RaycastExplorerSelectionNative]::IsWindowVisible($current)) { continue }

  [uint32]$windowPid = 0
  [void][RaycastExplorerSelectionNative]::GetWindowThreadProcessId($current, [ref]$windowPid)
  if ($windowPid -eq $foregroundPid) { continue }

  $key = $current.ToInt64()
  if ($explorerByHwnd.ContainsKey($key)) {
    try {
      $selectedPaths = @($explorerByHwnd[$key].Document.SelectedItems() | ForEach-Object { $_.Path })
    } catch {}
    break
  }

  # Ignore Explorer-owned desktop/taskbar windows; they are not folder windows.
  try {
    if ((Get-Process -Id $windowPid -ErrorAction Stop).ProcessName -ieq "explorer") { continue }
  } catch {}

  # The previous foreground app was not File Explorer, so do not use stale
  # selections from some other Explorer window.
  break
}

[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($selectedPaths)))
`;

async function keepFiles(paths: string[]) {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  const checks = await Promise.all(
    uniquePaths.map(async (filePath) => {
      try {
        return (await stat(filePath)).isFile() ? filePath : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((filePath): filePath is string => Boolean(filePath));
}

async function getWindowsExplorerSelection() {
  if (process.platform !== "win32") return [];

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_EXPLORER_SELECTION_SCRIPT],
      { windowsHide: true, timeout: 3_000, encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Returns files selected in the file manager immediately before Raycast opened.
 * Raycast's native API is preferred. Windows falls back to File Explorer's COM
 * selection because the public API is still documented in Finder-specific terms.
 */
export async function getSelectedFilePaths() {
  try {
    const nativeItems = await getSelectedFinderItems();
    const nativeFiles = await keepFiles(nativeItems.map((item) => item.path));
    if (nativeFiles.length > 0 || process.platform !== "win32") return nativeFiles;
  } catch {
    if (process.platform !== "win32") return [];
  }

  return keepFiles(await getWindowsExplorerSelection());
}
