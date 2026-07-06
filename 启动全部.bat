@echo off
cd /d "%~dp0"
echo Starting NativeSplash...
start "" "NativeSplash.exe"
echo Starting VChat Main...
start "" cmd /c npx electron .

echo Waiting for .vcp_ready...
set /a count=0
:loop
if exist ".vcp_ready" goto ready
timeout /t 1 >nul
set /a count+=1
if %count% geq 60 (
    echo Timeout waiting for .vcp_ready, proceeding...
    goto ready
)
goto loop

:ready
echo Starting VCP Desktop...
timeout /t 2 >nul
start "" cmd /c npx electron . --desktop-only
echo All services started!
