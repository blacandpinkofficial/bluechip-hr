@echo off
REM ===========================================================================
REM  PUSH.bat  -  send committed work to GitHub. Double-click it.
REM
REM  Does nothing except push what is already committed. It never commits,
REM  never deletes, never touches the retail repo.
REM ===========================================================================
cd /d "%~dp0"
title Blue Chip HR - push

echo.
echo   Blue Chip HR - pushing to GitHub
echo   ===============================
echo.

if not exist ".git" (
  echo   ERROR: this folder is not a git repository.
  echo.
  pause
  exit /b 1
)

echo   Current branch and commits:
git log --oneline -3
echo.

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo   ERROR: no remote named 'origin' is set.
  echo.
  pause
  exit /b 1
)

echo   Pushing...
echo.
git push -u origin main
set RC=%errorlevel%
echo.

if %RC% NEQ 0 (
  echo   ===========================================================
  echo   PUSH FAILED - exit code %RC%
  echo.
  echo   Nothing is lost. Your commits are safe on this computer.
  echo   Send the message above to Claude.
  echo   ===========================================================
  echo.
  pause
  exit /b %RC%
)

echo   ===========================================================
echo   PUSHED OK
echo.
echo   Next, on the Lightsail box:
echo.
echo     cd /opt/bluechip/app ^&^& git pull ^&^& bash deploy/bootstrap.sh
echo   ===========================================================
echo.
git log --oneline -1
echo.
pause
exit /b 0
