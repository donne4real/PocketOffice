@echo off
REM ============================================================
REM  Add "Open with PocketOffice" to the .html right-click menu.
REM  Run this once as Administrator. To remove, run uninstall.reg.
REM ============================================================

echo.
echo  Adding "Open with PocketOffice" to the context menu...
echo.

REM Get the folder this script is in
set "FOLDER=%~dp0"

REM Add the context menu entry for .html files
reg add "HKCR\htmlfile\shell\PocketOffice" /ve /d "Open with PocketOffice" /f
reg add "HKCR\htmlfile\shell\PocketOffice\command" /ve /d "\"%FOLDER%start.bat\" \"%%1\"" /f

echo.
echo  Done! Right-click any .html file and choose "Open with PocketOffice".
echo.
pause