#!/bin/bash
# Renders the show screens of the 17.11 tournament into out/t17/show/ (intro of each fighter with its voice line,
# everyone-against-everyone, the bracket by steps, brains matter, the tier list).
cd /c/fight-ring
O=out/t17/show; mkdir -p $O
for id in sol28 astra28 opus28 fable28 carbon28; do
  node scripts/capture-page.mjs out/t17/screens $O/.intro-$id.mp4 --query "screen=intro&id=$id" >/dev/null || exit 1
  line=$(python -c "import json,sys;v=json.load(open('leagues/t17-ring28/fighters/$id/fighter/voice.json',encoding='utf-8'));sys.stdout.buffer.write([l for l in v['lines'] if l['kind']=='intro'][0]['id'].encode())")
  ffmpeg -hide_banner -loglevel error -y -i $O/.intro-$id.mp4 -i leagues/t17-ring28/fighters/$id/fighter/voice/$line.mp3 -filter_complex "[1:a]adelay=900|900,apad[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest $O/intro-$id.mp4 && rm $O/.intro-$id.mp4
done
node scripts/capture-page.mjs out/t17/screens $O/league.mp4 --query "screen=league" >/dev/null || exit 1
for s in 1 2 3 4; do node scripts/capture-page.mjs out/t17/screens $O/bracket-$s.mp4 --query "screen=bracket&step=$s" >/dev/null || exit 1; done
node scripts/capture-page.mjs out/t17/screens $O/brains.mp4 --query "screen=brains" >/dev/null || exit 1
cp out/t17/tierlist-16x9.mp4 $O/tierlist.mp4; cp out/t17/build-16x9.mp4 $O/build.mp4
echo "screens done: $(ls $O | wc -l) files"
