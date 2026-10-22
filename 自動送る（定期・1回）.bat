@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".git" (
    exit /b 1
)
set "PATH=C:\Program Files\Git\cmd;%PATH%"
node scripts/sync-push.mjs --auto
exit /b %ERRORLEVEL%
