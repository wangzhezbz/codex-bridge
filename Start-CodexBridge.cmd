@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing CodexBridge desktop dependencies...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install
  if errorlevel 1 (
    echo.
    echo Failed to install dependencies. Please check your network and Node.js installation.
    pause
    exit /b 1
  )
)

call npm run desktop

