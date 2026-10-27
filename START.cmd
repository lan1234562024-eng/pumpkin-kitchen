@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Pumpkin Kitchen - Local Play

if not exist "%~dp0package.json" goto missing_game
where node >nul 2>&1
if errorlevel 1 goto missing_node
where npm >nul 2>&1
if errorlevel 1 goto missing_npm
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto old_node

pushd "%~dp0"
if errorlevel 1 goto bad_directory
echo Pumpkin Kitchen - Windows local play
echo Node version:
node --version
echo.
echo Checking local ports 5173 and 5230...
node -e "const net=require('node:net');Promise.all([5173,5230].map(port=>new Promise(resolve=>{const server=net.createServer();server.once('error',error=>{console.error('Port '+port+' is unavailable: '+error.code);resolve(false);});server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(()=>resolve(true)));}))).then(results=>process.exit(results.every(Boolean)?0:1));"
if errorlevel 1 goto ports_busy
if exist "node_modules\.package-lock.json" goto run_game

echo First run: installing the locked project dependencies with npm ci.
echo This needs internet access. No system software or service is installed.
call npm ci
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" goto install_failed

:run_game
echo.
echo Keep this window open while playing.
echo Once the server is ready, open http://127.0.0.1:5173 in your browser.
echo Local MCP endpoint: http://127.0.0.1:5230/mcp
echo Connect your AI first. Start the round yourself in the browser.
echo To stop this run, press Ctrl+C in this window.
echo.
call npm run dev
set "GAME_EXIT=%ERRORLEVEL%"
echo.
echo Game process ended. Exit code: %GAME_EXIT%
popd
pause
exit /b %GAME_EXIT%

:ports_busy
echo.
echo ERROR: Port 5173 or 5230 is unavailable. The game has not been started.
echo Check for another copy of the game or an application using those ports.
echo Close only the application you recognize, then try again.
echo This launcher does not stop existing processes or choose another port.
popd
pause
exit /b 1

:install_failed
echo.
echo ERROR: npm ci failed with exit code %INSTALL_EXIT%.
echo Read the npm error above. Check your network and try START.cmd again.
popd
pause
exit /b %INSTALL_EXIT%

:missing_game
echo ERROR: package.json is missing.
echo Extract the entire ZIP before running START.cmd.
pause
exit /b 1

:missing_node
echo ERROR: Node.js was not found.
goto node_help

:missing_npm
echo ERROR: npm was not found. Install Node.js with its bundled npm.
goto node_help

:old_node
echo ERROR: Node.js 24 or newer is required.
echo Installed version:
node --version
goto node_help

:node_help
echo Download Node.js for Windows from https://nodejs.org/en/download
echo Install Node.js 24 LTS or newer, then open START.cmd again.
echo This launcher will not install system software automatically.
pause
exit /b 1

:bad_directory
echo ERROR: Could not open the game folder.
echo Extract the ZIP to a normal writable folder and try again.
pause
exit /b 1

