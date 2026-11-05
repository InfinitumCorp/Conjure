# Prompts for your Anthropic API key (input hidden) and saves it to .env,
# which is git-ignored. The key is never printed.
$secure = Read-Host "Paste your Anthropic API key (input hidden)" -AsSecureString
$key = [System.Net.NetworkCredential]::new("", $secure).Password.Trim()
if (-not $key) { Write-Host "No key entered; nothing saved."; exit 1 }
if (-not $key.StartsWith("sk-ant-")) { Write-Host "Warning: key does not start with sk-ant-; saving anyway." }
$envPath = Join-Path $PSScriptRoot ".env"
$text = "ANTHROPIC_API_KEY=$key`n"
[System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Saved to .env. Tell Claude it's done."
