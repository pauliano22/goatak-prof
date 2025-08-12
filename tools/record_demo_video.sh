#!/bin/bash
output_file="data/videos/webcam-recording-$(date -u +%Y-%m-%dT%H-%M-%SZ).webm"
echo "Recording 30-second demo video..."
ffmpeg -f v4l2 -video_size 1280x720 -framerate 30 -t 30 -i /dev/video0 -c:v libvpx-vp9 "$output_file"
echo "Demo video saved to $output_file"