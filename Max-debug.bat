@echo off
rem Same as Max.bat but keeps the server console visible, so you can see errors.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\server.ps1"
echo.
echo MAX server stopped. Log: %~dp0data\server.log
pause
