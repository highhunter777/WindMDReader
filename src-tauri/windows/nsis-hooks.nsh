; 让 WindMD 出现在“打开方式”和默认应用候选里。
; Tauri 的 APP_ASSOCIATE 只写默认 ProgID/扩展名,不会写 OpenWithProgids;
; 这里只补充候选注册,不修改用户已选的默认应用。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "WindMD.md" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "WindMD.markdown" ""
  WriteRegStr SHCTX "Software\Classes\.mdown\OpenWithProgids" "WindMD.mdown" ""

  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe" "FriendlyAppName" "WindMD"
  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe" "ApplicationCompany" "WindMD"
  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe" "DefaultIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe\SupportedTypes" ".mdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\windmd.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  WriteRegStr SHCTX "Software\RegisteredApplications" "WindMD" "Software\WindMD\Capabilities"
  WriteRegStr SHCTX "Software\WindMD\Capabilities" "ApplicationName" "WindMD"
  WriteRegStr SHCTX "Software\WindMD\Capabilities" "ApplicationDescription" "WindMD Markdown Reader"
  WriteRegStr SHCTX "Software\WindMD\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\WindMD\Capabilities\FileAssociations" ".md" "WindMD.md"
  WriteRegStr SHCTX "Software\WindMD\Capabilities\FileAssociations" ".markdown" "WindMD.markdown"
  WriteRegStr SHCTX "Software\WindMD\Capabilities\FileAssociations" ".mdown" "WindMD.mdown"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "WindMD.md"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "WindMD.markdown"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids" "WindMD.mdown"
  DeleteRegKey SHCTX "Software\Classes\Applications\windmd.exe"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "WindMD"
  DeleteRegKey SHCTX "Software\WindMD\Capabilities"
!macroend
