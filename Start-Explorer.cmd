@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Tools\explorer.ps1" -Task Dev
if errorlevel 1 pause
