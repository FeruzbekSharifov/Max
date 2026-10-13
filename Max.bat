@echo off
rem Starts MAX: a hidden local server + the MAX window. Close the window to stop it.
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0server\server.ps1"
