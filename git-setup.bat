@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=C:\Program Files\Git\cmd;%PATH%"

echo Git の名前をこのフォルダ用に設定します（1回だけ）
git config user.name "sasame"
git config user.email "mesio06@gmail.com"
echo.
echo 設定完了：
git config user.name
git config user.email
echo.
pause
