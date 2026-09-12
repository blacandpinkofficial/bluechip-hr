@echo off
REM ===========================================================================
REM  GIT-INIT.bat  -  first-time git setup for the Blue Chip HR repo.
REM  Run from C:\Users\admin\Desktop\bluechip-hr
REM
REM  Safe to run again. It picks up wherever it got to last time.
REM
REM  This repo is deliberately separate from blac-pink-retail-os. Do not add it
REM  as a submodule, do not share a remote, do not copy files between them by
REM  hand. The separation is the product.
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo   Blue Chip HR - repository setup
echo   ===============================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo   ERROR: git is not on your PATH.
  pause
  exit /b 1
)

REM Guard against running this inside the retail repo by mistake.
if exist ".\app\admin\catalogue" (
  echo   ERROR: this looks like the retail repo, not the Blue Chip folder.
  pause
  exit /b 1
)

REM --- 1. Repository -------------------------------------------------------
if exist ".git" (
  echo   [1/5] repository already initialised - continuing
) else (
  echo   [1/5] git init
  git init -b main
  if errorlevel 1 goto :fail
)

REM --- 2. Identity ---------------------------------------------------------
REM  Set LOCALLY, not globally. Your machine has no global identity set, and
REM  the retail repo carries its own - this one should too, so neither can
REM  change the other by accident.
REM
REM  Note: no "&" in the name. The retail repo's name got stored as
REM  "Ram (Blac ^& Pink)" because a .bat swallowed the escape character, and
REM  every commit there carries the caret. Not worth fixing retroactively, but
REM  not worth repeating either.
git config user.email >nul 2>nul
if errorlevel 1 (
  echo   [2/5] setting commit identity for this repo
  git config user.email "blacandpinkofficial@gmail.com"
  git config user.name "Ram"
) else (
  echo   [2/5] identity already set:
  git config user.name
  git config user.email
)

REM --- 3. Line endings -----------------------------------------------------
REM  .gitattributes must exist BEFORE the first `git add`, or the deploy
REM  scripts get normalised the wrong way and the server refuses to run them.
if not exist ".gitattributes" (
  echo   ERROR: .gitattributes is missing. Do not commit without it -
  echo          the shell scripts need to stay LF or the server cannot run them.
  pause
  exit /b 1
)
echo   [3/5] .gitattributes present - shell scripts pinned to LF

REM --- 4. Stage ------------------------------------------------------------
echo   [4/5] staging files
git add -A
if errorlevel 1 goto :fail

git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo   Nothing new to commit. The repository is already up to date.
  echo.
  git log --oneline -5
  echo.
  pause
  exit /b 0
)

REM --- 5. Commit -----------------------------------------------------------
echo   [5/5] commit
git commit -m "Phase A - Blue Chip HR scaffold: auth, roles, fee engine, deploy" -m "Separate app from Pulse: own repo, own database, own Postgres role, own domain. Nothing here imports from the retail codebase." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
if errorlevel 1 goto :fail

echo.
echo   ---------------------------------------------------------------
echo   Committed.
echo.
echo   Next: create an EMPTY private repo on GitHub named 'bluechip-hr'
echo   (no README, no .gitignore - this folder has both already), then:
echo.
echo       git remote add origin https://github.com/blacandpinkofficial/bluechip-hr.git
echo       git push -u origin main
echo.
echo   Then on the Lightsail box, as ubuntu:
echo       bash deploy/provision-bluechip.sh
echo.
echo   Watch for this line:
echo       'bluechip' is refused by 'pulse'  ^<- the wall is real
echo   If it does not appear, stop and send me the output.
echo   ---------------------------------------------------------------
echo.
pause
exit /b 0

:fail
echo.
echo   Something failed above. Nothing was pushed anywhere.
pause
exit /b 1
