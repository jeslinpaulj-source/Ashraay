@echo off
setlocal
title ASHRAAY Watch (monitor)
cd /d "%~dp0"
rem ---- Address of the simulator (change if you use another port or PC) ----
set "URL=http://localhost:8080"
if not "%~1"=="" set "URL=%~1"
set "PY="
python --version >nul 2>nul && set "PY=python"
if not defined PY py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo Python 3.9 or newer was not found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
%PY% monitor.py --url %URL%
echo.
echo Monitor stopped.
pause
