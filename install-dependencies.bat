@echo off
rem Installs everything the ASHRAAY local stack needs: root + agents Node packages,
rem a Python virtual environment, and the FastAPI backend's Python packages.
setlocal
cd /d "%~dp0"

echo.
echo === Checking Node.js ===
where node >nul 2>&1 || (
  echo Node.js was not found on PATH. Install Node.js 18+ from https://nodejs.org and re-run this script.
  goto :fail
)
node --version

echo.
echo === Installing root Node dependencies ===
call npm install || goto :fail

echo.
echo === Installing agents Node dependencies ===
pushd agents
call npm install || (popd & goto :fail)
popd

echo.
echo === Checking Python ===
where python >nul 2>&1 || (
  echo Python was not found on PATH. Install Python 3.11+ from https://python.org and re-run this script.
  goto :fail
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment in .venv ...
  python -m venv .venv || goto :fail
)
set "PY=%~dp0.venv\Scripts\python.exe"
"%PY%" --version

echo.
echo === Installing backend Python dependencies ===
"%PY%" -m pip install --upgrade pip || goto :fail
"%PY%" -m pip install -r command-center\web-app\requirements.txt || goto :fail

echo.
echo All dependencies installed successfully.
echo Run start-all.bat to launch the database, API, and the three web apps.
pause
endlocal & exit /b 0

:fail
echo.
echo Dependency installation failed. See the error above.
pause
endlocal & exit /b 1
