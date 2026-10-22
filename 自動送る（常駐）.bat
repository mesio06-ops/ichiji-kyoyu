@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".git" (
    echo [エラー] このバッチは「一時共有」フォルダ直下で実行してください。
    pause
    exit /b 1
)
set "PATH=C:\Program Files\Git\cmd;%PATH%"
node scripts/sync-auto-watch.mjs
set "EXITCODE=%ERRORLEVEL%"
pause
exit /b %EXITCODE%
