# 打包发布版安装器(Windows:NSIS + MSI)。
#
# 背景:tauri-bundler 首次打包要从 GitHub 下载 NSIS / WiX 工具链,而本机
# 直连 github.com 的 release 资源会超时。用 TAURI_BUNDLER_TOOLS_GITHUB_MIRROR
# 走镜像即可;工具链会缓存在 %LOCALAPPDATA%\tauri,之后离线也能打。
#
# 用法:
#   pwsh scripts/bundle-release.ps1              # 正式 release 打包
#   pwsh scripts/bundle-release.ps1 --debug      # debug 打包(快速验证流程)
# 镜像可用环境变量覆盖(网络恢复直连后可置空):
#   $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = ""
$ErrorActionPreference = 'Stop'
Set-Location -Path (Join-Path $PSScriptRoot '..')

if (-not $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR) {
  $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = 'https://gh-proxy.com/'
}
Write-Host "bundler tools mirror: $env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR"

npx tauri build @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n产物:"
Get-ChildItem 'src-tauri/target/release/bundle' -Recurse -Include '*.exe', '*.msi' |
  ForEach-Object { "  $($_.FullName)  ($([math]::Round($_.Length / 1MB, 2)) MB)" }
