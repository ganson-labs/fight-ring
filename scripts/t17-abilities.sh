#!/bin/bash
# Each fighter's specials and super against the dummy, one clip per fighter: out/t17/show/abilities-<id>.mp4
cd /c/fight-ring
for id in sol28 astra28 opus28 fable28 carbon28; do
  R=/c/ring-contest-$id
  cp kit/arena/render/abilityfx.js $R/arena/render/abilityfx.js
  moves=$(ID=$id python -c "import json,sys,os;m=json.load(open('C:/ring-contest-'+os.environ['ID']+'/fighter/moves.json',encoding='utf-8'))['moves'];sys.stdout.buffer.write(','.join(x['id'] for x in m if x['slot'] in ('special','super')).encode())")
  (cd $R && node arena/cli.mjs preview --move $moves > /dev/null 2>&1) || { echo "preview failed $id"; continue; }
  list=$R/out/preview/concat.txt; : > $list
  for mv in ${moves//,/ }; do echo "file '$mv.mp4'" >> $list; done
  (cd $R/out/preview && ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i concat.txt -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac /c/fight-ring/out/t17/show/abilities-$id.mp4) || echo "concat failed $id"
done
echo "abilities done"
