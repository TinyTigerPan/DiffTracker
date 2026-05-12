@echo off
setlocal

echo === VS Code Extension VSIX Builder ===

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm not found. Install Node.js first.
    pause
    exit /b 1
)

if not exist package.json (
    echo ERROR: package.json not found. Run this from the extension root.
    pause
    exit /b 1
)

echo.
echo Installing dependencies...
call npm install
if errorlevel 1 goto fail

echo.
echo Compiling extension...
call npm run compile
if errorlevel 1 goto fail

echo.
echo Checking for vsce...
call npx --yes @vscode/vsce --version >nul 2>nul
if errorlevel 1 goto fail

echo.
echo Packaging VSIX...
call npx --yes @vscode/vsce package
if errorlevel 1 goto fail

echo.
echo Done. VSIX file should be in this folder.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED.
pause
exit /b 1