@echo off
title 해라연 위치 공유 서버

echo.
echo ========================================
echo   해라연 위치 공유 서버 시작 중...
echo ========================================
echo.

:: 서버 시작
cd /d "c:\Users\Kevin Lee\.gemini\antigravity\playground\shining-cassini\server"
start "해라연 서버" /min cmd /c "node index.js"

:: 서버가 뜰 때까지 잠시 대기
timeout /t 3 /nobreak >nul

:: Cloudflare 터널 시작
start "Cloudflare 터널" /min cmd /c "\"C:\Program Files (x86)\cloudflared\cloudflared.exe\" tunnel --url http://localhost:3000 2>&1 | findstr /C:trycloudflare"

echo.
echo ✅ 서버와 터널이 시작되었습니다!
echo    잠시 후 터널 URL이 표시됩니다.
echo.

:: 터널 URL 확인 (10초 대기 후)
timeout /t 10 /nobreak >nul
echo 외부 접속 URL 확인 중...
for /f "tokens=*" %%a in ('curl -s http://127.0.0.1:20241/metrics 2^>nul ^| findstr trycloudflare') do (
    echo %%a
)
echo.
echo 이 창을 닫아도 서버는 계속 실행됩니다.
pause
