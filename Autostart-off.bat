@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\shortcut.ps1" -Startup -Remove
pause
