@echo off
setlocal
cd /d "%~dp0"

set PORT=8765

where py >nul 2>&1
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:%PORT%/"
  py -3 -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)

where python >nul 2>&1
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:%PORT%/"
  python -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)

echo.
echo Python 3 was not found.
echo Install Python or run any static HTTP server in this folder.
echo.
pause
