@echo off
REM This runs on Windows host but saves to WSL2 project directory
set "wsl_path=\\wsl.localhost\Ubuntu\home\paul22iac\goatak-p\goatak\data\videos"
set "output_file=%wsl_path%\webcam-recording-%date:~10,4%-%date:~4,2%-%date:~7,2%T%time:~0,2%-%time:~3,2%-%time:~6,2%Z.webm"

echo Recording 30-second demo video to WSL2 directory...
echo Output: %output_file%

REM Create directory if it doesn't exist
if not exist "%wsl_path%" mkdir "%wsl_path%"

.\ffmpeg -f dshow -video_size 1280x720 -framerate 30 -t 30 -i video="Integrated Camera" -c:v libvpx-vp9 "%output_file%"
echo Demo video saved to %output_file%
pause