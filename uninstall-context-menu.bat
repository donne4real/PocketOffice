@echo off
REM ============================================================
REM  Remove "Open with PocketOffice" from the .html right-click menu.
REM ============================================================

echo.
echo  Removing "Open with PocketOffice" from the context menu...
echo.

reg delete "HKCR\htmlfile\shell\PocketOffice" /f

echo.
echo  Done.
echo.
pause