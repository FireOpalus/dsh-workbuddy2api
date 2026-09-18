@echo off
rem ---------------------------------------------------------------
rem  Boot the isolated DSH test environment for dsh-workbuddy2api.
rem
rem  DSH_HOME points INSIDE this repository, so the plugin's per-account
rem  credential copies, host heartbeat, sessions, and settings all land in
rem  testenv\dsh-home\ instead of the developer's real %USERPROFILE%\.dsh.
rem  The WorkBuddy desktop sign-ins themselves are read-only inputs and are
rem  never written by the plugin.
rem
rem  The web UI listens on 127.0.0.1:63950 (see testenv\dsh-home\profiles\
rem  web\cordis.patch.yml), so it runs beside the real DSH on 63877.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0.."
set "DSH_HOME=%~dp0dsh-home"
if not exist "%DSH_HOME%\profiles\web\package.json" (
  echo  Test environment missing; materializing it first...
  node "%~dp0setup.mjs" || exit /b 1
)
echo.
echo  DSH_HOME = %DSH_HOME%
echo  Profile  = web  ^(plugin: dsh-workbuddy2api^)
echo  URL      = http://127.0.0.1:63950
echo.
call dsh web %*
