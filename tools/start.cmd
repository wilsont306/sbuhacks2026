@echo off
rem One command for the kiosk: local fallback hub on port 80, then Chrome full screen on the host page.
setlocal
cd /d "%~dp0.."
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"
rem HUB_URL is where the kiosk loads the host page: the Vercel production URL, else this laptop
if not defined HUB_URL set "HUB_URL=http://localhost"
if not exist dist\host.html call npm run build || exit /b 1
set "PORT=80"
start "toy-theatre hub" cmd /k node hub.js
rem ping as a 2 s sleep: timeout fails when stdin is redirected
ping -n 3 127.0.0.1 >nul
rem own profile dir so the kiosk flags apply even if Chrome is already open
start "" chrome --kiosk --app="%HUB_URL%/host?host=%HOST_TOKEN%" --window-size=1920,1080 --window-position=0,0 --user-data-dir="%LOCALAPPDATA%\toy-theatre-kiosk" --no-first-run --autoplay-policy=no-user-gesture-required
endlocal
