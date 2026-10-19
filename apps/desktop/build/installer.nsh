; Branding and behaviour of the Windows installer (included by electron-builder, see nsis.include).
; Artwork: build/installerSidebar.bmp, uninstallerSidebar.bmp, installerHeader.bmp
; (regenerate with `pnpm --filter @multi-ai-coder/desktop make:installer-art`).

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !define MUI_FINISHPAGE_TITLE "Multi-AI Coder ist installiert"
    !define MUI_FINISHPAGE_TEXT "Beim ersten Start richtet ein Assistent alles Schritt für Schritt ein:$\r$\n$\r$\n•  Orchestrator verbinden (Claude Code oder Codex)$\r$\n•  Hardware prüfen und lokale Modelle wählen$\r$\n•  Workspace und Kostenmodus festlegen$\r$\n•  Funktionstest$\r$\n$\r$\nEs werden keine Projekte oder Daten vorausgefüllt."
  !endif
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Willkommen bei Multi-AI Coder"
  !define MUI_WELCOMEPAGE_TEXT "Die Desktop-IDE, in der ein Premium-Orchestrator (Claude Code oder Codex) lokale Coding-Modelle koordiniert.$\r$\n$\r$\nDieser Assistent installiert Multi-AI Coder ${VERSION}. Projekte, Modelle und Zugänge richtest du danach beim ersten Start ein.$\r$\n$\r$\nKlicke auf „Weiter“, um fortzufahren."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Uninstall: ask whether the app data goes too (never during an update, never in silent mode).
; The user's project folders live elsewhere and are never touched.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Sollen auch die Daten von Multi-AI Coder gelöscht werden?$\r$\n$\r$\nDas umfasst Projektliste, Einstellungen, Verlauf, eigene Skills und Plugins. Bei einer Neuinstallation startet die App dann wieder mit dem Einrichtungsassistenten.$\r$\n$\r$\nDeine Projektordner bleiben in jedem Fall erhalten." /SD IDNO IDYES`
      SetShellVarContext current
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
    ${endIf}
  ${endIf}
!macroend
