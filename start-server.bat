@echo off
rem Start the complete local stack, including the Command Center UI on port 5173.
call "%~dp0start-all.bat"
exit /b %ERRORLEVEL%
