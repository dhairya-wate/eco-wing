@echo off
rem ==============================================================================
rem   CRITICAL SECURITY ADVISORY: TUNNEL SCRIPT PERMANENTLY DISABLED
rem ==============================================================================
rem   Public reverse tunnels (e.g. localtunnel, ngrok) are permanently disabled.
rem   Exposing the Detection service or drone camera feeds to untrusted public
rem   networks bypasses perimeter network boundaries, violates safety isolation,
rem   and exposes sensor streams and operator endpoints to unauthorized access.
rem
rem   Access to Detection must occur strictly over private loopback (127.0.0.1),
rem   an authenticated reverse proxy (Nginx), or an isolated internal drone VPN.
rem ==============================================================================

echo [SECURITY BLOCKED] start_tunnel.bat is permanently disabled.
echo Public reverse tunnels are prohibited. Access must use loopback or authenticated private proxy.
exit /b 1
