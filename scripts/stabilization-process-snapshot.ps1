$ErrorActionPreference = 'Stop'
$snapshotName = if ($args.Count) { [string]$args[0] } else { 'stabilization-process-snapshot.json' }
if ($snapshotName -notmatch '^stabilization-[a-z-]+\.json$') { throw 'Invalid snapshot file name.' }
$taskRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$all = @(Get-CimInstance Win32_Process)
$ports = @(Get-NetTCPConnection -State Listen)
$appProcesses = @($all | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskRepo, [StringComparison]::OrdinalIgnoreCase) })
$roots = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'node\s+scripts/dev\.mjs' -and $_.ProcessId -in $appProcesses.ParentProcessId })
$externalIds = New-Object 'System.Collections.Generic.HashSet[int]'
$queue = New-Object 'System.Collections.Generic.Queue[int]'
foreach ($entry in $roots) { $queue.Enqueue([int]$entry.ProcessId) }
while ($queue.Count) {
    $entryId = $queue.Dequeue()
    if (!$externalIds.Add($entryId)) { continue }
    foreach ($child in @($all | Where-Object ParentProcessId -eq $entryId)) { $queue.Enqueue([int]$child.ProcessId) }
}
$external = @($all | Where-Object { $externalIds.Contains([int]$_.ProcessId) } | ForEach-Object {
    $role = $_.Name
    if ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'scripts/dev\.mjs') { $role = 'externally started desktop dev/Vite' }
    if ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'build-main\.mjs.*--watch') { $role = 'external main/preload build watcher' }
    if ($_.Name -eq 'electron.exe') {
        $kind = [regex]::Match([string]$_.CommandLine, '--type=([^ ]+)').Groups[1].Value
        $role = if ($kind) { 'external Electron ' + $kind } else { 'external desktop app main' }
    }
    [pscustomobject]@{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; role=$role; executable=$_.ExecutablePath; createdAt=$_.CreationDate.ToString('o'); workingSetMiB=[math]::Round($_.WorkingSetSize/1MB,1); listeningPorts=@($ports | Where-Object OwningProcess -eq $_.ProcessId | Select-Object -ExpandProperty LocalPort) }
})
$audit = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match '\$trackedText=\$gitProc.StandardOutput.ReadToEnd' -and $_.CommandLine -match 'diff HEAD --binary' -and $_.CommandLine -notmatch 'ReadToEndAsync' } | Select-Object ProcessId,ParentProcessId,ExecutablePath)
$helpers = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and !$externalIds.Contains([int]$_.ProcessId) } | ForEach-Object {
    $encoded = [regex]::Match([string]$_.CommandLine, '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)').Groups[1].Value
    if ($encoded) {
        try { $decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)); if ($decoded.Contains('public static class OwnedProcess')) { [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;executable=$_.ExecutablePath;createdAt=$_.CreationDate.ToString('o')} } } catch {}
    }
})
$result = [pscustomobject]@{
    at=(Get-Date).ToString('o'); externalDevProcesses=$external; blockedAuditProcesses=$audit; remainingOwnJobHelpers=$helpers
    ollama=@($all | Where-Object Name -match '^ollama' | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{Name='workingSetMiB';Expression={[math]::Round($_.WorkingSetSize/1MB,1)}})
    relevantListeners=@($ports | Where-Object { $_.LocalPort -in @(11434,11435,5173,5174,5199) -or $externalIds.Contains([int]$_.OwningProcess) } | Select-Object LocalAddress,LocalPort,OwningProcess)
}
$json = $result | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $taskRepo ('apps/desktop/e2e/results/' + $snapshotName)), $json, (New-Object Text.UTF8Encoding($false)))
Write-Output $json
