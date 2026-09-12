@echo off
REM ===========================================================================
REM  COMMIT-PUSH.bat  -  every commit after the first one.
REM
REM    COMMIT-PUSH.bat "Phase C - recruiter call screen"
REM
REM  Run with no argument and it asks for the message.
REM  This only touches the Blue Chip repo. It has no connection to Pulse and
REM  cannot deploy anything - deploying happens on the server.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist ".git" (
  echo   This folder is not a git repository yet. Run GIT-INIT.bat first.
  pause
  exit /b 1
)

set "MSG=%~1"
if "%MSG%"=="" (
  echo.
  set /p MSG="  Commit message: "
)
if "!MSG!"=="" (
  echo   No message given. Nothing was committed.
  pause
  exit /b 1
)

echo.
echo   [1/4] staging
git add -A
if errorlevel 1 goto :fail

git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo   Nothing has changed since the last commit.
  echo.
  git log --oneline -3
  echo.
  pause
  exit /b 0
)

echo.
echo   Changes to be committed:
git diff --cached --stat
echo.

echo   [2/4] commit
git commit -m "!MSG!" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
if errorlevel 1 goto :fail

echo   [3/4] checking remote
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo.
  echo   No remote set. Committed locally only. To add it:
  echo       git remote add origin https://github.com/blacandpinkofficial/bluechip-hr.git
  echo       git push -u origin main
  echo.
  pause
  exit /b 0
)

echo   [4/4] push
git push
if errorlevel 1 (
  echo.
  echo   Push failed. The commit is safe locally - nothing is lost.
  echo   If this is the first push, use:  git push -u origin main
  pause
  exit /b 1
)

echo.
echo   ---------------------------------------------------------------
echo   Pushed. To deploy, on the Lightsail box as ubuntu:
echo.
echo       cd /opt/bluechip/app ^&^& bash deploy/bluechip-deploy.sh
echo.
echo   It waits for Pulse's build lock, so it is safe to run even if a
echo   retail deploy is in progress - it queues instead of competing.
echo   ---------------------------------------------------------------
echo.
pause
exit /b 0

:fail
echo.
echo   Something failed above. Nothing was pushed.
pause
exit /b 1
