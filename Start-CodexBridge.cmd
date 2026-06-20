@echo off
setlocal
cd /d "%~dp0"

set "LOG_DIR=%~dp0logs"
set "LOG=%LOG_DIR%\desktop-launch.log"

if not exist "%LOG_DIR%" (
  mkdir "%LOG_DIR%" >nul 2>&1
)

> "%LOG%" echo [%date% %time%] CodexBridge desktop launcher
>> "%LOG%" echo Root: %cd%

call :require node
if errorlevel 1 goto fail

call :require npm
if errorlevel 1 goto fail

>> "%LOG%" echo.
>> "%LOG%" echo Node location:
where node >> "%LOG%" 2>&1
>> "%LOG%" echo Node version:
node --version >> "%LOG%" 2>&1
>> "%LOG%" echo.
>> "%LOG%" echo npm location:
where npm >> "%LOG%" 2>&1
>> "%LOG%" echo npm version:
call npm --version >> "%LOG%" 2>&1

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing CodexBridge desktop dependencies...
  >> "%LOG%" echo.
  >> "%LOG%" echo Installing dependencies with npm install...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install >> "%LOG%" 2>&1
  if errorlevel 1 (
    goto fail
  )
)

if /I "%~1"=="--smoke" (
  echo Running CodexBridge desktop smoke check...
  >> "%LOG%" echo.
  >> "%LOG%" echo Running desktop smoke check...
  call npm run desktop:smoke >> "%LOG%" 2>&1
) else (
  echo Starting CodexBridge desktop...
  >> "%LOG%" echo.
  >> "%LOG%" echo Starting desktop app...
  call npm run desktop >> "%LOG%" 2>&1
)

if errorlevel 1 goto fail
exit /b 0

:require
where %1 >nul 2>&1
if errorlevel 1 (
  echo Missing required command: %1
  >> "%LOG%" echo Missing required command: %1
  exit /b 1
)
exit /b 0

:fail
set "EXITCODE=%ERRORLEVEL%"
echo.
echo CodexBridge failed to start.
echo.
echo Log file:
echo %LOG%
echo.
echo Last launch log:
echo ------------------------------------------------------------
type "%LOG%"
echo ------------------------------------------------------------
echo.
echo Please send this log when asking for help.
pause
exit /b %EXITCODE%
