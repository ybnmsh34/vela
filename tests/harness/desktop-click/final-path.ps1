<#
.SYNOPSIS
  Resolves where a path really is, by opening it and asking the kernel.

.DESCRIPTION
  `Test-Path` and `Get-Item` report the path you handed them. Inside an MSIX
  container that is not where the bytes are: a write to `%LOCALAPPDATA%\Foo` can
  be silently redirected into
  `...\Packages\<package>\LocalCache\Local\Foo`, and every path API above the
  filesystem keeps reporting the un-redirected name. `GetFinalPathNameByHandle`
  is below that layer — it takes an open handle and returns the canonical path of
  the object the handle refers to, with reparse points and redirections resolved.

  This is the only way to answer "did the app write to the user's real app-data
  directory, or to a container copy of it" without guessing.

  Output is JSON: the requested path, whether it existed, the final path, and
  whether that final path lies under an MSIX package container.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Path
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VelaFinalPath
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandleW(
        IntPtr hFile, StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public const uint FILE_READ_ATTRIBUTES = 0x0080;
    public const uint FILE_SHARE_ALL = 0x00000007;
    public const uint OPEN_EXISTING = 3;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;  // required for directories

    public static string Resolve(string path, out int error)
    {
        error = 0;
        IntPtr handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero,
                                    OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle == new IntPtr(-1)) { error = Marshal.GetLastWin32Error(); return null; }
        try
        {
            StringBuilder builder = new StringBuilder(1024);
            uint written = GetFinalPathNameByHandleW(handle, builder, (uint)builder.Capacity, 0);
            if (written == 0) { error = Marshal.GetLastWin32Error(); return null; }
            return builder.ToString();
        }
        finally { CloseHandle(handle); }
    }
}
'@

$results = @()
foreach ($item in $Path) {
  $expanded = [System.Environment]::ExpandEnvironmentVariables($item)
  # NOT $error: that is PowerShell's read-only automatic error collection, and
  # binding it here fails at run time with VariableNotWritable.
  $lastError = 0
  $final = [VelaFinalPath]::Resolve($expanded, [ref]$lastError)
  $normalised = $null
  if ($final) { $normalised = $final -replace '^\\\\\?\\', '' }
  $results += [ordered]@{
    requested    = $item
    expanded     = $expanded
    opened       = [bool]$final
    win32Error   = $lastError
    finalPath    = $normalised
    inMsixContainer = [bool]($normalised -and ($normalised -match '\\Packages\\[^\\]+\\LocalCache\\'))
  }
}

ConvertTo-Json -Compress -Depth 6 -InputObject @($results)
