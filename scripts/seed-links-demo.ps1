# WindMD 双链 / 标签演示数据生成脚本
#
# 用法:
#   powershell -NoProfile -File scripts/seed-links-demo.ps1            # 生成演示文档
#   powershell -NoProfile -File scripts/seed-links-demo.ps1 -Clean     # 删除演示文档(移入回收站)
#
# 作用:在 Markdown 库中生成 4 篇互相双链、带 #标签 的演示文档,
# 用于在 WindMD 里查看「双链 / 标签」页签与正文中的 [[链接]]、#标签 渲染。
# 文档写入后约 1 秒(文件监视静默窗)即出现在文件树与索引中。

param(
    [switch]$Clean,
    # 库目录;默认取当前正在使用的库,可用 -Vault 覆盖
    [string]$Vault = 'e:/unityProject/Test/Docs/设计文档/client/content'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Vault)) {
    Write-Host "库目录不存在: $Vault" -ForegroundColor Red
    Write-Host "请用 -Vault <目录> 指定你的 Markdown 库路径。"
    exit 1
}

# 演示文档:文件名 -> 内容。互相 [[链接]] 形成双链网,并覆盖库内既有文档以产生反链。
$docs = [ordered]@{
    'WindMD演示-知识库总览.md' = @'
# WindMD 知识库演示 · 总览

这是一篇**演示文档**,用于展示 WindMD 的双链与标签能力,可随时删除。

## 这个库怎么用

- 阅读入口:[[WindMD演示-阅读笔记]]
- 方法论沉淀:[[WindMD演示-方法论]]
- 标签视图:[[WindMD演示-标签云说明]]
- 库内既有文档:[[资源收集目录专项设计]](打开它可在右侧「双链」页签看到来自本篇的反链)
- 指向不存在文档的示例:[[尚不存在的笔记]](会标记为「未创建」,点击可自动新建)

## 本篇标签

#windmd/演示 #知识库

## 代码块内的写法不应被解析

```markdown
[[这不是链接]] #这不是标签
```

行内代码同样不解析:``[[也不是链接]]``、``#也不是标签``。
'@

    'WindMD演示-阅读笔记.md' = @'
# WindMD 知识库演示 · 阅读笔记

记录型文档的演示。回到总览:[[WindMD演示-知识库总览]]。

## 笔记

- 双链用 `[[文档名]]`,指向不存在的文档时会标记为「未创建」,点击可自动新建
- 别名写法:`[[WindMD演示-方法论|方法论这篇]]`

#windmd/演示 #阅读/笔记
'@

    'WindMD演示-方法论.md' = @'
# WindMD 知识库演示 · 方法论

方法论文档的演示。回到总览:[[WindMD演示-知识库总览]];相关阅读:[[WindMD演示-阅读笔记]]。

## 要点

1. 先有链接,再有结构 —— 不要一上来建复杂目录
2. 标签负责横切,双链负责纵向

#windmd/演示 #知识库/方法论
'@

    'WindMD演示-标签云说明.md' = @'
# WindMD 知识库演示 · 标签云说明

标签聚合的演示。回到总览:[[WindMD演示-知识库总览]]。

## 本篇标签

#windmd/演示 #知识库 #标签

库内其他演示文档共用 `#windmd/演示`,在右侧「标签」页签点它即可看到全部 4 篇。
'@
}

if ($Clean) {
    $removed = 0
    foreach ($name in $docs.Keys) {
        $p = Join-Path $Vault $name
        if (Test-Path -LiteralPath $p) {
            # 移入回收站(与 WindMD 的删除行为一致)
            $shell = New-Object -ComObject Shell.Application
            $folder = $shell.NameSpace((Split-Path -LiteralPath $p))
            $item = $folder.ParseName((Split-Path -LiteralPath $p -Leaf))
            if ($item) { $item.InvokeVerb('delete'); $removed++ }
        }
    }
    Write-Host "已清理 $removed 篇演示文档(在回收站可找回)。" -ForegroundColor Green
    exit 0
}

$created = 0
foreach ($name in $docs.Keys) {
    $p = Join-Path $Vault $name
    if (Test-Path -LiteralPath $p) {
        Write-Host "已存在,跳过: $name"
        continue
    }
    # UTF-8 无 BOM 写入,避免 WindMD 读取时首行出现 BOM 字符
    [System.IO.File]::WriteAllText($p, $docs[$name], (New-Object System.Text.UTF8Encoding($false)))
    $created++
}

Write-Host ""
Write-Host "已生成 $created 篇演示文档到: $Vault" -ForegroundColor Green
Write-Host "在 WindMD 中查看:" -ForegroundColor Cyan
Write-Host "  1. 文件树:约 1 秒后出现 4 篇 'WindMD演示-*' 文档"
Write-Host "  2. 正文:[[WindMD演示-阅读笔记]] 等链接可点击跳转"
Write-Host "  3. 右侧「双链」页签:打开任一演示文档看反链/出链"
Write-Host "  4. 右侧「标签」页签:点 #windmd/演示 看 4 篇聚合"
Write-Host "  5. 打开「资源收集目录专项设计.md」→ 双链页签可看到来自总览的反链"
Write-Host ""
Write-Host "清理: powershell -NoProfile -File scripts/seed-links-demo.ps1 -Clean" -ForegroundColor DarkGray
