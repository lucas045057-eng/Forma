@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0desktop\bin\Forma.exe" (
  node "%~dp0scripts\desktop\cli.mjs" build
)
start "" "%~dp0desktop\bin\Forma.exe" %*
