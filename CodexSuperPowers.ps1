$userProfile = $env:USERPROFILE
$codexDir = Join-Path -Path $userProfile -ChildPath ".codex"
$agentsDir = Join-Path -Path $userProfile -ChildPath ".agents"
$agentsSkillsDir = Join-Path -Path $agentsDir -ChildPath "skills"
$superpowersRepo = Join-Path -Path $codexDir -ChildPath "superpowers"
$superpowersSkills = Join-Path -Path $superpowersRepo -ChildPath "skills"
$symlinkPath = Join-Path -Path $agentsSkillsDir -ChildPath "superpowers"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is required but not found on PATH."
    exit 1
}

foreach ($dir in @($codexDir, $agentsDir, $agentsSkillsDir)) {
    if (-not (Test-Path -Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

if (Test-Path -Path $superpowersRepo) {
    git -C $superpowersRepo pull --ff-only
} else {
    git clone https://github.com/schlenks/superpowers-bd $superpowersRepo
}

if (-not (Test-Path -Path $superpowersSkills)) {
    Write-Error "The skills folder ($superpowersSkills) is missing after cloning."
    exit 1
}

if (Test-Path -Path $symlinkPath) {
    Remove-Item -Path $symlinkPath -Force -Recurse
}

New-Item -ItemType SymbolicLink -Path $symlinkPath -Target $superpowersSkills | Out-Null

Write-Host "Superpowers skills installed at $superpowersRepo and linked to $symlinkPath."
Write-Host "Restart Codex to load the new skills."
