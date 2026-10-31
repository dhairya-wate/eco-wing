@echo off
rem ==============================================================================
rem   DEVELOPMENT ONLY - NOT FOR PRODUCTION USE
rem ==============================================================================
rem   WARNING: Running this script opens a public localtunnel to your Detection
rem   instance on port 5000.
rem
rem   When this tunnel runs:
rem   - Read-only endpoints (/video_feed, /api/detections, /ws) become publicly
rem     accessible over the internet without authentication.
rem   - Control/write endpoints (/api/settings, /api/upload, /api/system_info)
rem     remain protected by your X-Operator-Token header.
rem
rem   To authorize running this development tunnel, explicitly set:
rem     set ALLOW_TUNNEL=1
rem ==============================================================================

if "%ALLOW_TUNNEL%" NEQ "1" (
  echo.
  echo [ERROR] Public tunnel execution blocked by default.
  echo DEVELOPMENT ONLY: Exposing port 5000 makes your camera feed and detections public.
  echo Set ALLOW_TUNNEL=1 in your terminal if you explicitly authorize opening port 5000.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting development localtunnel on port 5000...
npx localtunnel --port 5000
pause
