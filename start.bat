@echo off
setlocal enableextensions
REM ==========================================================================
REM  PocketOffice launcher (v1.0, 2026-07-28)
REM  Opens PocketOffice in Edge or Chrome. No admin rights needed.
REM ==========================================================================

cd /d "%~dp0"

REM --- Find the index.html next to this script ----------------------------
if not exist "index.html" (
  echo [PocketOffice] ERROR: index.html not found next to start.bat
  echo                  Make sure you copied the WHOLE PocketOffice folder.
  echo.
  pause
  exit /b 1
)

REM --- Pick a browser: prefer the default handler, then Edge, then Chrome --
REM  1) Try the default .html association first (covers "open with browser")
start "" "index.html" 2>nul
if %errorlevel%==0 goto :ok

REM  2) Microsoft Edge (ships with Windows 10/11)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "file:///%~dp0index.html"
  goto :ok
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "file:///%~dp0index.html"
  goto :ok
)

REM  3) Google Chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "file:///%~dp0index.html"
  goto :ok
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "file:///%~dp0index.html"
  goto :ok
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "file:///%~dp0index.html"
  goto :ok
)

REM  4) Last resort: tell the user how to open it manually
echo [PocketOffice] Could not find Microsoft Edge or Google Chrome.
echo.
echo  To run PocketOffice manually:
echo    1. Open Microsoft Edge or Google Chrome yourself.
echo    2. Drag this file onto the browser window:
echo       %~dp0index.html
echo    3. Or paste this address into the browser's address bar:
echo       file:///%~dp0index.html
echo.
pause
exit /b 1

:ok
REM Silent success — window closes itself.
endlocal
exit /b 0
