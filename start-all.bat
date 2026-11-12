@echo off
rem Starts the whole ASHRAAY local stack: PostgreSQL, the FastAPI backend, the
rem command-center and mobile-app web servers, and the ashraay-sim hazard simulator, each in its own window.
setlocal enabledelayedexpansion
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  set "PY=%~dp0.venv\Scripts\python.exe"
) else (
  set "PY=python"
)
"%PY%" --version >nul 2>&1 || (
  echo Python was not found. Run install-dependencies.bat first.
  goto :fail
)

"%PY%" -c "import fastapi, uvicorn, asyncpg, sqlalchemy, jwt" >nul 2>&1 || (
  echo Backend dependencies are missing. Run install-dependencies.bat first.
  goto :fail
)

echo.
echo [1/5] Starting PostgreSQL...
"%PY%" database\local-postgres.py start || (
  echo PostgreSQL did not start. See .local-data\postgres.log for the reason.
  goto :fail
)

rem Read the connection string from the private config file without printing the password.
for /f "usebackq delims=" %%U in (`call "%PY%" -c "import json; print(json.load(open(r'.local-data\postgres.json', encoding='utf-8'))['databaseUrl'])"`) do set "DATABASE_URL=%%U"
if not defined DATABASE_URL (
  echo Could not read DATABASE_URL from .local-data\postgres.json.
  goto :fail
)

if not defined CORS_ORIGINS set "CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
rem Loopback only: phones reach the API through the mobile app server's /api proxy. Set WEB_HOST=0.0.0.0 to expose it.
if not defined WEB_HOST set "WEB_HOST=127.0.0.1"
if not defined WEB_PORT set "WEB_PORT=8000"
if not defined ASHRAAY_RESET_ON_START set "ASHRAAY_RESET_ON_START=0"
rem Shared code staff must enter to view a citizen's phone/email in the Command Center.
if not defined ASHRAAY_CITIZEN_ACCESS_CODE set "ASHRAAY_CITIZEN_ACCESS_CODE=47111174"

call :start_if_free %WEB_PORT% "ASHRAAY API" "cd /d ""%~dp0command-center\web-app"" && set ""DATABASE_URL=%DATABASE_URL%"" && set ""CORS_ORIGINS=%CORS_ORIGINS%"" && set ""ASHRAAY_CITIZEN_ACCESS_CODE=%ASHRAAY_CITIZEN_ACCESS_CODE%"" && ""%PY%"" -m uvicorn app.main:app --host %WEB_HOST% --port %WEB_PORT%" "[2/5]"
call :start_if_free 5173 "ASHRAAY Command Center" "cd /d ""%~dp0"" && node command-center\server.js" "[3/5]"
call :start_if_free 5174 "ASHRAAY Mobile App" "cd /d ""%~dp0"" && node mobile-app\server.js" "[4/5]"
call :start_if_free 8080 "ASHRAAY Hazard Simulator" "cd /d ""%~dp0ashraay-sim"" && ""%PY%"" server.py" "[5/5]"

echo.
echo All services launched in separate windows:
echo   API              http://%WEB_HOST%:%WEB_PORT%
echo   Command Center   http://127.0.0.1:5173
echo   Mobile App       http://127.0.0.1:5174
echo   Hazard Simulator http://127.0.0.1:8080
echo Close the individual windows (or Ctrl+C in each) to stop a service.
pause
endlocal & exit /b 0

:start_if_free
set "PORT=%~1"
set "TITLE=%~2"
set "CMDLINE=%~3"
set "STEP=%~4"
netstat -ano | findstr /r /c:"[:.]%PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo %STEP% Port %PORT% is already in use, skipping %TITLE%.
) else (
  echo %STEP% Starting %TITLE% on port %PORT%...
  start "%TITLE%" cmd /k "%CMDLINE%"
)
exit /b 0

:fail
echo.
pause
endlocal & exit /b 1
