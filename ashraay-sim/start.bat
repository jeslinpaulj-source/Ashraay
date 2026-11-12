@echo off
setlocal
title ASHRAAY Hazard Simulator (server)
cd /d "%~dp0"
set "PY="
python --version >nul 2>nul && set "PY=python"
if not defined PY py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo Python 3.9 or newer was not found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
%PY% server.py --open %*
echo.
echo Server stopped.
pause
