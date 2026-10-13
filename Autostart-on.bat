@echo off
rem Starts MAX automatically when you log in to Windows. Run Autostart-off.bat to undo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\shortcut.ps1" -Startup
pause
