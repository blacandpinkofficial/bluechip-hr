@echo off
REM ===========================================================================
REM  SHIP.bat  -  commit everything and push. Double-click it.
REM
REM  The commit message is read from COMMIT_MSG.txt in this folder, so no
REM  typing is needed. COMMIT_MSG.txt is gitignored - it is a scratch file,
REM  not part of the repo.
REM ===========================================================================
cd /d "%~dp0"
title Blue Chip HR - ship

echo.
echo   Blue Chip HR - commit and push
echo   ==============================
echo.

if not exist ".git" (
  echo   ERROR: not a git repository.
  pause
  exit /b 1
)
if not exist "COMMIT_MSG.txt" (
  echo   ERROR: COMMIT_MSG.txt is missing - nothing to use as a commit message.
  pause
  exit /b 1
)

echo   Message:
echo   --------
type COMMIT_MSG.txt
echo   --------
echo.

git add -A
git diff --cached --quiet
if not errorlevel 1 goto :nothingnew

echo   Changes:
git diff --cached --stat
echo.

git commit -F COMMIT_MSG.txt
if errorlevel 1 goto :fail

:push
echo.
echo   Pushing...
git push -u origin main
if errorlevel 1 goto :fail

echo.
echo   ===========================================================
echo   PUSHED OK
echo.
git log --oneline -1
echo.
echo   On the Lightsail box:
echo     cd /opt/bluechip/app ^&^& git pull ^&^& bash deploy/bootstrap.sh
echo   ===========================================================
echo.
pause
exit /b 0

:nothingnew
echo   Nothing new to commit.
git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>nul
if errorlevel 1 (
  echo   No upstream set. Run:  git push -u origin main
  pause
  exit /b 0
)
for /f %%c in ('git rev-list --count @{u}..HEAD') do set AHEAD=%%c
if "%AHEAD%"=="0" (
  echo   Everything is already pushed.
  echo.
  git log --oneline -3
  echo.
  pause
  exit /b 0
)
echo   But %AHEAD% commit^(s^) are unpushed. Pushing them.
goto :push

:fail
echo.
echo   FAILED. Nothing was pushed. Your work is safe locally.
echo   Send this window's text to Claude.
echo.
pause
exit /b 1
